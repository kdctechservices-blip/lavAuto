# Audit du dépôt au regard du Master Prompt — WashPilot CI

> Audit du 21 octobre 2026, sur l'état du dépôt au commit `7875513`.
> **Aucun fichier source n'a été modifié pour produire ce document.**
>
> Méthode : les constats ci-dessous sont tirés du code et, quand c'est
> possible, d'appels réels au serveur en marche. Chaque affirmation portant
> sur un comportement a été vérifiée, pas déduite.

---

## 0. Avertissement liminaire — quatre hypothèses du Master Prompt sont fausses

Le Master Prompt §11 décrit une pile technique qui **n'est pas celle de ce
dépôt**. Il demande aussi, à juste titre, de « respecter la stack réellement
présente » et de « ne remplacer aucune technologie sans justification ». Ces
deux consignes sont contradictoires tant que le malentendu n'est pas levé.

| Le Master Prompt suppose | Réalité vérifiée | Conséquence |
|---|---|---|
| **Clerk** pour l'authentification | Absent. Authentification maison : `auth_sessions`, jeton `Bearer`, `password_reset_tokens` | Ne pas « réutiliser Clerk » : il n'y a rien à réutiliser |
| **Prisma** comme ORM | Absent. SQL écrit à la main sur `pg.Pool` | Pas de `schema.prisma` à inspecter ; les migrations sont du DDL idempotent dans `server/db.ts` |
| **Next.js** | Absent. **Vite + React Router 7** | `src/app/*/page.tsx` ressemble à Next mais n'en est pas ; pas de rendu serveur, pas de route handlers |
| **PostgreSQL via Neon** | **PGlite** embarqué, `new PGlite()` **sans `dataDir`** | La base est **en mémoire** : tout disparaît au redémarrage. Acceptable en démonstration, bloquant en production |

Un vestige à signaler : la table **`clerk_webhook_events`** existe toujours
alors que Clerk n'est plus utilisé nulle part. C'est une trace morte qui
induira en erreur le prochain lecteur.

**Recommandation** : ne pas migrer vers Clerk/Prisma/Next.js. Ces
remplacements coûteraient plusieurs semaines pour un gain nul sur les
questions du §17. La vraie dette d'infrastructure est ailleurs : **la base en
mémoire**.

---

## 1. Ce qui est solide

Pour situer le reste honnêtement. Ces points ont été vérifiés, pas supposés.

- **120 routes** sur 18 modules serveur, **28 fichiers de tests**, **422 tests** verts.
- **Isolation multi-station** : testée (2 fichiers dédiés, `tenant` dans 8).
- **RBAC à trois niveaux** (interface, serveur, base), refus par défaut,
  matrice figée par test. Vérifié en réel : un agent de lavage reçoit **403**
  sur `/reports/summary`, `/payments`, `/cash-sessions`, `/workers`.
- **§7 étape 3 respectée** — et c'est le point le plus important pour
  l'intégrité financière : le serveur **recalcule le total** via
  `resolvePrice(service, vehicle_category_id)` depuis la base. Le montant
  envoyé par le navigateur n'est **jamais** cru. `amount_exceeds_total` rejette
  les incohérences.
- **§11 respectée** — `wash_items` conserve un instantané : `service_name` et
  `unit_price_cents` sont figés à l'enregistrement. Changer un tarif ne
  réécrit pas l'histoire.
- **§3.3 respectée** — `withIdempotency` sur 4 modules ; vérifié en réel :
  même clé envoyée deux fois sur un mouvement de caisse → 201 deux fois,
  **un seul mouvement créé**.
- **§3.4 respectée** — `audit_logs`, annulation tracée plutôt que suppression.
- Reçu de caisse 80 mm, surveillance technique, back-office isolé, assistance,
  revenus : livrés et testés.

---

## 2. Constat critique n° 1 — le lavage naît terminé

> **Arbitré le 21/10/2026 — voir §9, décision 1.** WashPilot est assumé comme
> une caisse enregistreuse : ce constat n'est plus un écart à combler. Seul le
> faux indicateur qu'il entraînait a été corrigé (§14).

C'est le défaut le plus grave de l'audit, et il touche le cœur même du produit.

```sql
-- server/db.ts, table washes
status text NOT NULL DEFAULT 'completed'
```

```sql
-- server/api.ts:565, création d'un lavage
INSERT INTO washes(..., status, ...) VALUES($1,$2,$3,'completed',...)
```

**Un lavage est créé avec le statut « terminé », en dur.**

Recherche exhaustive des écritures de statut dans tout `server/` :

| Écriture | Où | Valeur |
|---|---|---|
| `UPDATE washes SET status='cancelled'` | `api.ts:655` | annulation |
| *(aucune autre)* | — | — |

**`'in_progress'` n'est jamais écrit. Nulle part.** Il n'est que *lu*, à un
seul endroit :

```sql
-- server/reports.ts:93
SELECT COUNT(*) FROM washes WHERE organization_id=$1 AND status = 'in_progress'
```

Et cette valeur alimente l'interface :

- `src/components/dashboard-metrics.tsx:219` — une carte « En cours » avec un
  compteur animé ;
- `:129` — une part du graphique circulaire.

### Ce que cela signifie concrètement

**Le tableau de bord affiche un indicateur qui ne peut structurellement jamais
être différent de zéro.** Vérifié en base de démonstration : `{'completed': 2}`
— aucun autre statut n'existe.

Ce n'est pas un bug d'affichage, c'est l'absence d'un pan entier du métier.
Il manque :

- les étapes 4, 5 et 8 du workflow §7 (affectation → exécution → finalisation) ;
- la transition `EN_ATTENTE → EN_COURS → TERMINE` exigée au §7 étape 5 ;
- la réponse à la question §17 « combien de lavages sont en cours ? ».

### Pourquoi c'est arrivé

Le produit a été construit comme une **caisse enregistreuse** : on saisit un
lavage *après coup*, une fois l'argent encaissé. Le Master Prompt décrit un
**suivi d'atelier** : le véhicule arrive, on l'enregistre, on l'affecte, l'agent
démarre, l'agent termine. Ce sont deux produits différents, et le second n'est
pas construit.

**Décision à prendre avant toute implémentation** (voir §9, question 1).

---

## 3. Constat critique n° 2 — le rôle « agent de lavage » est une coquille vide

> **Arbitré le 21/10/2026 — voir §9, décision 1.** L'écran « Mes lavages » est
> abandonné. Seule subsiste la question de confidentialité (écart C4).

Le rôle `washer` existe dans la matrice RBAC avec 2 permissions
(`service:read`, `wash:read`). Mais :

| Exigence §4.3 / §5 | État |
|---|---|
| Écran « Mes lavages » | **N'existe pas.** Aucune occurrence dans `src/` |
| Voir **les lavages qui lui sont affectés** | **Non.** Vérifié en réel : `GET /washes` avec un jeton de laveur renvoie **les 2 lavages de toute la station**, pas les siens |
| Signaler le début du lavage | **Impossible** — aucune route |
| Signaler la fin du lavage | **Impossible** — aucune route |
| Navigation dédiée | **Aucune.** Il voit « Nouveau lavage » et « Catalogue », rien d'autre |

### Le verrou structurel

```
workers (registre RH)     users (comptes de connexion)
  id, first_name,           id, email, password_hash
  last_name, status         ↕ organization_members.role = 'washer'
  ✗ PAS de user_id
```

`wash_assignments` pointe sur `worker_id`. Un utilisateur connecté en rôle
`washer` n'a **aucun moyen** de savoir quelles affectations sont les siennes :
il n'existe aucun lien entre sa fiche RH et son compte.

Le Master Prompt §12 a raison d'exiger qu'« un travailleur puisse exister sans
compte » — c'est respecté. Mais il faut **le lien optionnel inverse** :
`workers.user_id NULL` pour ceux qui se connectent.

---

## 4. Constat critique n° 3 — tout le domaine « stock » est absent

> **Partiellement refermé le 21/10/2026 — voir §14.** Les produits, les
> catégories et les mouvements existent désormais (lot L3). Restent absents :
> les consommables par prestation (L4), les fournisseurs et les achats (L5),
> le coût direct et la marge (L6).

Les écrans 13 (Stocks) et 14 (Fournisseurs et achats), les phases 4 et une
partie de la 5 : **rien n'existe**.

Tables du Master Prompt §10 manquantes :

| Table | État |
|---|---|
| `products` | ✗ |
| `product_categories` | ✗ |
| `stock_movements` | ✗ |
| `suppliers` | ✗ |
| `purchases` | ✗ |
| `purchase_items` | ✗ |
| `service_consumables` | ✗ |
| `vehicles` | ✗ |

Tests : **0 fichier** mentionnant `supplier`, `purchase` ou `margin`.

En cascade, sont donc impossibles aujourd'hui :

- le coût direct estimé d'une prestation (§9) ;
- la marge estimée (§9, §16, §17) ;
- la consommation de produits (§7 étape 6) ;
- les alertes de stock faible (§5, §13) ;
- l'inventaire physique et les écarts (§8 étape 6).

Sur les 10 questions du §17 (critère final de réussite), **3 sont aujourd'hui
sans réponse possible** : produits consommés/à réapprovisionner, coût direct
par prestation, marge estimée.

---

## 5. Cartographie fonctionnelle

Lecture : ✅ conforme · ⚠️ partiel · ❌ absent

| # | Écran du Master Prompt | Fichier | Rôle | Routes | État |
|---|---|---|---|---|---|
| 1 | Landing page | `app/landing` | public | — | ✅ |
| 2 | Inscription | `app/auth/sign-up` | public | `auth-router` | ✅ |
| 3 | Connexion | `app/auth/sign-in` | public | `auth-router` (9) | ✅ |
| 4 | Onboarding | `app/onboarding` | owner | `onboarding` (7) | ⚠️ pas d'étape stock |
| 5 | Tableau de bord | `pages/dashboard` | owner/manager | `reports` | ⚠️ KPI « en cours » toujours 0 ; pas de marge |
| 6 | Lavages | `app/washes` | owner/manager/cashier | `api` | ⚠️ pas de filtre statut réel, pas d'immatriculation |
| 7 | Nouveau lavage | `app/washes` (modale) | idem | `api` | ⚠️ pas de remise, pas de véhicule |
| 8 | Détail d'un lavage | `app/washes/[washID]` | idem | `api`, `payments` | ⚠️ pas de chronologie, pas de consommations |
| 9 | Encaissements | `app/payments` | owner/manager/cashier | `payments` (6) | ✅ |
| 10 | Caisse | `app/cash-drawer` | selon permission | `operations` (11) | ✅ |
| 11 | Catalogue | `app/services`, `service-categories` | owner/manager | `api` | ⚠️ pas de consommables ni coût direct |
| 12 | Équipe | `app/team` | owner/manager | `team` (6) | ⚠️ pas de lien compte↔fiche |
| 13 | **Stocks** | — | — | — | **❌ absent** |
| 14 | **Fournisseurs et achats** | — | — | — | **❌ absent** |
| 15 | Dépenses | `app/expenses` | owner/manager | `api` | ✅ |
| 16 | Rapports | `app/reports` | owner | `reports` (2) | ⚠️ pas de coûts ni marges |
| 17 | Membres et permissions | `app/settings/access` | owner | `access` (5) | ✅ |
| 18 | Paramètres | `app/settings/*`, `app/sites` | owner | `admin` (21) | ✅ |
| 19 | Abonnement | `app/settings/billing` | owner | `subscription`, `checkout` | ✅ |
| — | **Mes lavages (agent)** | — | washer | — | **❌ absent** |

Hors Master Prompt, déjà livrés : `app/support`, `app/history`,
`app/settings/data`, 12 pages de console plateforme.

---

## 6. Matrice des rôles — état réel

Figée par test (`EXPECTED_MATRIX`), 28 permissions.

| Rôle | Permissions | Conformité §4 |
|---|---|---|
| `owner` | 28 | ✅ |
| `manager` | 18 | ✅ conforme au §4.2, y compris les interdictions |
| `cashier` | 12 | *(rôle hors Master Prompt, cohérent)* |
| `washer` | 2 | ⚠️ conforme sur le **refus**, vide sur la **capacité** |
| `platform_admin` | console isolée | ✅ §4.4 — pas d'usurpation, accès journalisé |

Délégables par exception : `wash:cancel`, `expense:manage`, `service:manage`,
`worker:delete`, `report:export`, `data:export`.

**Manquantes** pour le Master Prompt : `wash:start`, `wash:finish`,
`stock:read`, `stock:move`, `purchase:manage`, `supplier:manage`.

---

## 7. Transitions de statut — cible proposée

> **Caduc depuis le 21/10/2026 — voir §9, décision 1.** La cible décrite
> ci-dessous ne sera pas implémentée. Conservée pour mémoire du raisonnement.

État actuel :

```
   [création] ──────────────► completed ──► cancelled
                (en dur)                   (seule transition existante)
```

Cible §7 étape 5 :

```
   [création] ──► pending ──► in_progress ──► completed
                     │             │              │
                     └─────────────┴──────────────┴──► cancelled
                                                        (motif obligatoire)
```

Règles à poser : `completed` ne peut pas revenir en arrière ; `cancelled`
exige un motif (déjà le cas) ; l'agent ne peut déclencher que
`pending→in_progress` et `in_progress→completed`, et **uniquement sur ses
propres affectations**.

Statut de paiement (`pending`/`partial`/`paid`/`refunded`) : **déjà
indépendant** du statut du lavage. Le §7 étape 7 est respecté sur ce point.

---

## 8. Écarts classés par gravité

### Critique — intégrité métier et promesse produit

| # | Écart | Preuve |
|---|---|---|
| C1 | Le lavage naît `completed` ; aucun cycle de vie | `db.ts` DEFAULT + `api.ts:565` en dur |
| C2 | KPI « lavages en cours » structurellement à zéro | `in_progress` lu, jamais écrit |
| C3 | Rôle `washer` sans écran ni action | aucun « Mes lavages » dans `src/` |
| C4 | Un laveur voit **tous** les lavages de la station | vérifié : `GET /washes` → 2/2 |
| C5 | **Base en mémoire** : tout est perdu au redémarrage | `new PGlite()` sans `dataDir` |

### Élevé — modules absents du périmètre annoncé

| # | Écart |
|---|---|
| E1 | Domaine stock entier absent (8 tables, 2 écrans) |
| E2 | Fournisseurs et achats absents |
| E3 | Coût direct et marge impossibles à calculer |
| E4 | Pas de lien `workers.user_id` |

### Moyen — fonctionnalités secondaires

| # | Écart |
|---|---|
| M1 | Pas de remise autorisée (§7 étape 2) |
| M2 | Pas d'immatriculation ni de table `vehicles` |
| M3 | Pas de chronologie sur le détail d'un lavage |
| M4 | Onboarding sans étape stock |
| M5 | Messages d'erreur zod bruts en anglais (« Too small: expected number to be >=0 ») |

### Faible

| # | Écart |
|---|---|
| F1 | Table morte `clerk_webhook_events` |
| F2 | 7 fichiers encore non migrés sur la brique d'écriture |
| F3 | 21 avertissements de lint (`react-refresh`) |

---

## 9. Décisions prises — 21 octobre 2026

Les trois questions d'architecture ont été tranchées par le propriétaire du
produit. Elles sont désormais **fermées** et engagent la suite.

### Décision 1 — WashPilot est une **caisse enregistreuse**, pas un suivi d'atelier

Un lavage est saisi **une fois rendu**. Il n'y a donc volontairement pas de
cycle `EN_ATTENTE → EN_COURS → TERMINE`.

Conséquences, toutes assumées :

- Le §7 étapes 4, 5 et 8 du Master Prompt **ne sera pas implémenté**.
- Les lots **L1 (cycle de vie)** et **L2 (écran agent)** sont **abandonnés**,
  pas reportés.
- L'écran « Mes lavages » de l'agent n'a plus d'objet : sans démarrage ni fin
  à signaler, il n'aurait rien à afficher.
- Les écarts **C1, C2, C3** ne sont plus des écarts : ils décrivaient un
  manque par rapport à un produit que nous ne construisons pas.
- **En revanche C2 devenait un mensonge** : le tableau de bord affichait une
  carte « En cours » qui ne pouvait structurellement afficher que zéro.
  **Corrigé** (voir §14).
- L'écart **C4** (un laveur voit tous les lavages) reste ouvert mais change de
  nature : ce n'est plus un défaut fonctionnel, c'est une question de
  confidentialité à arbitrer plus tard.

### Décision 2 — Le stock est déduit **à la fin du lavage**

Retenu pour la raison attendue : un lavage annulé ne doit rien avoir consommé.

**Précision importante dans le modèle « caisse enregistreuse »** : puisque le
lavage est enregistré une fois rendu, « la fin du lavage » et « la saisie du
lavage » sont **le même instant**. La déduction du stock se fera donc dans la
transaction de création du lavage, et sera annulée par un mouvement inverse en
cas d'annulation. C'est plus simple que prévu et cela supprime la dépendance
du lot L4 envers un cycle de vie qui n'existera pas.

### Décision 3 — La base volatile devait être corrigée en premier

**Fait.** Voir §14.

---

### Décision 4 — Les consommables ne touchent pas au prix

Dicté par l'utilisateur le 21 octobre 2026, en correction d'un cadrage erroné
de ma part qui parlait de « coût direct » et de « marge » :

> « le prix d'un service de lavage est déjà défini. il suffira de le
> sélectionner et valider. » — « cela n'influence en aucun cas le prix de
> service, mais plutôt le niveau de stock des consommables utilisés. »

Déclarer qu'un lavage consomme deux sachets d'Omo ne change donc **rien** au
montant facturé. Le prix reste celui saisi dans la fiche de prestation. Les
consommables n'agissent que sur le niveau de stock. **Il n'y a ni coût direct
ni marge dans L4.**

Trois conséquences :

1. **L'unité de comptage est le sachet**, pas le litre abstrait : « ici en
   côte d'ivoire on utilise des sachets d'omo ». `sachet` est proposée en
   premier dans la liste des unités.
2. **Une quantité par produit et par prestation**, sans variation par
   catégorie de véhicule. Le besoin n'existe pas aujourd'hui.
3. **La déduction automatique n'est jamais refusée.** Un stock à zéro
   n'empêche pas d'encaisser un client : le lavage s'enregistre, le stock
   passe en négatif, s'affiche en rouge et appelle un inventaire. C'est la
   différence assumée avec une **sortie manuelle**, qui reste bloquée en
   `insufficient_stock` — son auteur, lui, peut corriger sa saisie sur-le-champ.

---

## 10. Plan d'implémentation par lots

Chaque lot est indépendant, livrable et testable séparément.

Plan révisé après les décisions du §9.

| Lot | Contenu | Dépend de | Risque | État |
|---|---|---|---|---|
| **L0** | **Persistance** : `dataDir` PGlite, garde-fou des tests, journal explicite | — | Moyen | ✅ **Fait** (§14) |
| ~~L1~~ | ~~Cycle de vie du lavage~~ | — | — | ❌ **Abandonné** (décision 1) |
| ~~L2~~ | ~~Écran agent de lavage~~ | — | — | ❌ **Abandonné** (décision 1) |
| **L3** | **Produits et mouvements** : `products`, `product_categories`, `stock_movements`, écran Stocks, seuils d'alerte | L0 | Élevé | ✅ **Fait** (§14) |
| **L4** | **Consommables par prestation** : `service_consumables`, déduction dans la transaction de saisie du lavage, contrepassation à l'annulation. **Aucun effet sur le prix** (décision 4) | L3 | Élevé | **Fait** |
| **L5** | **Fournisseurs et achats** : `suppliers`, `purchases`, `purchase_items`, réception partielle, non-double-comptage avec les dépenses | L3 | Élevé | À faire |
| **L6** | **Marges et rapports** : coûts directs, marge estimée, distinction CA / encaissements | L4 | Moyen | À faire |
| **L7** | **Confort** : remise autorisée, immatriculation, messages zod en français | — | Faible | À faire |

**Ordre : L0 ✅ → L3 ✅ → L4 → L5 → L6 → L7.**

L'abandon de L1 et L2 raccourcit sensiblement le chemin vers le stock, qui
devient le prochain chantier. L4 ne dépend plus que de L3.

---

## 11. Tests d'acceptation proposés

Par lot, le test qui prouve que c'est fait :

- **L0** — redémarrer le serveur, les lavages de la veille sont toujours là. ✅
- **L3** — le stock affiché égale la somme des mouvements ; aucune écriture
  directe de quantité n'est possible.
- **L4** — un lavage annulé produit un mouvement de stock inverse ; rejouer la
  requête de saisie avec la même clé d'idempotence ne déduit pas deux fois.
- **L5** — une commande non reçue n'augmente pas le stock ; un achat payé
  n'apparaît pas deux fois dans les charges.
- **L6** — chiffre d'affaires, encaissements et marge sont trois nombres
  distincts et aucun n'est présenté comme un bénéfice.

Conventions en vigueur à respecter : `node:test` + `assert/strict`,
`createApiApp()`, test de mutation systématique après écriture des tests.

---

## 12. Plan de mise en production

1. **L0 obligatoire.** Base persistante, sauvegarde testée par restauration réelle.
2. Variables d'environnement : `PLATFORM_ADMIN_PASSWORD`, secrets de session —
   aucune valeur par défaut en production.
3. Supprimer les comptes de démonstration (`demo@`, `gerant@`, `caisse@`,
   `laveur@washpilot.ci`) ou les isoler derrière un drapeau explicite.
4. Nettoyer la table morte `clerk_webhook_events`.
5. Vérifier que la surveillance (`request_metrics`, `error_events`) tourne et
   que la console y donne accès.
6. Tenir la promesse tarifaire : `TARIFS.md` §6 liste ce qui est annoncé mais
   non livré — à relire avant toute vente.

---

## 13. Prochain chantier

**L5 — fournisseurs et achats.** Les entrées de stock se saisissent
aujourd'hui à la main, sans pièce justificative en face. L5 rattache une
entrée à un achat et un achat à un fournisseur. Attention au piège déjà
identifié : **seules les quantités reçues augmentent le stock**, et un achat
ne doit pas être compté deux fois, une fois comme achat et une fois comme
dépense.

Deux points mineurs restent ouverts, sans urgence :

- **Écart C4** — un agent de lavage voit tous les lavages de la station.
  Question de confidentialité, plus de fonctionnalité.
- **Écart M5** — les messages de validation remontent en anglais brut.

---

## 14. Journal des corrections

### 21 octobre 2026 — L0, persistance de la base *(écart C5)*

**Avant** : `new PGlite()` sans `dataDir`. Le serveur démarrait normalement et
perdait l'intégralité des lavages, encaissements et sessions de caisse à
chaque arrêt, **sans le moindre avertissement**.

**Après** :

- `server/pglite-location.ts` — fonction pure décidant de l'emplacement,
  testable sans démarrer PostgreSQL (même esprit que `action-blocking.ts`).
- Défaut : `.data/pglite`, sur disque. `PGLITE_DATA_DIR` permet de changer de
  chemin ; `:memory:` demande explicitement une base volatile.
- **`NODE_ENV=test` force la mémoire et n'est pas surchargeable** : deux
  fichiers de tests partageant un dossier se contamineraient. Vérifié avec une
  variable hostile — le dossier n'est jamais créé.
- Une base volatile hors test se signale par `ATTENTION` dans les journaux.
- `mkdir recursive` avant ouverture : PGlite ne crée pas les chemins
  imbriqués et échouait en `ENOENT` au premier démarrage.
- `.data/` ajouté au `.gitignore` (41 Mo).
- `NEON_DATABASE_URL`, configuration morte, retirée de `.env.example`.

**Preuve, pas seulement compilation** : lavage `LAV-20261021-D22BD0`
(12 000 FCFA) créé, serveur arrêté puis relancé, lavage retrouvé intact.
12 tests ajoutés (434 au total), 3 mutations du cœur pur toutes détectées.

### 21 octobre 2026 — Indicateur « En cours » *(écart C2)*

Conséquence directe de la décision 1. La carte du tableau de bord alimentée
par `in_progress_washes` ne pouvait afficher que zéro.

- Requête SQL morte et champ de réponse supprimés de `server/reports.ts`,
  avec une note expliquant pourquoi il ne faut pas les réintroduire.
- Part « En cours » retirée du camembert.
- Carte remplacée par **« À confirmer »**, alimentée par
  `pending_payments_cents` / `pending_payments_count` — déjà calculés par le
  serveur mais jamais affichés. C'est l'argent annoncé en mobile money et pas
  encore vérifié : une information qui, elle, mérite l'attention du gérant.

**Preuve** : un lavage réglé en Orange Money fait passer la carte à
12 000 FCFA sur 1 encaissement. Ce n'est pas un nouveau zéro permanent.

### 21 octobre 2026 — L3, le stock *(écart E1, partiel)*

**Modèle.** Trois tables : `product_categories`, `products`,
`stock_movements`. Une règle les gouverne : **il n'existe nulle part une
colonne « quantité en stock »**. Le stock d'un produit est toujours la somme
signée de ses mouvements. Aucune écriture directe n'est donc possible, ni par
l'API, ni par une requête manuelle distraite. Un test lit
`information_schema` pour vérifier qu'aucune colonne de quantité n'apparaît
sur `products`.

**Un mouvement ne se modifie ni ne s'efface.** On le contrepasse par un
mouvement inverse qui le référence (`reverses_movement_id`, unique). Même le
propriétaire ne peut pas réécrire le passé. C'est plus fort qu'une
permission, parce que c'est structurel.

**Instantané du coût.** Chaque mouvement fige `unit_cost_cents` au moment où
il est écrit, exactement comme `wash_items` fige le prix d'une prestation.
Augmenter le prix d'un bidon demain ne change pas la valeur des sorties
d'hier — vérifié par test.

**Quantités en millièmes d'unité.** Même raison que les centimes pour
l'argent : un entier exact plutôt qu'un flottant qui dérive. 0,15 L se note
150, sans arrondi.

**L'inventaire enregistre l'écart, pas le stock compté.** On ne « fixe » pas
une quantité : on écrit la différence constatée, qui reste lisible dans
l'historique. Un comptage conforme n'écrit rien plutôt qu'un mouvement nul.
C'est aussi la seule issue prévue quand une sortie est refusée pour stock
insuffisant.

**Permissions.** `stock:read`, `stock:manage`, `stock:move` — accordées au
gérant, refusées par défaut au caissier et à l'agent. Décision argumentée
dans `RBAC-PERMISSIONS.md` §11, consignée avant d'être codée.

**Une régression évitée de justesse.** Le garde-fou de
`tests/console-deletion.test.ts` a détecté que les trois nouvelles tables
manquaient dans `PURGE_ORDER` : supprimer une organisation aurait laissé son
stock orphelin. Corrigé, et un **garde-fou jumeau a été ajouté sur l'export
de données**, qui souffrait du même angle mort sans que rien ne le signale.

**Vérifié en réel**, pas seulement en test : produit à 20 L, sortie de 2,5 L,
sortie de 100 L refusée en `insufficient_stock`, inventaire à 16 L
enregistrant un écart de −1,5 L, puis concordance exacte entre le stock
affiché et la somme des trois mouvements. Alerte de seuil déclenchée en
passant sous 5 L. Laveur et caissier en 403.

58 tests ajoutés (493 au total), 6 mutations injectées et toutes détectées.

### 21 octobre 2026 — L4, consommables par prestation *(écart E1, suite)*

**Avant** : rien ne reliait une prestation aux produits qu'elle consomme. Le
stock existait depuis L3, mais il fallait saisir chaque sortie à la main,
lavage après lavage. En pratique, personne ne le fait.

**Après** : chaque fiche de prestation porte la liste de ce qu'elle sort du
stock. Un lavage enregistré déduit automatiquement, dans la même transaction.

| Règle | Mise en œuvre |
| --- | --- |
| Le prix ne bouge pas | Aucune lecture de `service_consumables` dans le calcul du total. Vérifié par deux tests dédiés |
| Comptage en sachets | `sachet` ajoutée aux unités, proposée en premier |
| Déduction à la fin | `consumeForWash` appelée dans la transaction de `POST /washes`, après l'insertion des lignes |
| Jamais bloquante | Aucun contrôle de disponibilité : le stock peut passer en négatif |
| Un seul mouvement par produit | Les quantités sont cumulées avant écriture, même si deux prestations du lavage partagent un produit |
| Annulation | `reverseWashConsumption` contrepasse, sans effacer le mouvement d'origine |
| Traçabilité | `stock_movements.wash_id` relie chaque consommation à son lavage |

**Le stock négatif est un signal, pas une erreur.** Il dit qu'on a consommé
plus que ce qui était déclaré. L'écran Stock l'affiche en rouge, avec une
pastille « À inventorier » et un bandeau qui nomme les produits concernés.
Seul un inventaire le referme.

**Permissions.** Déclarer une recette relève du catalogue (`service:manage`),
pas du stock : c'est une propriété de la prestation. Un caissier sans aucun
droit sur le stock déclenche malgré tout la déduction en enregistrant un
lavage — c'est le système qui mouvemente, pas lui. Les deux cas sont testés.

**Vérifié en conditions réelles** : 10 sachets en stock, prestation à 3 000 F
consommant 2 sachets. Quatre lavages → facturé 12 000 F, stock à 2. Trois de
plus → stock à **−4**, lavage accepté. Au même instant, une sortie manuelle de
5 sachets est refusée en `insufficient_stock` : le contraste est volontaire.
Annulation des quatre premiers → stock à 4. Caissier : 403 sur `GET /products`,
lavage accepté, stock à 2.

**Ce qu'un garde-fou a rattrapé.** Les deux tests qui comparent
`information_schema` à `PURGE_ORDER` et à `EXPORT_QUERIES` ont échoué dès la
création de `service_consumables`, avant que j'y pense. Le second de ces
garde-fous avait été écrit la veille, pendant L3 ; il a servi le lendemain.

**Ce qu'une mutation a révélé.** Retirer la garde anti-double-contrepassation
de `reverseWashConsumption` ne faisait échouer aucun test : la route
d'annulation refuse déjà un lavage annulé (`wash_already_cancelled`) et le
code n'était jamais atteint. Le test visait donc une défense en croyant en
viser une autre. Un test appelant `reverseWashConsumption` deux fois de suite,
hors route, a été ajouté ; la mutation est désormais détectée.

**Tests** : 20 nouveaux (`tests/service-consumables.test.ts`), suite à
**513/513**. `tsc -b` 0, build ✓, lint 0 erreur / 21 warnings.

### 21 octobre 2026 — Le stock bascule en forfait Pro

**Décision commerciale**, prise après la livraison de L4 : le suivi du stock
n'est plus ouvert à tous les forfaits. Il rejoint Pro, aux côtés de la
traçabilité et des rapports détaillés. La grille publique l'annonce
désormais ; elle ne le mentionnait nulle part auparavant.

| | |
| --- | --- |
| Capacité | `stock.manage`, libellé « Suivi du stock de consommables » |
| Forfaits | Starter non · Pro oui · Business oui |
| Point de blocage | `requireCapability` sur les **11** routes de stock |
| Écran | `PlanGate` sur `/stock`, argumentaire et lien vers les forfaits |
| Catalogue | le bouton « consommables » disparaît des fiches de prestation |

**Le piège de conception, et comment il a été vu.** J'avais d'abord créé deux
capacités, `stock.read` et `stock.manage`, en inscrivant la seconde dans
`WRITE_CAPABILITIES` — en croyant y ajouter une restriction. Cette liste ne
restreint pas : elle **court-circuite le forfait**
(`capabilities[c] = !readOnly`, les options du plan ne sont plus lues). Le
résultat était l'inverse de l'intention : Starter obtenait le droit d'écrire
dans le stock tout en se voyant refuser la lecture. Le test l'a montré en
renvoyant 201 là où 402 était attendu.

Corrigé en ramenant le tout à **une seule capacité**, simple option de
forfait. Deux clés au comportement strictement identique auraient de toute
façon été un piège pour le prochain lecteur. Un test porte désormais ce
constat, pour que l'erreur ne puisse pas revenir.

**Ce que la rétrogradation ne fait pas.** Elle ne supprime rien et n'écrit
rien en douce. Une station repassée en Starter garde ses produits, ses
mouvements et ses recettes ; enregistrer un lavage reste possible — c'est le
métier même de Starter — mais ne déduit plus. Le stock se fige, à inventorier
au retour en Pro, plutôt que d'être faussé sans que personne puisse le voir.

**Vérifié en conditions réelles** sur la base persistée. Sur Starter : les
trois routes de lecture répondent 402 `plan_upgrade_required` avec le message
« Suivi du stock de consommables n'est pas inclus dans votre forfait actuel »,
tandis que le caissier reçoit 403 — le rôle est évalué avant l'argent, et on
ne propose jamais un forfait à qui la page ne concerne pas. Un lavage de
2 prestations a été enregistré (6 000 F) sur une prestation dont la recette
déclare 2 sachets : le produit visé est **resté à 5 sachets**. La bascule vers
Pro a ensuite été jouée par le vrai parcours — souscription, déclaration de
paiement, validation en console — et le stock est redevenu lisible.

**Tests** : 12 nouveaux (`tests/stock-plan.test.ts`), suite à **525/525**.
Cinq mutations éprouvées, toutes détectées, dont la remise de `stock.manage`
dans `WRITE_CAPABILITIES`.

**Reste à faire, mineur** : `stock_movements.wash_id` est enregistré en base
mais n'est pas exposé par `GET /stock-movements`. Le relier à l'écran
permettrait de cliquer d'un mouvement vers le lavage qui l'a provoqué.

### 21 octobre 2026 — L4.1, relier un mouvement de stock à son lavage

**Avant** : une consommation automatique s'affichait « −8 sachets ·
Consommation automatique du lavage · Kouamé ». Deux défauts. On ne savait pas
**quel** lavage. Et le nom affiché était celui du caissier, qui n'avait rien
décidé — c'est le système qui déduit.

**Après**, deux sens de lecture :

| Sens | Ce qu'on obtient |
| --- | --- |
| Stock → lavage | la colonne « Motif » devient un lien portant la **référence** (`LAV-20261021-841587`) |
| Lavage → stock | un bloc « Sorti du stock » sur la fiche de lavage |

**Aucune migration** : la colonne `wash_id` et son index partiel existaient
depuis L4, ils n'étaient simplement pas exposés.

**La porte, qui était le vrai sujet.** La fiche de lavage est ouverte à tout
caissier ; le stock ne l'est pas. Renvoyer les consommables sans condition
aurait ouvert d'un coup les quantités et les coûts unitaires à tout le monde,
**en contournant les deux verrous posés la veille** — le rôle et le forfait
Pro. Le bloc n'est calculé que si l'appelant a `stock:read` **et** la capacité
`stock.manage`.

**Clé absente, pas vide.** Un tableau vide dit « ce lavage n'a rien
consommé » ; l'absence de clé dit « cette information ne vous est pas
destinée ». Les confondre afficherait « aucun consommable » à un caissier,
c'est-à-dire un mensonge. Un test porte précisément cette nuance.

**Ce sont les mouvements qui sont lus, pas la recette.** La recette a pu
changer depuis, et un lavage saisi hors forfait n'a rien déduit. Seule la
trace écrite dit ce qui s'est réellement passé.

**La colonne « Par ».** Pour une déduction automatique, l'écran affiche
« Système », la personne restant accessible en infobulle. Elle demeure dans la
donnée — c'est la cause, la traçabilité en dépend — mais l'écran cesse de
présenter un mouvement déclenché par le système comme un geste délibéré.
Imputer silencieusement 8 sachets à un caissier serait le même défaut que
celui que le produit combat ailleurs.

**Deux pièges évités à l'écriture.** `MOVEMENT_FIELDS` sert aussi à trois
clauses `RETURNING` qui retirent le préfixe `m.` : y glisser un champ joint
aurait cassé les trois insertions. Seule la colonne réelle `m.wash_id` y a été
ajoutée, la référence jointe restant dans le `SELECT` de la liste. Et la
jointure est bornée par l'organisation : sans cela, un identifiant de lavage
suffisait à faire remonter la référence d'une station voisine — c'est l'objet
d'un test et d'une mutation.

**Vérifié en conditions réelles** : lavage `LAV-20261021-841587`, 6 000 F,
recette de 2 sachets × 2 prestations. Le mouvement porte la référence ; le
propriétaire voit « 4 sachets » sur la fiche ; le caissier ouvre la même fiche
sans recevoir la clé ; après annulation, la consommation et sa contrepassation
s'affichent toutes deux. La bascule vers Pro a été jouée par le vrai parcours
— souscription, déclaration, validation en console.

**Tests** : 9 nouveaux (`tests/stock-wash-link.test.ts`), suite à **534/534**.
Cinq mutations éprouvées, toutes détectées : rôle retiré, forfait retiré, clé
vide au lieu d'absente, jointure non bornée, référence jamais renvoyée.

### 21 octobre 2026 — L5, fournisseurs et achats

Jusqu'ici le stock ne montait que par une saisie manuelle, sans trace de qui
avait vendu la marchandise ni de ce qu'elle avait coûté. Et la dépense
correspondante se tapait à part, dans un autre écran, à un autre moment.

**Deux questions posées avant de construire**, parce que les réponses
changeaient le modèle : paie-t-on sur place ou à crédit ? repart-on avec toute
la marchandise ? Réponses : **toujours sur place, toujours tout d'un coup**.
Le lot s'en trouve considérablement simplifié — pas d'échéancier fournisseur,
pas de réception partielle, pas de statut « commandé ». L'achat est l'instant
où tout se produit : l'argent sort, la marchandise entre.

**La règle « seules les quantités reçues augmentent le stock ».** Elle ne
devient pas caduque pour autant, elle change de forme : au lieu d'un flux de
réception, c'est le **mot** qui la porte. La colonne s'appelle
`received_milli`, le champ à l'écran s'appelle « quantité reçue », et la
consigne du formulaire dit de compter ce qu'il y a dans le sac, pas ce qui est
écrit sur le bon. Quand le vendeur en met dix-huit au lieu de vingt, on tape
dix-huit. La règle est au point de saisie, là où elle sert.

**Le double comptage achat/dépense.** C'est l'achat qui écrit la dépense,
jamais l'utilisateur. Le lien `expenses.purchase_id` porte un **index unique**:
le doublon n'est pas découragé, il est impossible à écrire.

**Ce que la première version manquait, et que l'épreuve du réel a révélé.**
Écrire une seule dépense ne suffit pas si cette dépense reste modifiable. Les
routes `PATCH` et `DELETE` des dépenses permettaient de changer le montant ou
de faire disparaître la ligne, laissant la marchandise en stock sans
contrepartie — un achat gratuit. Les deux routes refusent désormais une
dépense issue d'un achat, en **409**, avec le chemin de correction : annuler
l'achat, ce qui reprend aussi la marchandise. Deux tests et une mutation
couvrent ce verrou.

Et la moitié visible de la garantie comptait autant : l'écran Dépenses affiche
maintenant « Issue d'un achat — déjà comptée » sous la ligne concernée. Sans
cette mention, le gérant croirait l'achat non enregistré et le ressaisirait.

**Symétrie avec le lot précédent.** `stock_movements.purchase_id` fait pour
l'achat ce que `wash_id` fait pour le lavage : depuis le stock, la colonne
« Motif » renvoie à l'achat par sa référence `ACH-…` ; la colonne « Par » dit
« Système », l'infobulle nommant la personne et la cause. Les deux sens de
lecture sont les mêmes, et le code qui les sert aussi.

**Annulation plutôt que suppression**, comme partout. L'entrée d'origine reste
lisible à côté de sa contrepassation. Si la marchandise a déjà été consommée,
le stock passe en négatif : c'est voulu, un négatif appelle un inventaire et
ne doit jamais empêcher de corriger une erreur de saisie. La caisse n'est
recréditée que si la journée est encore **ouverte** — une caisse comptée et
signée ne se réécrit pas.

**Vérifié en conditions réelles** : achat `ACH-20261021-AF9BD9`, 5 000 F chez
un fournisseur nommé, 20 sachets + 4 chiffons entrés, une dépense de 5 000 F
et une seule, modification et suppression refusées en 409, caissier en 403.
Sur le tiroir : 26 000 F avant, 24 500 F après un achat de 1 500 F en espèces,
26 000 F après annulation — l'argent revient au centime.

**Tests** : 28 nouveaux (`tests/purchases.test.ts`), suite à **562/562**.
Sept mutations éprouvées, toutes détectées — forfait, rôle, cloisonnement du
fournisseur, dépense non écrite, garde de double contrepassation, contrôle de
caisse, verrou sur la dépense. Le garde `NOT EXISTS` de la contrepassation
étant inatteignable par l'API (un 409 le précède), il est éprouvé par appel
direct de la fonction : c'est la leçon du lot L4, appliquée d'emblée.

**Reste ouvert.** Un achat ne met pas à jour le coût de référence du produit :
le mouvement fige le prix payé, mais la fiche produit garde le sien. À trancher
avec les rapports de marge (L6).

### 21 octobre 2026 — Module Équipes : présences et rendement

Audit d'abord, conformément à la méthode. Il a révélé une **collision de
fond** entre le cahier des charges reçu et le produit tel qu'il a été décidé.

Le cahier demande des tâches en cours, des heures de début et de fin, un temps
moyen de réalisation. Or `INSERT INTO washes(… status …) VALUES(…,'completed',…)`
— tout lavage naît terminé, et `in_progress` n'existe nulle part. WashPilot est
une caisse enregistreuse, pas un suivi d'atelier.

Construire ces indicateurs aurait rempli l'écran de colonnes vides à
perpétuité. Le cahier l'interdit lui-même : « n'invente pas de résultats de
performance lorsque les données nécessaires n'existent pas ». Ils ne sont donc
pas construits, et l'écran **dit pourquoi**.

Le reste — présences, attribution juste, volumes, régularité — a été livré.
Trois refus le structurent : ne pas déduire une absence d'un silence, ne pas
inventer d'heure de référence, ne pas transformer une donnée absente en zéro.
Et une règle de comptage : un lavage fait à trois reste un lavage pour la
station, chacun en recevant une part de 333 millièmes.

Détail complet, règles, limites et suite : **`MODULE-EQUIPES.md`**.

53 tests ajoutés, suite à **615/615**, 7 mutations toutes détectées.
