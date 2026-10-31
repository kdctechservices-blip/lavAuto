# Analyse du projet — WashPilot CI

**Date :** 23 octobre 2026 · **Commit analysé :** `5409116` (branche `arena/9086e8e3-lavautomaj`)
**Périmètre :** l'ensemble du dépôt, avec un examen approfondi du **catalogue** :
catégories de prestations, catégories de véhicules et **prestations**.
**Méthode :** lecture du code + exécution réelle (`tsc`, `eslint`, build, suite de tests,
smoke) + trois expérimentations ciblées contre l'API en base mémoire pour vérifier des
soupçons (voir §6). Aucun fichier de code n'a été modifié : seul ce document a été ajouté.

---

## 1. Verdict en une page

WashPilot CI est un SaaS **multi-tenant** de gestion de stations de lavage (Côte d'Ivoire),
techniquement sérieux : 48 tables, ~160 routes, 858 tests qui passent, typage strict sans
erreur, CI complète, mode hors ligne réel, console éditeur séparée de l'espace client.
Les documents du dépôt (7 228 lignes) montrent un travail d'audit antérieur rare et honnête.

Le **catalogue** (catégories + prestations) est fonctionnel sur le chemin nominal :
créer une prestation, la classer, la désactiver, la facturer, figer son prix dans le lavage,
la retrouver dans les rapports et sur le reçu. Ce socle est solide et bien pensé
(prix recalculés côté serveur, lignes de lavage figées, désactivation plutôt que suppression).

**Mais le catalogue est la zone où la promesse du produit et le code ont le plus divergé.**
Quatre défauts de sévérité haute, tous vérifiés :

| # | Défaut | Sévérité | Preuve |
|---|---|---|---|
| **CAT-01** | Le **prix par catégorie de véhicule** est facturé par le serveur mais ignoré par les deux écrans de caisse : l'écran affiche et valide un total faux (mesuré : 1 000 F affichés, 5 000 F enregistrés) | **P1** | CAT-01, reproduction §6.2 |
| **CAT-02** | Ce même prix par catégorie **n'est éditable nulle part** : l'état existe dans le formulaire, aucun champ ne le rend, il n'est jamais envoyé | **P1** | `services/page.tsx:79,171-173,204-210` |
| **CAT-03** | **Aucune trace** des changements de tarif, de prestation ou de catégorie dans le journal d'audit — alors que lavages, paiements, dépenses, stock le sont | **P1** | CAT-03, §6.3 |
| **CAT-04** | Le plafond `max_services` du forfait est **affiché au client mais appliqué nulle part**, et une prestation créée par erreur **ne peut pas être supprimée** depuis l'interface | **P1** | `billing/page.tsx:119` / `api.ts:499` |

S'y ajoutent dix constats de sévérité moyenne ou basse (doublons de prestations autorisés,
onboarding qui ne crée aucune catégorie de prestation, validation des clés de prix absente,
affichage qui contredit la matrice RBAC, unité monétaire « XOF » isolée, 1 417 lignes de
modales mortes ayant emporté deux fonctions, etc.).

**En résumé :** le produit est prêt pour un pilote sur le chemin nominal ; le catalogue doit
être remis d'aplomb avant la première facturation réelle s'il est utilisé avec des tarifs
différenciés (ce que le domaine — berline / SUV / moto — rend très probable).

---

## 2. Le projet en un coup d'œil

### 2.1 Stack et architecture

```
                        ┌──────────────────────────────────────────┐
   Navigateur  ───────► │  Express 5 (tsx) — server.ts             │
   (SPA React 19)       │                                          │
                        │  /api/v1/auth      (sessions maison)     │
                        │  /api/v1/console   (éditeur, cookie à    │
                        │                     part, monté AVANT)   │
                        │  /api/v1/*         (session + tenant +   │
                        │                     abonnement + droits) │
                        │  SPA : middleware Vite (dev) / dist (prod)│
                        └───────────────┬──────────────────────────┘
                                        │ pg (SQL explicite, pas d'ORM)
                                        ▼
                        PostgreSQL (Neon) ou PGlite embarquée
                        schéma auto-créé au démarrage (server/db.ts)
```

| Couche | Choix | Remarque |
|---|---|---|
| Frontend | React 19, Vite 8, TypeScript 6, Tailwind 4, shadcn/Base UI, React Router 7, Recharts | 36 routes applicatives + 12 routes console |
| Backend | Express 5 exécuté par `tsx` | ~160 routes déclarées, SQL écrit à la main |
| Auth | Maison : scrypt + sessions opaques en base, cookie `httpOnly` | Jeton aussi renvoyé dans le corps (voir §4.1) |
| Données | 48 tables, montants en centimes XOF | Schéma versionné par `ALTER … IF NOT EXISTS` au boot |
| Hors ligne | Service worker + file IndexedDB + idempotence | Lavages et dépenses rejouables (§4.4) |
| Déploiement | Docker, Vercel (bundle serverless), CI GitHub Actions | CI : types, lint, build, tests, smoke serverless, image |

Le point d'architecture le plus notable : **la console éditeur est montée avant
`requireSession`** (`server/app.ts:63-80`) avec son propre cookie et ses propres sessions.
Une session de station ne peut pas la franchir. C'est une décision lisible et bien commentée.

### 2.2 Chiffres mesurés aujourd'hui

| Indicateur | Valeur |
|---|---|
| Fichiers TypeScript / TSX (src + server + tests + scripts) | 353 |
| Lignes — interface (`src/`) | 41 841 |
| Lignes — serveur (`server/`) | 18 326 |
| Lignes — tests | 15 820 (60 fichiers) |
| Tables PostgreSQL | 48 |
| Routes API déclarées | ~160 |
| Documentation (`*.md`) | 19 fichiers, 7 228 lignes |
| `npx tsc -b` | **0 erreur** |
| `npm run lint` | **0 erreur**, 28 avertissements (`react-refresh`, 1 `exhaustive-deps`) |
| `npm run build` | **OK** (bundle principal 343 kB / 108 kB gzip) |
| `npm test` | **858 tests, 858 succès, 0 échec** (~135 s) |
| `npm run smoke` | **69/69 vérifications** (parcours complet + console) |

### 2.3 Modules fonctionnels

| Module | Écrans | État |
|---|---|---|
| Onboarding | `/onboarding` (5 étapes) | Complet ; crée site, prestations, laveurs, abonnement + catégories **de véhicules** |
| **Catalogue** | `/services`, `/service-categories`, `/vehicle-categories` | Complet à 80 % — objet de ce rapport (§3) |
| Lavages | `/washes`, `/washes/:id` | Très complet : file d'attente, tâches, chronomètre, plaque, reçu |
| Encaissements | `/payments`, `/washes/:id` | Complet (partiel, mobile money à confirmer, remboursement) |
| Caisse | `/cash-drawer` | Complet (ouverture, mouvements, clôture, écart motivé) |
| Dépenses / Achats / Stock | `/expenses`, `/purchases`, `/stock` | Complets, avec consommables par prestation |
| Équipe | `/team`, `/team-attendance`, `/team-performance`, `/work-schedules` | Complet (RBAC, présences, rendement) |
| Rapports | `/reports`, `/dashboard`, `/history` | Complet (période, par site, export CSV, audit) |
| Abonnement | `/settings/billing`, `/trial/*` | Complet (essai 14 j, lecture seule, demandes d'activation) |
| Console éditeur | `/console/*` (12 écrans) | Complet (comptes, forfaits, revenus, support, monitoring, journal) |

### 2.4 Où vit l'argent

Trois principes sont correctement appliqués et méritent d'être préservés :

1. **Le client ne fixe jamais le prix.** `POST /washes` recharge les prestations en base
   et recalcule le total (`server/api.ts:676-704`) ; le prix envoyé par l'interface est ignoré.
2. **La vente fige ses lignes.** `wash_items` copie `service_name`, `unit_price_cents`,
   `line_total_cents` (`server/db.ts:307-313`). Renommer ou changer le prix d'une prestation
   ne réécrit pas l'histoire — les rapports lisent le nom figé (`server/reports.ts:265`).
3. **On désactive, on ne supprime pas.** Les écrans n'offrent que l'activation/désactivation,
   et les routes `DELETE` refusent si un lavage référence l'objet (`409 service_in_use`).

---

## 3. Dossier de fond : catégories et prestations

### 3.1 Trois notions qu'il faut nommer sans confusion

Le produit emploie « catégorie » pour deux choses différentes, plus « prestation » :

| Notion | Table | Rôle | Écran |
|---|---|---|---|
| **Catégorie de prestation** | `service_categories` | Taxonomie commerciale du catalogue (« Lavage classique », « Detailing & Soins ») | `/service-categories` |
| **Catégorie de véhicule** | `vehicle_categories` | Type de véhicule lavé (« Berline », « SUV / 4x4 », « Moto ») ; **obligatoire** pour enregistrer un lavage | `/vehicle-categories` |
| **Prestation** | `services` | Ce qui est vendu, avec son prix, sa durée, sa catégorie | `/services` |

Cette proximité de vocabulaire est la source d'une bonne partie des défauts ci-dessous :
le prix « par catégorie » porte sur les **véhicules**, pas sur les catégories de prestations,
et l'interface ne le dit jamais.

### 3.2 Modèle de données

```sql
service_categories                 vehicle_categories                services
──────────────────                 ──────────────────                ────────
id            uuid PK              id         uuid PK                id            uuid PK
organization_id uuid NOT NULL      organization_id uuid NOT NULL     organization_id uuid NOT NULL
name          text NOT NULL        name       text NOT NULL          category_id   uuid → service_categories
is_active     bool DEFAULT true    is_active  bool DEFAULT true      name          text NOT NULL
created_at    timestamptz          created_at timestamptz  ← rien   description   text
updated_at    timestamptz          (pas d'updated_at)  ← rien       price_cents   int ≥ 0
UNIQUE(organization_id, name)      UNIQUE(organization_id, name)     price_by_vehicle_type jsonb DEFAULT '{}'
                                                                     duration_minutes int 1..1440
                                                                     is_active     bool
                                                                     created_at / updated_at
                                                                     ⚠ aucune contrainte d'unicité sur name
```

Points à retenir :

- `vehicle_categories` **n'a pas de `updated_at`**, contrairement à sa jumelle ;
  l'API renvoie `created_at AS updated_at` (`server/api.ts:362,377`) — un champ qui ment.
- `services.name` n'est **pas unique** par organisation, alors que les deux tables de
  catégories le sont. Voir CAT-05.
- `services.category_id` est **nullable** : une prestation peut vivre « sans catégorie »,
  et c'est le cas de **toutes** les prestations créées par l'onboarding (CAT-06).
- `price_by_vehicle_type` est un `jsonb` **sans validation métier** : clés libres (CAT-07).
- Aucune table d'historique de prix : le seul endroit où un ancien prix survit est
  `wash_items`, c'est-à-dire les ventes. Un changement de tarif n'a **aucune** trace (CAT-03).

### 3.3 Cycle de vie d'une prestation

```
   Création                     Classement                  Vente                        Restitution
   ─────────                    ──────────                  ─────                        ───────────
 /services (dialogue)  ──┐
 onboarding étape 2    ──┼──► services.category_id ──►  POST /washes
 données de démo       ──┘        (facultatif)             ├─ recharge les services actifs
                                                            ├─ resolvePrice(service, catégorie véhicule)
                                                            ├─ INSERT washes(total_cents, estimated_minutes)
                                                            ├─ INSERT wash_items(nom + prix figés)
                                                            ├─ consommation stock (recette de la prestation)
                                                            └─ audit_logs: wash.created
                                                                                          │
                                                                    rapports (nom figé) ◄─┤
                                                                    reçu imprimable     ◄─┘
                                                                    
   Modification du prix : PATCH /services/:id → aucune trace, aucun historique.
   Désactivation        : PATCH is_active=false → la prestation sort des nouveaux lavages,
                          les lavages passés gardent nom et prix. (bon comportement)
   Suppression          : DELETE refusé si wash_items référence (bon), mais aucun bouton
                          dans l'interface (CAT-04).
```

### 3.4 Surface API du catalogue

| Méthode & route | Permission | Comportement | Testé ? |
|---|---|---|---|
| `GET /services` | `service:read` | Liste (tous statuts), prix par véhicule inclus | indirectement |
| `GET /services/:id` | `service:read` | Fiche | non |
| `POST /services` | `service:manage` | Crée ; valide `category_id` de l'org | indirectement (tests stock) |
| `PATCH /services/:id` | `service:manage` | Fusionne puis réécrit ; valide `category_id` | oui (RBAC) |
| `DELETE /services/:id` | `service:manage` | `409` si `wash_items` référence | **non** |
| `GET /service-categories` | `service:read` | Liste triée par nom | **non** |
| `POST /service-categories` | `service:manage` | `409 category_exists` (unicité **sensible à la casse**) | **non** |
| `PATCH /service-categories/:id` | `service:manage` | Renomme / active | **non** |
| `DELETE /service-categories/:id` | `service:manage` | `409` si une prestation l'utilise | **non** |
| `GET /vehicle-categories` | `service:read` | Liste (`created_at AS updated_at`) | oui |
| `POST /vehicle-categories` | `service:manage` | `409` si doublon | **non** |
| `PATCH /vehicle-categories/:id` | `service:manage` | Renomme / active | non |
| `DELETE /vehicle-categories/:id` | `service:manage` | `409` si un lavage l'utilise | non |
| `GET /service-catalog` | session | Modèles proposés à l'onboarding (global, non éditable) | non |
| `GET/PUT /services/:id/consumables` | `service:manage` + `stock.manage` | Recette de stock de la prestation | oui (4 fichiers) |

Constat de couverture : **les routes `service-categories` ne sont exercées par aucun test**,
et `price_by_vehicle_type` non plus (0 occurrence dans `tests/`, vérifié).

### 3.5 Écrans

| Écran | Ce qu'il fait bien | Ce qui manque |
|---|---|---|
| `/services` | Recherche, création/édition, durée, catégorie, activation, accès aux consommables, garde-fous de droits lisibles | Prix par véhicule (éditable et **affiché**), description, suppression, filtre par catégorie/statut, « prix à partir de » |
| `/service-categories` | Recherche, nom, activation, compteur actifs/total, doublon signalé | Suppression, réordonnancement, nombre de prestations par catégorie |
| `/vehicle-categories` | Activation, catégories par défaut à l'inscription | Recherche (incohérent avec l'écran jumeau), suppression, `updated_at` réel |
| `/washes` (création) | Total en direct, quantités, plaque + historique véhicule, blocage explicite si configuration incomplète | **Prix par catégorie de véhicule ignoré** (CAT-01) |
| `/onboarding` étape 2 | Sélection de modèles, prestation libre, prix | Aucune catégorie de prestation créée (CAT-06) |

### 3.6 Ce qui est déjà bien fait (à ne pas casser)

- **Prix jamais confiés au client** ; total recalculé, lignes figées, reçu et rapports
  cohérents avec la vente même après renommage.
- **Désactivation plutôt que suppression**, avec messages qui expliquent la conséquence
  sur l'historique (`services/page.tsx:226-228`).
- **Gardes d'écriture** : `actionGate` distingue « droits en cours de chargement » (bouton
  actif, clic mémorisé) de « refus avéré » (bouton grisé + motif visible) — rare et précieux.
- **Isolation multi-tenant** vérifiée sur chaque requête (`organization_id=$n::uuid`) et
  couverte par `tests/tenant-isolation.test.ts`.
- **Défauts de catalogue par défaut** côté véhicules, avec un raisonnement documenté
  (`server/default-catalog.ts` + `tests/default-catalog.test.ts`).
- **Recette de consommables** par prestation, contrepasée à l'annulation du lavage.

---

### 3.7 Défauts détaillés

Chaque constat suit le même format : **Constat → Preuve → Impact → Correctif**.

#### CAT-01 · Le prix par catégorie de véhicule est facturé par le serveur et ignoré par l'écran — **P1**

**Constat.** Le serveur applique `services.price_by_vehicle_type[vehicle_category_id]` quand
la clé existe, sinon `price_cents`. Les deux écrans qui composent un lavage calculent leur
total **uniquement** avec `price_cents`.

**Preuve.**

- Serveur : `server/api.ts:684-689` (`resolvePrice`), `701-704` (total), `783` (prix unitaire).
- Écran principal : `src/app/washes/page.tsx:61-67` (l'interface `Service` n'a pas le champ),
  `383-386` (`totalCents`), `965` (`{formatXof(service.price_cents)} / unité`).
- Modale de secours : `src/components/modals/create-wash-modal.tsx:71-76, 208-216`.
- Reproduction exécutée (§6.2) : prestation à 1 000 F, prix SUV à 5 000 F, lavage SUV d'une
  unité → **`total_cents` enregistré = 500 000 centimes (5 000 F), total calculé par
  l'écran = 100 000 centimes (1 000 F)**.

**Impact.** Trois conséquences, dans cet ordre de gravité :

1. Le caissier annonce un prix faux et le client paie ce qu'on lui dit.
2. Le garde-fou client `amount_received_cents <= totalCents` (`washes/page.tsx:387`) **refuse**
   le montant réel : impossible d'encaisser 5 000 F sur une prestation affichée 1 000 F.
3. Le lavage est enregistré à 5 000 F avec, au mieux, 1 000 F reçus → « partiellement réglé »
   fantôme, écart de caisse en fin de journée, rapport de chiffre d'affaires juste côté serveur
   mais inexplicable côté station.

**Pourquoi cela n'a pas encore explosé :** parce que l'interface ne permet pas de saisir un
prix par véhicule (CAT-02). Les deux défauts se neutralisent tant que personne n'utilise
l'API directement — c'est-à-dire jusqu'au premier import de tarifs.

**Correctif (≈ ½ journée).** Un helper unique, utilisé des deux côtés, et un test qui compare
le calcul du client et celui du serveur sur un jeu de cas (`price_by_vehicle_type` vide,
clé présente, clé absente, catégorie inconnue) :

```ts
// src/lib/service-pricing.ts
export function serviceUnitPrice(
  service: { price_cents: number; price_by_vehicle_type?: Record<string, number> | null },
  vehicleCategoryId: string | null | undefined,
): number {
  const override = vehicleCategoryId ? service.price_by_vehicle_type?.[vehicleCategoryId] : undefined
  return typeof override === "number" && Number.isFinite(override) ? override : service.price_cents
}
```

Puis remplacer les deux `service.price_cents` de `washes/page.tsx` et
`create-wash-modal.tsx` par cet appel, et faire lire `price_by_vehicle_type` dans l'interface
`Service` (le champ est **déjà** renvoyé par `GET /services`).

**Alternative assumée** si l'on ne veut pas livrer la fonctionnalité tout de suite : la
**désactiver côté serveur** (`resolvePrice` renvoie toujours `price_cents`) plutôt que de
laisser deux calculs divergents. Une fonctionnalité absente est un manque ; deux prix
différents pour le même lavage est un incident.

---

#### CAT-02 · Le prix par catégorie de véhicule n'est éditable nulle part — **P1**

**Constat.** Le formulaire de prestation contient un état `price_by_vehicle_type`, alimenté à
l'ouverture en édition… puis jamais rendu et jamais envoyé.

**Preuve.** `src/app/services/page.tsx` :
`79` (champ du formulaire), `87` (valeur initiale vide), `171-173` (conversion centimes →
francs à l'ouverture), `204-210` (corps envoyé : ni description, ni `price_by_vehicle_type`,
ni `is_active` explicite pour une création). Aucun `<Input>` ni `<Select>` ne porte ce champ
dans le dialogue (`322-331`).

**Impact.** La seule voie pour définir un tarif différencié est un `curl`. Une fonctionnalité
payante du domaine (un SUV se facture plus cher qu'une berline) est « livrée » dans le schéma,
l'API et le calcul, mais inaccessible au client — ce qui est exactement la définition d'une
fonctionnalité morte. Le champ inutilisé empêche aussi TypeScript de signaler l'oubli :
il est lu, jamais écrit.

**Correctif (≈ 1 journée, avec CAT-01).** Dans le dialogue, une section « Prix par catégorie
de véhicule » listant les catégories **actives**, avec le prix de base en valeur par défaut
(placeholder « = prix de base »), un champ vide signifiant « pas de tarif spécifique ».
Envoyer l'objet dans le `PATCH`/`POST`, afficher dans la colonne Prix un « à partir de X »
quand au moins un tarif spécifique existe, et rappeler la règle dans l'écran de caisse
(« prix SUV appliqué »).

---

#### CAT-03 · Aucune trace des changements de tarif — **P1**

**Constat.** Les routes du catalogue n'écrivent **jamais** dans `audit_logs`. Lavages,
paiements, dépenses, caisse, stock, présences, achats, accès et abonnement, oui.

**Preuve.** `grep "INSERT INTO audit_logs" server/*.ts` : aucune occurrence dans `api.ts`
(routes catalogue). Les actions écrites sont listées en annexe §6.3. Le seul lien entre
audit et catalogue est `service.consumables_updated` (`server/stock.ts:822`), qui n'a
**ni libellé d'action ni libellé d'entité** (`server/audit-log.ts:38-75`) : l'écran
`/history` affiche donc la clé technique brute. Au total, 16 actions et 7 entités utilisées
n'ont pas de traduction.

**Impact.** Pour un produit qui remplace un cahier de caisse, « qui a changé le prix et
quand » est une question de premier ordre : en cas de contestation (client, gérant,
administration fiscale), la réponse est vide. Le propriétaire peut aussi découvrir un tarif
modifié par un compte délégué sans aucune trace. C'est le seul domaine financier du produit
sans journal.

**Correctif (≈ 1 journée).** Écrire `service.created`, `service.updated`,
`service.deactivated`, `service_category.*`, `vehicle_category.*` avec un `metadata`
`{ before: { price_cents }, after: { price_cents } }`. Ajouter les libellés français
manquants et un test de cohérence — le dépôt a déjà le bon outil pour cela
(`tests/referentials.test.ts`) : « toute action écrite dans `server/*.ts` possède un libellé ».

---

#### CAT-04 · Plafond de prestations non appliqué, suppression impossible — **P1**

**Constat.** Deux moitiés d'un même manque.

1. `plans.max_services` vaut **10** pour Starter et `NULL` (illimité) pour Pro/Business
   (`server/db.ts:97-99`). La page de facturation l'annonce au client
   (`src/app/settings/billing/page.tsx:119-120`). Aucun code ne le vérifie : `plan-limits.ts`
   ne connaît que `max_sites` (`:126,136,146,160`), `team.ts:40` gère `max_workers`, `tenant.ts:86`
   gère `max_users`. `max_services` n'apparaît nulle part ailleurs que dans l'affichage et la
   liste des colonnes du forfait.
2. Le produit assume « on désactive, on ne supprime pas » — mais **aucun écran ne propose la
   suppression**, alors que les trois routes existent (`api.ts:339` catégories de
   prestations, `415` véhicules, `499` prestations) avec le bon garde-fou (`409` si
   utilisé). Les modales mortes, elles, avaient le bouton (CAT-10).

**Impact.** Deux dérives opposées : une promesse commerciale non tenue (un compte Starter peut
créer 200 prestations sans blocage, ce qui rend le palier Pro moins évident à vendre), et un
catalogue qui ne peut pas être nettoyé — une faute de frappe reste pour toujours dans le
sélecteur de caisse, qui n'affiche que le nom et le prix.

**Correctif (≈ 1 journée).** Un `assertServiceCapacity(client, organizationId)` calqué sur
`team.ts:40-60` (verrou consultatif par organisation, `409 plan_limit_reached` avec le nom du
forfait), appelé depuis `POST /services` et depuis la réactivation. Puis un bouton de
suppression dans les trois écrans, affiché seulement si l'objet n'est pas utilisé, avec le
message déjà écrit côté serveur.

---

#### CAT-05 · Unicité incohérente : prestations dupliquées, catégories sensibles à la casse — **P2**

**Constat.** `services` n'a aucune contrainte d'unicité sur le nom ; les deux tables de
catégories en ont une, mais **sensible à la casse**. L'onboarding, lui, déduplique en
`lower(name)` (`server/onboarding.ts:355-366`).

**Preuve (mesurée, §6.2).** Deux `POST /services` avec le nom exact « PROBE Doublon » →
`201` et `201`, deux identifiants distincts. Deux `POST /service-categories`
« PROBE Casse » puis « probe casse » → `201` et `201`.

**Impact.** Deux « Lavage complet » à 3 000 F et 6 000 F cohabitent dans le sélecteur de
caisse, qui affiche le nom et le prix : le caissier choisit au nom, le client paie l'un ou
l'autre selon la ligne cliquée. C'est une erreur de facturation silencieuse, et elle est
invisible dans les rapports (les lignes figées portent le même `service_name`).

**Correctif (≈ ½ journée).** Index unique sur `lower(name)` par organisation pour `services`
et les deux tables de catégories, avec la **déduplication préalable** déjà pratiquée pour
`service_catalog` (`server/db.ts:147-150`) : sans elle, la création de l'index échoue sur une
base existante. Ajouter le `409` correspondant aux trois routes et un message qui nomme le
doublon.

---

#### CAT-06 · L'onboarding ne crée aucune catégorie de prestation — **P2**

**Constat.** À la confirmation de l'assistant, trois catégories **de véhicules** sont créées
si la liste est vide (`server/onboarding.ts:335-353`), puis les prestations sont insérées
**sans `category_id`** (`:355-366`). Les catégories de prestations n'existent que pour
l'organisation de démonstration (`server/db.ts:960-968` : « Lavage classique »,
« Detailing & Soins »). Les neuf modèles de `service_catalog` portent pourtant une catégorie
(`exterior_wash`, `interior_cleaning`, `complete_wash` — `server/db.ts:151-160`), ignorée par
l'écran (`src/app/onboarding/components/services-step.tsx`, aucune mention) et par la
confirmation.

**Impact.** À la sortie de l'assistant, un nouveau client obtient : une page « Catégories de
prestations » vide, toutes ses prestations affichées « — » dans la colonne Catégorie, et un
menu de navigation (« Configuration › Catalogue ») qui mène à un référentiel inutilisé. Le
produit savait classer ses modèles, puis il a jeté l'information. Le client doit recréer à la
main ce que le produit aurait pu poser en trois lignes — et ne le fera pas.

**Correctif (≈ ½ journée).** Étendre `server/default-catalog.ts` avec
`DEFAULT_SERVICE_CATEGORIES` et un mapping `modèle → catégorie`, créer ces catégories à la
confirmation (même logique « uniquement si la liste est vide »), et renseigner `category_id`
à l'insertion des prestations retenues. Un test `default-catalog` existe déjà : il suffit de
l'étendre.

---

#### CAT-07 · Les clés de `price_by_vehicle_type` ne sont pas validées — **P2**

**Constat.** Le validateur accepte n'importe quelle chaîne comme clé
(`server/api.ts:27`) : ni UUID, ni appartenance à l'organisation, ni catégorie active.

**Preuve (mesurée, §6.2).** `POST /services` avec
`price_by_vehicle_type: { "pas-un-uuid": 999, "<uuid aléatoire>": 42 }` → `201`.

**Impact.** Trois risques : des prix fantômes persistés et jamais purgés ; un identifiant de
catégorie d'une **autre** organisation accepté (copier-coller entre deux postes, import CSV) ;
et un tarif qui continue de cibler une catégorie désactivée ou supprimée sans que personne ne
le voie. Combiné à CAT-01, un tarif fantôme peut modifier un total réel.

**Correctif (≈ ½ journée).** Valider l'ensemble des clés en une requête
(`SELECT id FROM vehicle_categories WHERE organization_id=$1 AND id = ANY($2::uuid[])`) et
renvoyer `400 invalid_vehicle_category` pour la clé fautive. Purger les clés orphelines au
`PATCH` et lors de la désactivation d'une catégorie.

---

#### CAT-08 · `canManage` contredit la matrice RBAC — **P2**

**Constat.** Les trois écrans du catalogue décident d'afficher les actions avec
`member.role === "owner" || member.role === "manager"`
(`services/page.tsx:136`, `service-categories/page.tsx:72`, `vehicle-categories/page.tsx:72`).
Or la matrice serveur ne donne au gérant que `service:read` (`server/permissions.ts:116`), et
le décrit comme « Ne modifie ni les tarifs » (`:92`). Le test d'autorisation exige `403`
(`tests/authorization-api.test.ts:98-107`) ; mesure : gérant → `GET` 200, `POST` 403.

**Impact.** Un gérant voit les boutons (grisés, avec la bonne `BlockedReason`), mais **pas** la
bannière qui explique la règle — celle-ci ne s'affiche que si `!canManage`
(`services/page.tsx:253`), donc jamais pour lui. Il lit par ailleurs l'inverse dans le
message du rôle ailleurs dans le produit. Surtout : le jour où la matrice change (le
propriétaire peut déléguer `service:manage`), l'affichage ne suivra pas ; et inversement.

**Correctif (≈ 1 heure).** `const canManage = manageCatalog.allowed` (le hook `useAccess`
interroge déjà permission **et** forfait), et supprimer la bannière redondante quand la raison
du blocage est déjà affichée à côté du bouton.

---

#### CAT-09 · L'écran Prestations est le dernier à afficher « XOF » — **P2**

**Constat.** `src/lib/format.ts` impose une unité unique, « F CFA », et documente pourquoi
(« Le dépôt contenait quatre conventions pour la même somme »). Huit écrans importent
`formatXof`. L'écran du catalogue — précisément celui où l'on fixe les prix — définit son
propre formateur et affiche « XOF » (`services/page.tsx:98-100,302`).

**Impact.** Le même tarif s'affiche « 3 000 XOF » dans Prestations et « 3 000 F CFA » dans
Lavages, Encaissements et Rapports. Ce n'est pas cosmétique : c'est la règle que le dépôt
s'est donnée pour éviter qu'un caissier se demande si les deux montants sont comparables.

**Correctif (≈ 1 heure).** Importer `formatXof` depuis `@/lib/format` et supprimer les
formateurs locaux restants (`services`, `purchases:81`, `cash-drawer`, onboarding). Ajouter
un test de garde : aucun fichier de `src/app` ne doit contenir la chaîne `XOF`.

---

#### CAT-10 · 1 417 lignes de modales mortes, et deux fonctions perdues avec elles — **P2**

**Constat.** `create-wash-modal.tsx` (606 l.), `create-service-modal.tsx` (389 l.),
`create-service-category-modal.tsx` (189 l.) et `create-vehicle-category-modal.tsx` (233 l.)
sont exportées par `src/components/modals/index.ts` mais **importées nulle part** (vérifié par
recherche globale). Les écrans ont été réécrits en dialogues intégrés, sans supprimer les
anciennes modales.

**Preuve de perte fonctionnelle.** L'ancienne modale de prestation gérait la **description**
(`create-service-modal.tsx:163,181,318-326`) et la **suppression** avec confirmation (`:219-241`) ;
la page vivante n'expose ni l'une ni l'autre. Les deux implémentations ont divergé : prix
entier dans la modale morte, décimales dans la page ; nom max 120 dans la modale, 100 dans la
page.

**Impact.** Une double maintenance invisible : un correctif appliqué à la modale ne change
rien à l'écran, et inversement. Les 606 lignes de la modale de lavage donnent par ailleurs une
fausse idée de la surface de test (elle n'est jamais montée).

**Correctif (≈ 2 heures).** Supprimer les quatre fichiers et les exports correspondants —
après avoir repris les deux fonctions utiles (description, suppression) dans les pages
vivantes, sinon la suppression du code mort supprime aussi des fonctionnalités.

---

#### CAT-11 · `vehicle_categories.updated_at` n'existe pas mais est renvoyé — **P3**

`server/db.ts:167-171` ne déclare pas la colonne, `server/api.ts:362,377` renvoie
`created_at AS updated_at`, et le type front la déclare (`vehicle-categories/page.tsx:47`).
Toute logique de cache ou d'affichage « modifié le » serait fausse. **Correctif :** ajouter la
colonne et la mettre à jour au `PATCH` (comme `service_categories:326`), ou retirer le champ
du contrat et du type.

#### CAT-12 · Bornes incohérentes entre interface et serveur — **P3**

Nom de prestation : 100 caractères côté écran (`services/page.tsx:192,323`) contre 120 côté
API (`api.ts:21`) ; la modale morte en autorisait 120. Prix : aucun maximum côté écran, alors
que le serveur refuse au-delà de 1 000 000 F (`api.ts:24`). **Correctif :** un module
`src/lib/catalog-limits.ts` importé des deux côtés, avec le test de dérive déjà utilisé pour
les tarifs (`tests/referentials.test.ts`).

#### CAT-13 · Fonctions d'écran manquantes ou asymétriques — **P3**

Pas de filtre par catégorie ni par statut dans Prestations (seule la recherche existe), pas de
recherche dans Catégories de véhicules (alors que sa jumelle en a une), pas de tri manuel
(ordre alphabétique), pas de pagination, pas d'export du catalogue, pas de duplication d'une
prestation. Aucun de ces manques n'est bloquant sur 10 prestations ; tous le deviennent à 80.
**Correctif :** un lot UI unique (filtres + suppression + recherche véhicules), sans toucher
au modèle.

#### CAT-14 · La description d'une prestation n'est affichée nulle part — **P3**

Acceptée par l'API (`api.ts:22`), présente dans les données de démonstration
(`db.ts:960-1010`), elle n'apparaît ni dans le catalogue, ni dans le sélecteur de caisse, ni
sur le reçu. **Correctif :** l'afficher dans le dialogue (champ texte) et en info-bulle dans
le sélecteur ; sinon retirer le champ, qui laisse croire à une fonctionnalité.

---

### 3.8 Matrice « attendu / livré » du catalogue

| Attendu d'un catalogue de prestations | Livré | État |
|---|---|---|
| Créer / renommer / changer un prix | Oui | ✅ |
| Classer par catégorie | Oui (API + écran) | ✅ mais catégories vides après onboarding (CAT-06) |
| Désactiver sans perdre l'historique | Oui | ✅ |
| Supprimer une entrée créée par erreur | API oui, écran non | ⚠️ CAT-04 |
| Tarif différencié par type de véhicule | Serveur oui, écran non | ❌ CAT-01 / CAT-02 |
| Durée prévisionnelle (chronomètre des tâches) | Oui | ✅ |
| Consommation de stock par prestation | Oui (Pro+) | ✅ |
| Plafond du forfait | Affiché seulement | ❌ CAT-04 |
| Historique des changements de prix | Non | ❌ CAT-03 |
| Unicité / anti-doublon | Partiel | ⚠️ CAT-05 |
| Recherche / filtres | Partiel | ⚠️ CAT-13 |
| Description commerciale | Stockée, jamais affichée | ⚠️ CAT-14 |
| Devise homogène à l'écran | Non | ⚠️ CAT-09 |

### 3.9 Plan de correction proposé

| Lot | Contenu | Effort | Risque | Gain |
|---|---|---|---|---|
| **L1 — cohérence du prix** (CAT-01, CAT-02, CAT-07) | helper de prix partagé + champ « prix par catégorie » + validation des clés + tests | 2 j | faible (chemin existant, non utilisé en prod) | supprime le risque d'encaissement faux |
| **L2 — traçabilité** (CAT-03) | audit des 3 référentiels + 16 libellés manquants + test de couverture | 1 j | très faible | répond à « qui a changé le tarif ? » |
| **L3 — intégrité** (CAT-04, CAT-05) | plafond `max_services`, bouton suppression, unicité insensible à la casse avec déduplication | 1,5 j | moyen (migration d'index sur bases existantes) | nettoie le catalogue, tient la promesse du forfait |
| **L4 — finitions** (CAT-06, CAT-08, CAT-09, CAT-10, CAT-11..14) | catégories par défaut à l'onboarding, `canManage`, devise, code mort, bornes, filtres | 2 j | faible | cohérence perçue, dette réduite |

Ordre recommandé : **L2 puis L1** (tracer avant de toucher aux prix), ensuite L3, puis L4.

---

## 4. Constats transverses (hors catalogue)

### 4.1 Sécurité — P0 documentés, partiellement corrigés

`PLAN-ACTION-PRODUCTION.md` liste dix P0. Deux d'entre eux sont encore ouverts dans le code
de cette version :

- **Jeton de session renvoyé dans le corps de la réponse** (`server/auth-router.ts:289,342`)
  et **recopié en `localStorage`** (`src/lib/api.ts:46-62`), alors qu'un cookie `httpOnly`
  correct est posé en parallèle (`server/auth.ts:158-172`). Le cookie rend le jeton inutile
  côté client : c'est une surface d'XSS gratuite.
- **En-têtes de sécurité incomplets** : `X-Content-Type-Options` et `Referrer-Policy` sont
  posés (`server.ts:23-24`, `vercel-app.ts:115-116`) ; il manque **CSP**, **HSTS** et
  **`X-Frame-Options`/`frame-ancestors`**.

Le reste du socle est solide : scrypt, sessions hachées en base, isolation par organisation
systématique, console éditeur isolée, journal d'audit non modifiable depuis l'interface.

### 4.2 Limites de forfait — trois appliquées sur quatre

`max_sites` (`plan-limits.ts:136-172`), `max_workers` (`team.ts:40`), `max_users`
(`tenant.ts:86`) sont réellement appliqués, avec un raisonnement de rétrogradation
documenté. `max_services` ne l'est pas (CAT-04). La console éditeur n'affiche d'ailleurs que
les trois premiers dans l'usage d'un compte (`server/console-support.ts:267-269`).

### 4.3 Journal d'audit — 16 actions et 7 entités sans libellé

L'écran `/history` affiche le libellé français s'il existe, sinon la clé technique
(`auditActionLabel`, `server/audit-log.ts:77`). Sont écrites mais non traduites :
`wash.status_changed`, `payment.recorded`, `payment.verified`, `schedule.created`,
`schedule.deleted`, `attendance.absence`, `attendance.corrected`, `supplier.created`,
`purchase.created`, `purchase.cancelled`, `stock.moved`, `stock.inventory`, `stock.reversed`,
`service.consumables_updated`, `subscription.payment_declared`,
`subscription.reminder_sent`. Entités non traduites : `work_schedule`, `attendance_record`,
`supplier`, `purchase`, `product`, `stock_movement`, **`service`**. Le détail est en §6.3.

### 4.4 Hors ligne — un prix annoncé peut ne pas être le prix enregistré

Le service worker sert `/api/v1/services` en « réseau d'abord, cache en secours »
(`public/sw.js:58-63,179-196`) : hors connexion, l'écran montre le dernier catalogue connu.
Le lavage mis en file ne porte **pas** de prix : il est tarifé par le serveur au moment du
rejeu (`server/api.ts:676-704`). Si un tarif a changé entre-temps, le prix enregistré diffère
du prix annoncé — sans que personne ne le voie. C'est acceptable comme compromis, mais cela
mérite un mot dans l'interface (et devient plus grave avec CAT-01, puisque l'écart existe
même en ligne).

### 4.5 Documentation — abondante, par endroits en avance sur le code

19 documents, 7 228 lignes, souvent excellents. Trois affirmations sont aujourd'hui démenties
par le code :

- `AUDIT-FONCTIONNEL.md:57-61` : « Catégories de services, catégories de véhicules, prix par
  type de véhicule […] rien à redire ». Le prix par type de véhicule n'a pas d'interface
  (CAT-02) et n'est pas respecté à l'écran (CAT-01).
- `ANALYSE-COMPLETE.md:294` : « CRUD via modals (`create-service-modal`, etc.) ». Ces modales
  ne sont plus montées (CAT-10).
- `ANALYSE-COMPLETE.md:187` décrit le contrat `price_by_vehicle_type` comme une fonctionnalité
  disponible ; elle l'est côté API seulement.

Recommandation : dater chaque affirmation de documentation ou, mieux, transformer les
affirmations vérifiables en tests (le dépôt sait déjà le faire avec `tests/referentials.test.ts`
qui compare la grille publique, le repli affiché et le seed SQL).

### 4.6 Couverture de tests du catalogue

Trois angles morts mesurés :

- `service-categories` : **0** test (aucune occurrence dans `tests/`).
- `price_by_vehicle_type` : **0** test, alors que c'est le seul endroit où le serveur peut
  facturer autre chose que le prix affiché.
- Routes `DELETE` du catalogue : **0** test (les 4 `DELETE` de la suite portent sur d'autres
  ressources), donc le refus `409` « utilisé par un lavage » n'est jamais exercé.

À l'inverse, la fabrication de tests est de très bonne qualité (base en mémoire par fichier,
CI, smoke de bout en bout, tests de dérive de référentiels). Le manque est un manque de
**sujets**, pas de moyens.

---

## 5. Recommandations — synthèse priorisée

| Priorité | Action | Fichiers | Effort |
|---|---|---|---|
| 1 | Tracer les changements de tarif + compléter les 16 libellés d'audit | `server/api.ts`, `audit-log.ts`, `tests/` | 1 j |
| 2 | Rendre le prix par catégorie cohérent **ou** le désactiver côté serveur | `src/lib/service-pricing.ts`, `washes/page.tsx`, `api.ts` | ½–2 j |
| 3 | Exposer l'édition du prix par catégorie (après 2) | `services/page.tsx` | 1 j |
| 4 | Appliquer `max_services` + permettre la suppression | `plan-limits.ts`, `api.ts`, 3 écrans | 1,5 j |
| 5 | Unicité insensible à la casse (avec déduplication) | `server/db.ts`, `api.ts` | ½ j |
| 6 | Catégories de prestations par défaut à l'onboarding | `default-catalog.ts`, `onboarding.ts` | ½ j |
| 7 | `canManage` = `useAccess`, devise unique, suppression du code mort | 3 écrans, `lib/format.ts`, 4 modales | ½ j |
| 8 | Tests : `tests/catalogue.test.ts` (CRUD, 409, RBAC, plafond, prix par véhicule, audit) | `tests/` | 1 j |
| 9 | Retirer le jeton de session du corps de la réponse + CSP/HSTS | `auth-router.ts`, `api.ts`, `server.ts` | ½ j |

---

## 6. Annexe — preuves et commandes

### 6.1 Ce qui a été exécuté

```
npm install --no-audit --no-fund     → 544 paquets
npx tsc -b                           → 0 erreur
npm run lint                         → 0 erreur, 28 avertissements
npm run build                        → OK (dist/ généré puis supprimé)
npm test                             → 858 tests, 858 succès, 0 échec
npm run smoke                        → 69/69 vérifications
```

### 6.2 Expérimentations ciblées

Un fichier de test temporaire (supprimé après usage, aucune trace dans le dépôt) a exercé
l'API réelle en base mémoire. Résultats :

```
[PROBE] total enregistré : 500000 | total affiché par l'écran : 100000
        → prestation price_cents=100000, price_by_vehicle_type[SUV]=500000,
          lavage sur catégorie SUV : le serveur facture 5 000 F, l'écran 1 000 F.

[PROBE] service avec clés fantômes : 201
        → price_by_vehicle_type = { "pas-un-uuid": 999, "<uuid aléatoire>": 42 } accepté.

[PROBE] doublon prestation : 201 201
        → deux services du même nom, deux identifiants.

[PROBE] doublon de casse : 201 201
        → « PROBE Casse » et « probe casse » coexistent.

[PROBE] gérant lecture/écriture catégories : 200 403
        → le gérant lit, ne peut pas écrire ; l'écran, lui, lui montre les boutons.
```

Note au passage : lancé **sans** `NODE_ENV=test`, un fichier de test ouvert par `tsx` écrit
dans la base PGlite persistée (`.data/pglite`). C'est exactement le piège que
`scripts/run-tests.mjs` a été écrit pour éviter (et qui explique la présence de
`.data/` dans `.gitignore`). Toujours passer par `npm test`.

### 6.3 Actions d'audit écrites sans libellé français

```
attendance.absence, attendance.corrected, payment.recorded, payment.verified,
purchase.cancelled, purchase.created, schedule.created, schedule.deleted,
service.consumables_updated, stock.inventory, stock.moved, stock.reversed,
subscription.payment_declared, subscription.reminder_sent, supplier.created,
wash.status_changed
```

Entités sans libellé : `attendance_record`, `product`, `purchase`, `service`,
`stock_movement`, `supplier`, `work_schedule`.

### 6.4 Fichiers principalement examinés pour le catalogue

```
server/db.ts                    (schéma, seed démo, plans, service_catalog)
server/api.ts                   (CRUD catalogue, resolvePrice, création de lavage)
server/onboarding.ts            (confirmation, catégories par défaut, prestations)
server/default-catalog.ts       (catégories de véhicules par défaut)
server/permissions.ts           (matrice RBAC, service:read / service:manage)
server/plan-limits.ts           (limites, max_sites uniquement)
server/audit-log.ts             (libellés d'audit)
server/stock.ts                 (consommables d'une prestation)
src/app/services/page.tsx
src/app/service-categories/page.tsx
src/app/vehicle-categories/page.tsx
src/app/washes/page.tsx
src/components/modals/*.tsx     (dont les quatre modales mortes)
src/lib/format.ts, src/lib/permissions.tsx, src/lib/action-blocking.ts
tests/referentials.test.ts, tests/authorization-api.test.ts, tests/default-catalog.test.ts
AUDIT-FONCTIONNEL.md, ANALYSE-COMPLETE.md, RESTE-A-FAIRE.md, PLAN-ACTION-PRODUCTION.md
```
