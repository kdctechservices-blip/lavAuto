# Essai gratuit de 14 jours — compte à rebours et restrictions

> WashPilot CI · 20 octobre 2026 · branche `arena/bddec9ba-lavauto`

Ce document décrit la règle produit retenue, son implémentation et la manière de la tester.

---

## 1. Règle produit

| Situation | Statut | Ce que ça donne |
|---|---|---|
| Forfait **Gratuit** validé à l'onboarding | `trialing` | **14 jours** d'accès complet, y compris rapports avancés et export CSV |
| Essai arrivé à échéance | `expired` | **Lecture seule** (détail ci-dessous) |
| Forfait payant en attente de validation | `pending` | Aucune restriction (le paiement est traité hors ligne) |
| Forfait payant validé | `active` | Aucune restriction, droits du forfait |
| Abonnement résilié | `cancelled` | Lecture seule, comme un essai échu |

### Ce qui se passe à l'échéance

**Bloqué** (HTTP `402` côté API, bouton désactivé + explication côté interface) :

- enregistrer un lavage, annuler un lavage ;
- créer ou modifier une dépense ;
- ouvrir une caisse, saisir un mouvement, clôturer une caisse ;
- modifier le catalogue : prestations, catégories de prestation, catégories de véhicule, sites ;
- gérer l'équipe : créer, modifier, activer ou désactiver un travailleur ;
- exporter les rapports (CSV) et accéder aux rapports avancés.

**Conservé** — le but est de ne jamais prendre les données de la station en otage :

- consultation de **tout** l'historique déjà saisi (lavages, paiements, caisse, dépenses, équipe, catalogue) ;
- tableau de bord et rapports, **tronqués aux 7 derniers jours** (la période demandée est ramenée dans la fenêtre, avec un bandeau explicite — on ne renvoie jamais d'erreur) ;
- l'onboarding et la page **Forfait et abonnement** restent entièrement accessibles, pour pouvoir sortir de la situation.

Les limites structurelles du forfait (1 site, 3 travailleurs, 10 prestations, multi-stations) ne sont **pas** levées par l'essai : elles continuent d'être appliquées comme avant.

---

## 2. Implémentation serveur

### `server/entitlements.ts` (nouveau)

| Élément | Rôle |
|---|---|
| `TRIAL_DAYS = 14`, `EXPIRED_REPORT_WINDOW_DAYS = 7`, `TRIAL_WARNING_DAYS = 3` | Les trois constantes à modifier pour changer la politique |
| `CAPABILITIES` / `CAPABILITY_LABELS` | Les 9 actions soumises à l'abonnement, avec leur libellé français |
| `computeSubscriptionState(input)` | **Fonction pure** : statut effectif, temps restant, progression, droits. C'est elle qui est testée |
| `clampReportRange(range, windowDays)` | Ramène une période de rapport dans la fenêtre autorisée |
| `loadSubscriptionState(pool, orgId)` | Lecture SQL + cache mémoire de 10 s ; **matérialise l'expiration** (`UPDATE subscriptions SET status='expired'`) |
| `attachSubscription` | Middleware : attache `req.subscription` après `requireTenantContext` |
| `blockWritesWhenReadOnly` | **Filet de sécurité global** : refuse toute méthode non `GET`/`HEAD`/`OPTIONS` en lecture seule (sauf `/subscription` et `/onboarding`) |
| `requireCapability(cap)` | Garde explicite pour une route réservée à un forfait (point d'extension) |

Le statut effectif prime sur le statut stocké : un enregistrement resté `trialing` dont la date est passée est traité comme `expired` *et* corrigé en base.

### Montage (`server.ts`)

```
/api/v1/auth → requireSession → requireTenantContext
            → attachSubscription → blockWritesWhenReadOnly
            → subscription → onboarding → api → team → reports → operations
```

### Endpoints

- `GET /api/v1/subscription` — état complet (voir le contrat ci-dessous).
- `POST /api/v1/subscription/simulate` — **développement uniquement** (non monté si `NODE_ENV=production`), rôles `owner`/`manager` : `{ "days_left": 11 | 3 | 1 | 0, "plan_code": "free" }` repositionne l'échéance pour visualiser chaque état.

Réponse de `GET /api/v1/subscription` :

```json
{
  "status": "trialing", "stored_status": "trialing",
  "plan_code": "free", "plan_name": "Gratuit", "plan_price_cents": 0,
  "is_trial": true, "is_expired": false,
  "trial_days": 14,
  "trial_started_at": "2026-10-17T13:57:55.246Z",
  "trial_ends_at": "2026-10-31T13:57:55.246Z",
  "ms_remaining": 950392334, "days_remaining": 11, "progress": 0.21,
  "read_only": false, "report_window_days": null,
  "capabilities": { "washes.create": true, "reports.export": true, "sites.multiple": false },
  "restricted": ["sites.multiple"],
  "server_time": "2026-10-20T13:58:02.912Z",
  "warning_days": 3,
  "capability_labels": { "washes.create": "Enregistrer un lavage" }
}
```

Erreur renvoyée par une écriture refusée (format d'erreur habituel du projet) :

```json
{ "error": { "code": "trial_expired",
  "message": "Votre essai gratuit de 14 jours est terminé. Votre espace reste consultable, mais les nouveaux enregistrements nécessitent un forfait." } }
```

`402 Payment Required` est utilisé volontairement : ni `401` (la session est valide) ni `403` (ce n'est pas une question de rôle).

### Rapports (`server/reports.ts`)

`GET /reports/summary` tronque la période via `clampReportRange` et ajoute un objet `restriction` (`reason`, `requested_from`, `window_days`, `message`) quand elle a été réduite. Les 6 requêtes d'agrégation restent inchangées.

---

## 3. Implémentation interface

| Fichier | Contenu |
|---|---|
| `src/lib/subscription.tsx` | `SubscriptionProvider` (une seule requête partagée, décompte local à la seconde, resynchronisation au retour sur l'onglet et toutes les 5 min), `useSubscription()`, `useCapability(cap)`, `formatRemaining()` |
| `src/components/trial/trial-countdown.tsx` | Carte en pied de barre latérale : jours / heures / minutes / secondes, barre de progression, bascule ambre à 3 jours, rouge une fois terminé |
| `src/components/trial/trial-banner.tsx` | Bandeau en haut de page : rappel masquable à ≤ 3 jours, message permanent en lecture seule |
| `src/components/trial/trial-status-card.tsx` | Page **Forfait** : décompte détaillé, dates de début et de fin, « inclus pendant l'essai » vs « désactivé à l'échéance » |
| `src/components/trial/trial-simulator.tsx` | Panneau de démonstration, affiché uniquement en développement (`import.meta.env.DEV`) |

Le décompte est calé sur `ms_remaining` renvoyé par le serveur (et non sur l'horloge du téléphone), et le passage à zéro déclenche une resynchronisation : l'interface bascule en lecture seule sans rechargement.

Boutons protégés (désactivés + infobulle expliquant la raison) : *Nouveau lavage* et le bouton d'enregistrement du formulaire, *Annuler le lavage*, *Nouvelle dépense*, *Nouvelle session* / *Entrée* / *Sortie* / *Clôturer* en caisse, *Nouveau travailleur* et les actions de ligne de l'équipe, les créations et modifications du catalogue, *Exporter CSV* sur les rapports.

Conformément aux contraintes d'animation du projet : aucune nouvelle dépendance, seules `transform` et `opacity` sont animées, aucun montant n'est animé pendant la saisie.

---

## 4. Données de démonstration

Le compte de démonstration (`demo@washpilot.ci` / `WashPilot2026!`) est désormais semé sur le **forfait Gratuit en cours d'essai, à 11 jours de l'échéance** (`server/db.ts`), afin que le compte à rebours soit visible dès la première connexion. La station de démonstration tient dans les quotas du forfait Gratuit (1 site, 5 prestations, 1 utilisateur) ; elle est à 3/3 travailleurs, ce que la page Équipe signale déjà par son bandeau de quota.

---

## 5. Tests et vérifications

`tests/entitlements.test.ts` — 15 tests (`node:test`) sur la logique pure : durée de 14 jours, progression à mi-parcours, déblocage des rapports avancés pendant l'essai, bascule en lecture seule à l'échéance exacte, non-restriction des forfaits `active`/`pending`, résiliation, absence d'abonnement, troncature des périodes de rapport.

Vérifications exécutées :

```
./node_modules/.bin/tsc -b      # 0 erreur
npm test                        # 50/50 (35 existants + 15 nouveaux)
npm run build                   # OK
npm run lint                    # 0 erreur (l'erreur préexistante app-sidebar.tsx:119 a disparu)
```

Parcours vérifié sur l'API réelle (PGlite) :

| Appel | Avant échéance | Après échéance |
|---|---|---|
| `GET /subscription` | `trialing`, 11 j | `expired`, `read_only: true` |
| `POST /washes`, `/expenses`, `/cash-sessions`, `/services`, `/workers`, `PATCH /services/:id` | 400 (validation) | **402 `trial_expired`** |
| `GET /washes` | 200 | 200 |
| `GET /reports/summary?from=2026-07-01` | période respectée | ramenée au `2026-10-14` + `restriction` |

---

## 6. Comment ajuster la politique

- **Durée de l'essai** : `TRIAL_DAYS` dans `server/entitlements.ts` (la date de fin est posée à l'onboarding, donc la nouvelle durée s'applique aux nouvelles organisations).
- **Profondeur d'historique après échéance** : `EXPIRED_REPORT_WINDOW_DAYS`.
- **Seuil d'alerte** : `TRIAL_WARNING_DAYS`.
- **Rendre une action payante** : ajouter la clé à `CAPABILITIES` + `CAPABILITY_LABELS`, puis `requireCapability("…")` sur la route et `useCapability("…")` sur le bouton.
