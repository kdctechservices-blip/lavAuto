# Analyse complète — WashPilot CI (LAVAUTO)

**Date :** 20 octobre 2026  
**Branche :** `arena/bddec9ba-lavauto` (basée sur `main` commit `33e4cd1 Initial commit`)  
**Auteur de l'analyse :** Agent Arena  
**Contexte :** SaaS multi-tenant de gestion de stations de lavage automobile en Côte d'Ivoire

---

> ## ✅ Mise à jour — les 3 bloquants sont corrigés
>
> | # | Bloquant | État | Détail |
> |---|---|---|---|
> | 1 | `tsc -b` échoue (18 erreurs) | ✅ **Corrigé** | 0 erreur, `npm run build` passe (`dist/` généré). |
> | 2 | `forgot-password` sans backend | ✅ **Corrigé** | `POST /auth/forgot-password` + `GET/POST /auth/reset-password`, jetons à usage unique, page `/auth/reset-password`, transport e-mail Resend. |
> | 3 | KPI dashboard non branchés | ✅ **Corrigé** | Les 4 cartes, le graphique et l'état de caisse viennent de `/reports/summary` et `/cash-sessions/current`, filtrés par la période choisie. |
>
> Vérifications : `npm run build` ✅ · `npm test` **35/35** ✅ · `eslint` 0 erreur sur les fichiers touchés ✅ · flux de réinitialisation testé de bout en bout sur l'API ✅.
> Les détails sont dans [§11 Correctifs appliqués](#11-correctifs-appliqués-20-octobre-2026).

---

## 1. Vue d'ensemble

**WashPilot CI** est une application **SaaS multi-tenant** permettant à chaque organisation (station) de gérer :

- **Stations / Sites** (multi-sites pour le forfait Business)
- **Catalogue** : catégories de prestations, prestations, catégories de véhicules
- **Lavages** : enregistrement avec prix figés, affectation de travailleurs, paiements multi-méthodes (cash, Orange Money, MTN MoMo, Moov Money, Wave, autre)
- **Caisse** : sessions, mouvements manuels, clôture avec écart justifié
- **Dépenses** : par catégorie, avec liaison optionnelle à une session de caisse
- **Équipe** : travailleurs (terrain) + comptes utilisateurs (connexion)
- **Rapports** : synthèse par période, journalier, top services, méthodes de paiement
- **Onboarding guidé** en 5 étapes (station → services → travailleurs → forfait → confirmation)

**Montants** en **F CFA (XOF)**, **stockés en centimes** (`*_cents` entiers) pour éviter toute erreur de virgule flottante.

**Modèle** : un serveur unique sert **API REST `/api/v1`** + **SPA React** (middleware Vite en dev, `dist/` en prod).

---

## 2. Stack technique

| Couche | Techno | Version |
|---|---|---|
| **Frontend** | React, Vite, TypeScript, Tailwind CSS 4, shadcn/ui, React Router 7, Recharts, Framer Motion, React Hook Form + Zod | React 19.3, Vite 8.3, TS 6.0 |
| **Backend** | Express, `tsx` (exécution TS directe) | Express 5.3 |
| **Auth** | Maison : `scrypt` (Node natif), sessions `httpOnly` en PostgreSQL | — |
| **DB** | PostgreSQL (Neon) ; fallback **PGlite** (`@electric-sql/pglite`) si `DATABASE_URL` vide en dev/test | pg 8.23 |
| **State client** | Zustand 5, `useApi` (fetch + `AbortController`) | — |
| **Lint/Build** | ESLint + typescript-eslint, `tsc -b`, `vite build` | — |
| **Tests** | `tsx --test` + `node:test` (zod validators, idempotence, rapports) | 28 tests |

**Taille** : ~5 960 lignes TS/TSX frontend + ~3 361 lignes backend + ~550 lignes SQL (schéma idempotent). Total ~10k LOC applicatives.

```
server.ts            # Express : sécurité headers, CORS, montage routeurs, SPA
server/
  env.ts             # Validation zod des variables d'environnement
  db.ts              # Pool pg + schéma SQL idempotent + seed demo
  auth.ts            # scrypt, sessions cookie httpOnly, requireSession
  tenant.ts          # Résolution tenant (organization + rôle)
  auth-router.ts     # /auth/register, /login, /logout, /me, /profile, /password
  onboarding.ts      # status, progress, summary, confirm, plans, catalogue
  api.ts             # CRUD sites, services, catégories + lavages
  operations.ts      # Sessions de caisse, mouvements, clôture, dépenses
  team.ts            # Travailleurs (/workers) + comptes (/users)
  reports.ts         # Rapports + métriques dashboard
  idempotency.ts     # Clés d'idempotence génériques
src/
  app/               # Pages (landing, auth, onboarding, lavages, caisse, dépenses…)
  components/        # UI shadcn + layouts + guards (OnboardingGate, RootLayout)
  lib/               # Client API (useApi/apiFetch) + types partagés
tests/               # 3 fichiers : idempotency, reports, validators
```

---

## 3. Base de données — schéma

### 3.1 Tables principales

| Table | Rôle | Notes |
|---|---|---|
| `users` | Comptes connexion | `password_hash` scrypt, `organization_id` (legacy), `lower(email)` unique |
| `organizations` | Tenant racine | `onboarding_completed`, `clerk_*` résidus migration |
| `organization_members` | Liaison user ↔ org + rôle | `role` ∈ `owner/manager/cashier`, UNIQUE(user,org) |
| `plans` | Forfaits (free/pro/business) | `max_users/workers/sites/services`, `features jsonb`, seed au démarrage |
| `subscriptions` | Abonnement org → plan | `status` (trialing/active…) |
| `sites` | Stations physiques | `is_active`, city/address/phone/email |
| `onboarding_progress` | Brouillon wizard | `station_data/services_data/workers_data jsonb`, `plan_code` |
| `service_catalog` | Templates onboarding | 9 services pré-remplis |
| `service_categories` | Catégories prestations | UNIQUE(org,name) |
| `vehicle_categories` | Catégories véhicules | UNIQUE(org,name) : Berline, SUV, Moto… |
| `services` | Prestations vendues | `price_cents`, `duration_minutes`, `price_by_vehicle_type jsonb` |
| `workers` | Personnel terrain | `role` (car_washer, moto_washer, team_lead, custom…), `district`, `joined_at` |
| `customers` | Clients (optionnel) | minimaliste (full_name, phone) |
| `washes` | Lavages | `total_cents`, `payment_method/status`, `cancelled_at/reason`, `reference LAV-…` |
| `wash_items` | Lignes prestation figées | `service_name`, `unit_price_cents` copiés au moment de la vente |
| `wash_assignments` | Lavage ↔ travailleurs | N-N |
| `payments` | Paiements (1..N par lavage) | `method`, `amount_cents`, `status` (verified/refunded) |
| `cash_sessions` | Sessions de caisse | `opening_amount_cents`, `closing_amount_cents`, `expected_amount_cents`, `status open/closed` |
| `cash_movements` | Mouvements caisse | `type entry/exit`, `source` (wash_payment, manual, expense) |
| `expenses` | Dépenses | `category` (supply, salary…), `payment_method`, `expense_date`, `cash_session_id` optionnel |
| `idempotency_keys` | Déduplication | `UNIQUE(org,key)` + `fingerprint`, `response_status/body` |
| `auth_sessions` | Sessions auth | `token_hash` (SHA-256), `expires_at`, sliding window |
| `audit_logs` | Piste d'audit | `action`, `entity_type/id`, `metadata jsonb` |

**Indexes** : `idx_sites_org`, `idx_washes_org_created`, `idx_payments_org_created`, etc. + indexes sessions.

### 3.2 Points notables

- **Schéma idempotent** : `CREATE TABLE/INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` — redémarrages sans migration.
- **Seed démo** : si aucun utilisateur `demo@washpilot.ci` n'existe, crée org + user (`WashPilot2026!`), site, 5 prestations, 3 travailleurs, 2 lavages d'exemple, une session de caisse ouverte. Utile pour la démo, mais **à désactiver/conditionner en prod**.
- **PGlite fallback** : si `DATABASE_URL` vide en dev, utilise une base en mémoire. Pratique, mais attention aux divergences SQL (ex: `gen_random_uuid()`).
- **Résidus Clerk** : colonnes `clerk_user_id`, `clerk_org_id`, table `clerk_webhook_events` — héritage d'une ancienne intégration, inutiles aujourd'hui.

---

## 4. Backend — analyse détaillée

### 4.1 `server.ts` (pivot)

- **Sécurité** : `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`; `trust proxy 1`.
- **CORS** : whitelist via `CORS_ORIGINS`, `credentials: true`, expose `Idempotency-Replayed`, autorise `Idempotency-Key`, `X-Session-Token`.
- **Health** : `GET /healthz` (200 ok), `GET /readyz` (503 si DB KO).
- **Middleware** : `express.json(1mb)` + `Cache-Control: private, no-store` sur `/api/v1`.
- **Montage** : `/auth` (public), puis `requireSession` + `requireTenantContext` pour tout le reste, puis routeurs métier, puis 404 JSON, puis **error handler central** :
  - Mappe `HttpError` → status/code/message.
  - Mappe erreurs JSON parse (`entity.parse.failed` → 400), payload trop grand (413), etc.
  - Mappe codes PG : `23505`→409 conflict, `23503`→400, `23514/22P02/22003`→400, `40001/40P01`→503 retry.
  - Logs 500 + warn auth 401/403 en dev.
- **Démarrage** : `initDatabaseSchema()` ; refuse de démarrer en prod sans DB ; mode dev = middleware Vite, mode prod = `dist/` statique + fallback SPA ; **graceful shutdown** (SIGINT/SIGTERM, 10s timeout).

### 4.2 `server/env.ts`

Zod valide `NODE_ENV`, `PORT`, `DATABASE_URL` (optionnel en dev, requis en prod), `PG_POOL_MAX`, `CORS_ORIGINS` (CSV → array). Léger et robuste.

**Amélioration** : ajouter `SESSION_SECRET` si besoin de signer, et `DEMO_SEED_ENABLED`.

### 4.3 `server/auth.ts`

- **Hachage** : `scrypt` Node natif (salt 16 bytes, keylen 64), format `scrypt:<salt_hex>:<hash_hex>`, vérif `timingSafeEqual` — solide.
- **Sessions** : token 32 bytes `base64url`, seul `SHA-256(token)` stocké, TTL 30 jours, **sliding expiration** (refresh à chaque requête).
- **Cookies** : `httpOnly`, `SameSite=None; Secure` si HTTPS (pour iframes) sinon `Lax`, `maxAge` 30j.
- **Triple fallback lecture** : cookie → `Authorization: Bearer` → `X-Session-Token` — nécessaire pour previews iframe où les cookies tiers sont bloqués. Bien pensé.
- **`requireSession`** : 503 si pool absent, 401 si pas de session valide, attache `req.auth`.

### 4.4 `server/tenant.ts`

Résout `organization_members` par `user_id`, attache `req.tenant = { organizationId, userId, role }`. 403 si aucune org.

`assertOrganizationUserCapacity` : verrou advisory `pg_advisory_xact_lock(hashtext(orgId))` + check `max_users` du plan. **Peu utilisé** (seulement potentiellement pour invitations) — pas de route d'invitation active visible.

### 4.5 `server/auth-router.ts`

- **Rate limit** in-memory : 30 tentatives / 15 min par IP (pour `/register`/`/login`). Simple, non distribué (OK pour mono-instance, à remplacer par Redis si multi-instances).
- **`POST /register`** : valide via zod, check email unique, `hashPassword`, crée org + user + `organization_members(owner)` en transaction, crée session, set cookie, retourne `MePayload` + `session_token` (pour fallback Bearer).
- **`POST /login`** : email lower, `verifyPassword`, check `status=active`, crée session.
- **`POST /logout`** : `destroySession` + clear cookie.
- **`GET /me`** : `getSessionUser` → `buildMePayload` (JOIN users + members + org).
- **`PATCH /profile`** : maj first_name/last_name/phone.
- **`POST /password`** : vérif currentPassword + newPassword (min 8 chars).

**Manque** : `forgot-password` n'a pas d'endpoint backend — la page frontend existe mais n'a pas de route API correspondante (TODO).

### 4.6 `server/onboarding.ts`

Stages = `station → services → workers → plan → review`. Validators zod stricts.

Routes :
- `GET /plans` : liste plans triés.
- `GET /service-catalog` : templates actifs.
- `GET /onboarding/status` : `not_started / in_progress / completed` (base `onboarding_completed` + `completed_at`), + `current_stage`, org name, station.
- `GET /onboarding/progress` : renvoie la ligne `onboarding_progress`.
- `PUT /onboarding/progress` : `{ stage, data, plan_code, draft }` ; valide selon stage, upsert JSONB, avance `nextStage`.
- `GET /onboarding/summary` : agrège tout + plan + subscription.
- `POST /onboarding/confirm` (owner/manager) : **transaction** qui matérialise site, services, workers, subscription ; `advisory lock` sur org ; vérifie limites plan ; marque `onboarding_completed = true`.

**Qualité** : très bien structuré, validations métier, idempotent via upsert.

### 4.7 `server/api.ts` (catalogue + lavages)

**Catalogue** :
- `GET/POST /sites` (owner/manager), `PATCH /sites/:id`, `DELETE /sites/:id` (refuse si référencé par washes/sessions/expenses/workers).
- `GET/POST/PATCH/DELETE /service-categories`, `/vehicle-categories` (même pattern, UNIQUE(org,name), 409 si doublon).
- `GET/POST/PATCH/DELETE /services` (vérif `category_id` appartient à l'org, `price_by_vehicle_type` jsonb).

**Lavages** :
- `GET /washes` (filtres status, pagination `page/limit`), `GET /washes/:id` (avec items, assignments, payments).
- `POST /washes` (**idempotent** via `Idempotency-Key` + `fingerprint({op: wash, …input})`) :
  1. Valide `site_id`, `vehicle_category_id`, `items[].service_id` (tout appartient à l'org).
  2. **Prix figés** : copie `service.name` + `price_cents` → `wash_items`; total = Σ(qty × unit_price).
  3. `amount_received_cents` = montant encaissé (peut dépasser total pour rendu monnaie hors scope ?).
  4. Si `payment_method=cash` : exige `cash_session_id` ouverte, crée `payment` + `cash_movement entry`.
  5. Sinon : crée `payment` seule (mobile money → vérification manuelle).
  6. Assigne workers, génère `reference LAV-YYYY-XXXX`, audit log.
- `POST /washes/:id/cancel` : `reason` obligatoire (3..500 chars), marque `status=cancelled`, `payments → refunded`, contre-passation `cash_movement exit` si session d'origine encore ouverte.

**Rôles** : lecture pour tous, création/annulation pour tout rôle authentifié (pas de `requireRole` sur washes — discutable, un `cashier` peut annuler).

### 4.8 `server/operations.ts` (caisse + dépenses)

Validators : `openSession`, `movement` (entry/exit, positive), `closeSession` (counted + reason si écart), `expense` (8 catégories, 6 méthodes paiement).

`SESSION_SELECT` : projection avec `theoretical_balance = opening + entries − exits` via `LATERAL` SUM, et `discrepancy = counted − theoretical`.

Routes :
- `GET /cash-sessions` (filtre status), `GET /cash-sessions/current` (dernière ouverte, option filtre site).
- `POST /cash-sessions/open` (**idempotent**, advisory lock `org+site`, refuse si déjà ouverte pour ce site) → 201.
- `GET /cash-sessions/:id`, `GET /:id/movements`, `POST /:id/movements` (**idempotent**, `FOR UPDATE`, refuse si fermée).
- `POST /cash-sessions/:id/close` : `FOR UPDATE`, calcule écart, exige `discrepancy_reason` si ≠0, `UPDATE status=closed`, audit log.
- `GET /expenses` (200 dernières), `POST /expenses` (**idempotent**, si `payment_method=cash` exige session ouverte, crée `cash_movement exit`), `PATCH /expenses/:id`, `DELETE /expenses/:id` (si cash, contre-passation).

**Qualité** : excellente gestion concurrence (advisory locks, `FOR UPDATE`), logique écart, idempotence.

### 4.9 `server/team.ts`

- `GET /workers`, `POST /workers` (owner/manager, advisory lock + check `max_workers` via plan), `PATCH /workers/:id`, `DELETE /workers/:id` (refuse si wash_assignments).
- `GET /users` : `organization_members JOIN users` (comptes connexion).

### 4.10 `server/reports.ts`

- `GET /dashboard/metrics` : 7 requêtes parallèles (counts by status, total revenue verified, monthly grouped, recent 5 washes). Simple et efficace.
- `GET /reports/summary?from&to` : valide `YYYY-MM-DD`, `from≤to`, ≤366 jours ; 6 requêtes parallèles (`generate_series` journalier, top services, paiements par méthode, dépenses par catégorie).

**Points** : `daily` utilise `created_at::date` (UTC), pas de timezone Côte d'Ivoire (UTC+0 — pas de décalage, donc OK, mais à documenter). `totalRevenue` somme `payments` (verified) sans filtre date dans `/dashboard/metrics` (tout historique), alors que `/reports/summary` filtre par période — incohérence mineure à harmoniser si le dashboard segmente par période.

### 4.11 `server/idempotency.ts`

`stableStringify` (clés triées) → `fingerprint` (SHA-256) → `requireIdempotencyKey` (1..200 chars, pas de contrôle). `withIdempotency` : check existing → conflit (409 si fingerprint différent, replay si même avec header `Idempotency-Replayed`), sinon `INSERT` réserve, exé `handler`, `UPDATE` réponse, `DELETE` si échec (retry possible). **Transaction non atomique** entre réserve et exécution, mais `ON CONFLICT DO NOTHING` + `409 in_progress` gère la concurrence.

Utilisé pour : `POST /washes`, `POST /cash-sessions/open`, `POST /cash-sessions/:id/movements`, `POST /expenses`.

---

## 5. Frontend — analyse détaillée

### 5.1 Structure & routage

- **`src/App.tsx`** : `createBrowserRouter` avec `RootLayout` (HydrateFallback = progress bar), `basename` via `VITE_BASENAME`, `ThemeProvider` + `AuthProvider` + `Toaster` + `initGTM`.
- **`src/config/routes.tsx`** : code-split `page()` (lazy), routes :
  - Public : `/`→`/landing`, `/landing`
  - App : `/dashboard`, `/onboarding`, `/washes`, `/washes/:washID`, `/cash-drawer`, `/expenses`, `/reports`, `/team`, `/services`, `/service-categories`, `/vehicle-categories`
  - Auth : `/auth/sign-in`, `/sign-up`, `/forgot-password`
  - Errors : 5 pages `unauthorized/forbidden/not-found/internal-server-error/under-maintenance` + `*` → 404
  - Settings : `/settings/account`, `/settings/billing` (maquettes, non branchées à un paiement réel)
- **`src/components/router/root-layout.tsx`** : `RootLayout` affiche `Loading` si `!isLoaded`, sinon `Children` ; `OnboardingGate` redirige vers `/onboarding` si `!onboarding_completed`, et `/dashboard` si déjà complété et on va vers onboarding (guard bidirectionnel).
- **`src/components/router/onboarding-gate.tsx`** : logique `useOnboardingStatus` (poll `/onboarding/status`).

### 5.2 Auth frontend (`src/lib/auth.tsx`)

- `AuthProvider` : `fetch /auth/me` au montage + `refresh()`, `signIn`/`signUp` via `postJson` (stocke `session_token` si présent), `signOut` (clear token).
- Triple stockage token : cookie httpOnly (prioritaire) + `localStorage` + mémoire (iframe).
- `useAuth()` hook.

**Qualité** : robuste pour contextes iframe/proxy.

### 5.3 API client (`src/lib/api.ts`)

- `API_BASE_URL` : vide si localhost (proxy Vite `/api`), sinon `VITE_API_BASE_URL`.
- `storeSessionToken`/`getStoredSessionToken()`/`authHeaders()` (double header `Authorization` + `X-Session-Token` pour proxys qui strip Authorization).
- `useApi<T>(path)` : `fetch` avec `AbortController`, `credentials: include`, gère `data/loading/error`, reset si path vide. Réactif mais **pas de cache** (chaque montage refetch).
- `apiFetch(path, opts)` : helper authentifié (injecte token si absent).

### 5.4 Pages principales

#### Landing (`src/app/landing/page.tsx` + 12 components)
Sections : navbar, hero, problem, features, product-demo, gallery, how-it-works, pricing (3 forfaits), FAQ, CTA, footer. Animations `framer-motion`. **Bonne vitrine** mais `images` (`wash-*.jpg`) non optimisées (pas de lazy, pas de WebP).

#### Auth (`sign-in/up`, `forgot-password`)
Formulaires `react-hook-form` + zod. `sign-in` : email/password → `signIn()` → `navigate("/dashboard")` ou `/onboarding`. `sign-up` : firstName/lastName/email/password/phone/orgName → `signUp()`. `forgot-password` : ~~page existe mais pas d'endpoint backend~~ → **✅ corrigé** : formulaire e-mail → `POST /auth/forgot-password`, puis page `/auth/reset-password?token=…` (vérification du jeton à l'affichage, nouveau mot de passe + confirmation).

#### Onboarding (`src/app/onboarding/`)
`OnboardingWizard` : stepper 5 étapes (Station → Services → Workers → Plan → Review), `saveStage.ts` (PUT `/onboarding/progress`), chaque étape a son composant avec validation zod locale + persistance serveur. `ReviewStep` affiche résumé + `POST /onboarding/confirm`.

#### Dashboard (`src/pages/dashboard/index.tsx` + `components/dashboard-metrics.tsx`)

- `DashboardPage` : header personnalisé (station name/city/phone), badges (Vue d'ensemble, Forfait X), bouton Actualiser (key remount), sélecteur période (today/7j/30j), 4 `SummaryCard` (recettes, lavages, dépenses, solde), graphique recettes/dépenses, panneau « État de la station », `DashboardMetrics` (chiffres globaux via `/dashboard/metrics` : donut status, barres mensuelles, table recentWashes), `QuickAction` (liens vers washes/cash/expenses/team).

**✅ Corrigé** : la période pilote désormais `GET /reports/summary?from&to`. Les 4 cartes affichent `revenue_cents`, `completed_washes`, `expenses_cents`, `net_cents` ; le graphique utilise la série `daily` (Recharts `AreaChart`) ; l'export CSV est actif ; l'état de caisse vient de `GET /cash-sessions/current`.

#### Washes (`src/app/washes/page.tsx`, `[washID]/page.tsx`)

- Liste : table filtrable (search, status), pagination, `CreateWashModal` (sélection site, catégorie véhicule, services+qty, workers, paiement, Idempotency-Key via `lib/idempotency`).
- Détail : infos lavage, items, workers, paiements, bouton Annuler (motif).

#### Cash Drawer (`src/app/cash-drawer/page.tsx`)
Liste sessions, `OpenCashSessionModal` (site, opening_amount), détail session (théorique, écart, mouvements), bouton Fermer (counted + raison écart), création mouvement manuel.

#### Expenses (`src/app/expenses/page.tsx`)
Table dépenses, `CreateExpenseModal` (catégorie, montant, méthode, site, beneficiary, description, reference, cash_session si cash).

#### Services / Categories (`src/app/services/page.tsx`, etc.)
CRUD via modals (`create-service-modal`, etc.), tables, toggle `is_active`, delete avec vérif usage.

#### Team (`src/app/team/page.tsx`)
Onglets Workers / Users, `CreateWorkerModal`, table + edit/delete.

#### Reports (`src/app/reports/page.tsx`)
Sélecteur période (from/to), fetch `GET /reports/summary`, affichage KPI (total_washes, revenue, expenses, net), graphique daily (area chart Recharts), tables top_services, payment_methods, expense_categories, export (?) non implémenté.

#### Settings (`account`, `billing`)
`account/page.tsx` : form profil + password (PATCH `/auth/profile`, POST `/auth/password`). `billing/page.tsx` : affichage plan actuel, liste plans, changement (non branché à un paiement — maquette).

### 5.5 Composants partagés

- **UI** : 30+ composants shadcn (`button`, `card`, `dialog`, `table`, `toast`, `sidebar`, etc.), bien typés.
- **Layouts** : `BaseLayout` (SidebarProvider + AppSidebar + SiteHeader + container), `AuthPageLayout` (split branding + form).
- **Modals** : 10 modals CRUD (create-expense, create-service, create-worker, open-cash-session, confirm, edit-site…).
- **Navigation** : `AppSidebar` (navGroups Principal + Configuration, `TrialCountdown` en footer qui poll `/onboarding/summary` et affiche j/h/m/s), `SiteHeader` (breadcrumb, search, theme toggle, user menu), `CommandSearch` (palette).

---

## 6. Tests & qualité

### 6.1 Tests (35, tous passants)

- `idempotency.test.ts` (9 tests) : `stableStringify`, `fingerprint`, `requireIdempotencyKey`.
- `reports.test.ts` (5 tests) : `parseReportRange` (valide, single-day, inverted, malformed, >366j).
- `validators.test.ts` (14 tests) : workers, onboarding station/services/workers, washes create/cancel, catalog service, operations movement/expense.
- `password-reset.test.ts` (7 tests, **ajoutés**) : `buildResetUrl` (URL frontend, `x-forwarded-proto`, encodage du jeton, origine non autorisée ignorée) et `passwordResetMessage` / `isMailerConfigured`.

**Couverture** : uniquement validators pures + helpers — pas de tests d'intégration API, pas de tests E2E, pas de tests composants. Critique pour un flux financier.

### 6.2 Typecheck (`tsc -b`) — ✅ corrigé (0 erreur)

Constat initial : **18 erreurs** bloquaient `npm run build` (TS6133 unused, TS2552, TS18047 possible null) :

```
src/app/services/page.tsx(90,45): vehicleCategoriesLoading déclaré mais jamais lu.
src/app/services/page.tsx(90,81): VehicleCategory introuvable (type non importé).
src/app/services/page.tsx(94,9):  vehicleCategoryById déclaré mais jamais lu.
src/app/services/page.tsx(227,31): services possiblement null (non null-asserté).
...(×3 autres services null)
src/components/modals/create-service-category-modal.tsx(100,62): category possiblement null.
src/components/modals/create-service-modal.tsx(188,60)/(380,29): service possiblement null.
src/components/modals/create-vehicle-category-modal.tsx : 8 erreurs (imports inutilisés, props non utilisées, états morts)
```

**Impact initial** : `npm run build` échouait — déploiement prod impossible (mais `server.ts` tourne via `tsx` sans tsc).

**État actuel** : `tsc -b` → **0 erreur**, `npm run build` génère `dist/` (voir §11.1).

### 6.3 Lint

`eslint.config.js` est configuré (TS, React Hooks, Refresh). `npm run lint` sur tout le dépôt : **1 erreur** (pré-existante, `app-sidebar.tsx:119` — « Cannot call impure function during render », fichier non touché) et 8 warnings `react-hooks/incompatible-library` (le `watch()` de react-hook-form, présent dans tous les modals). **0 erreur sur les fichiers corrigés** — l'erreur `set-state-in-effect` du dashboard a été supprimée.

### 6.4 Vulnérabilités (`npm audit`)

**7 high** (toutes transitives via `shadcn` CLI, non en prod runtime) :
- `braces` ≤3.0.3 (DoS ReDoS) → via `micromatch` → `fast-glob` → `shadcn`/`ts-morph`
- `shadcn` ≤rc-2026… / ≥2.0.0
- `ts-morph` 6–23 / 25–26, etc.

**Fix** : `npm audit fix` propose `shadcn@1.0.0` (major) — à tester, ou `npm overrides` pour `braces`. Pas critique pour la prod (devDependency), mais à corriger pour l'hygiène.

---

## 7. Sécurité — audit

### ✅ Bonnes pratiques

- **Mots de passe** : `scrypt`, salt aléatoire, `timingSafeEqual`.
- **Sessions** : token opaque, hash SHA-256 en base, httpOnly, SameSite None/Lax, Secure si HTTPS, TTL + sliding.
- **Multi-tenant strict** : `organization_id` filtré en SQL, tenant résolu serveur, jamais depuis client.
- **Validation** : zod partout (backend + frontend), messages FR, contraintes prix/qty/durée.
- **Idempotence** : évite double encaissement en cas de retry réseau.
- **Concurrence** : advisory locks + `FOR UPDATE` pour caisse, limites forfait, idempotence.
- **Headers** : `nosniff`, `Referrer-Policy`, `Permissions-Policy`.
- **CORS** whitelist + `private, no-store` sur API.

### ⚠️ Points d'attention

1. **Rate limit in-memory** : non distribué, reset au restart. OK mono-instance, à migrer vers Redis/pg si scale.
2. **Pas de CSRF** : cookie httpOnly mais pas de token CSRF ; `SameSite=Lax/None` + CORS credentials mitige, mais un `Origin` check explicite sur mutations renforcerait.
3. **Aucune 2FA / recovery** : `forgot-password` sans backend — pas de reset par e-mail. Critique pour prod.
4. **RBAC permissif sur washes** : `POST /washes` et `cancel` n'exigent pas `requireRole` — un `cashier` peut annuler. Voulu ? À expliciter.
5. **Seed démo en prod** : si `demo@washpilot.ci` absent, il est créé même si `NODE_ENV=production`. Ajouter garde `NODE_ENV !== production` ou `DEMO_SEED_ENABLED`.
6. **Logs 500** : `console.error` message + stack — OK, mais pas de logger structuré (pino/winston), pas de corrélation request-id.
7. **Dépendances** : 7 highs dev — non critique mais à nettoyer.

---

## 8. Problèmes & dettes détectés

| # | Domaine | Sévérité | Description |
|---|---|---|---|
| 1 | Build | ✅ **Corrigé** | `tsc -b` échouait (18 erreurs) → 0 erreur, `npm run build` passe. |
| 2 | API manquante | ✅ **Corrigé** | `POST /auth/forgot-password` + `GET/POST /auth/reset-password` implémentés. |
| 3 | Dashboard | ✅ **Corrigé** | Les 4 cartes finances sont branchées sur `/reports/summary` (période active). |
| 4 | Dashboard metrics | 🟡 Mineur | Période propagée à `/reports/summary` ; `/dashboard/metrics` (bloc « Indicateurs clés ») reste global — à aligner. |
| 5 | Seed | 🟡 Mineur | Création `demo@washpilot.ci` même en prod. |
| 6 | Pagination | ℹ️ Info | `pageParams` défini mais peu utilisé (reports limit 100/200 hardcodé). |
| 7 | Clerk legacy | ℹ️ Info | Colonnes/tables Clerk inutiles (migration non nettoyée). |
| 8 | Tests | ℹ️ Info | 0 test d'intégration/E2E — couverture métier faible pour flux financiers. |
| 9 | Perf | ℹ️ Info | `DashboardMetrics` + Reports lancent 6-7 requêtes parallèles — OK mais sans cache, refetch à chaque montage. |
| 10 | A11y/i18n | ℹ️ Info | Tout en FR (cohérent), mais pas de `lang="fr"` vérifié sur `<html>`, dates en `fr-FR`/`fr-CI` mélangés. |

---

## 9. Recommandations (roadmap)

### Court terme (avant prod)

1. ~~**Corriger `tsc -b`**~~ → ✅ **fait** (§11.1).
2. ~~**Implémenter `forgot-password`**~~ → ✅ **fait** : table `password_reset_tokens`, envoi Resend, pages dédiées (§11.2).
3. ~~**Brancher Dashboard finances**~~ → ✅ **fait** : `/reports/summary?from&to` piloté par la période (§11.3).
4. **Garder seed démo hors prod** : `if (!isProd || process.env.DEMO_SEED_ENABLED === "true")`.
5. **Harmoniser RBAC** : décider si `cashier` peut annuler ; si non, ajouter `requireRole("owner","manager")` sur `POST /washes/:id/cancel`.
6. **Configurer `RESEND_API_KEY` + `APP_URL`** en production pour que les e-mails de réinitialisation partent réellement.

### Moyen terme

6. **Tests** : ajouter tests d'intégration (supertest) pour `POST /washes` (idempotence, contre-passation), `POST /cash-sessions/close` (écart), `reports/summary` (bornes).
7. **Monitoring** : `request-id` header, logger structuré, `Sentry` pour 500, métriques `pg_stat`.
8. **Sécurité** : `helmet` complet, CSRF si cookies seuls, ou passer en `Authorization` pur et retirer cookies tiers ; rate limit persistant.
9. **Nettoyage** : supprimer colonnes Clerk, `npm audit fix` (ou overrides), optimiser images landing (WebP, lazy).

### Long terme

10. **Paiements** : webhooks Orange/MTN/Wave pour auto-vérifier `payments.status`.
11. **Multi-lang** : `i18next` si expansion hors CI.
12. **Export** : CSV/PDF des rapports (`reports.export` feature flag déjà présent).

---

## 10. Conclusion

**WashPilot CI** est un **projet solide** : architecture propre, multi-tenant rigoureux, gestion financière prudente (centimes, prix figés, idempotence, verrous), onboarding soigné, UI moderne et cohérente. Le backend est **production-grade** sur les flux critiques (caisse, lavages), le frontend est **riche et accessible**, les tests de validators sont présents.

Les **3 points bloquants** identifiés (build TS, forgot-password, KPI financiers du dashboard) ont été **corrigés** (§11). Le reste est de la dette mineure ou des améliorations de scalabilité.

> **Verdict :** 🟢 **Code sain, prêt pour une bêta fermée.** Les 3 correctifs court terme sont appliqués ; reste à configurer `RESEND_API_KEY`/`APP_URL` et à désactiver le seed démo en production.

---

## 11. Correctifs appliqués (20 octobre 2026)

### 11.1 Build TypeScript — `tsc -b` : 18 erreurs → 0

| Fichier | Correction |
|---|---|
| `src/app/services/page.tsx` | Interface `VehicleCategory` ajoutée (type manquant), `vehicleCategoriesLoading` retiré, `services.length` → `servicesList.length` (null-safe via `useMemo`), `vehicleCategoryById` conservé et explicitement référencé pour les tarifs par type de véhicule à venir. |
| `src/components/modals/create-service-category-modal.tsx` | `category!.id` dans la branche `isEditing` (garanti non-null). |
| `src/components/modals/create-service-modal.tsx` | Idem sur `service!.id` (PATCH, DELETE) et dans la `ConfirmModal`. |
| `src/components/modals/create-vehicle-category-modal.tsx` | Le mode édition annoncé par les props était **déclaré mais pas implémenté** (8 erreurs de variables mortes). Il est maintenant réellement câblé : `PATCH /vehicle-categories/:id`, suppression via `ConfirmModal` + `DELETE`, pré-remplissage du formulaire, `onUpdated`/`onDeleted` appelés, `Checkbox` contrôlée (`setValue`/`watch` — `register` ne fonctionne pas avec Base UI). |

Vérification : `npm run build` → `tsc -b` OK puis `vite build` ✓ (`dist/` généré en ~1,2 s).

### 11.2 Mot de passe oublié — flux complet

**Base de données** (`server/db.ts`) : table `password_reset_tokens` (`user_id`, `token_hash` unique, `expires_at`, `used_at`, `requested_ip`) + index. Seul le **SHA-256** du jeton est stocké ; le jeton en clair ne vit que dans le lien.

**`server/auth.ts`** : `createPasswordResetToken()` (invalide les jetons encore actifs de l'utilisateur, TTL configurable), `consumePasswordResetToken()` (UPDATE atomique `used_at IS NULL AND expires_at > NOW() RETURNING user_id`, donc à usage unique même en cas de concurrence), `isPasswordResetTokenValid()` (vérification sans consommation).

**`server/mailer.ts`** (nouveau) : envoi via l'API HTTP Resend avec `fetch` natif — **aucune dépendance npm ajoutée**. Sans `RESEND_API_KEY`, le message est journalisé côté serveur. `passwordResetMessage()` fournit le gabarit texte + HTML.

**`server/auth-router.ts`** :

| Route | Comportement |
|---|---|
| `POST /auth/forgot-password` | Rate-limité, validation zod. **Réponse toujours identique** (compte existant, inconnu ou désactivé) → pas d'énumération de comptes. Hors production et sans fournisseur e-mail, le lien est renvoyé dans `reset_url` pour permettre les tests. |
| `GET /auth/reset-password?token=` | `{ valid: true/false }` sans consommer le jeton (pré-affichage du formulaire). |
| `POST /auth/reset-password` | Consomme le jeton, re-hache le mot de passe (scrypt) et **révoque toutes les sessions** de l'utilisateur. |

`buildResetUrl()` construit le lien depuis `APP_URL`, sinon l'`Origin` si elle est dans la whitelist CORS, sinon l'hôte vu par le serveur (compatible proxy d'aperçu).

**Frontend** : `/auth/forgot-password` devient un vrai formulaire (état de succès, affichage du lien en dev, lien « utiliser une autre adresse ») ; nouvelle page `/auth/reset-password` (vérification du jeton, double saisie, politique `MIN_PASSWORD_LENGTH`, redirection auto vers la connexion). Route ajoutée dans `src/config/routes.tsx` ; `RootLayout` autorise `/auth/reset-password` **même avec une session active** (le flux révoque justement les sessions). Le template mort `forgot-password-form-1.tsx` (anglais, non branché) a été supprimé.

**Configuration** : `APP_URL`, `PASSWORD_RESET_TTL_MINUTES`, `RESEND_API_KEY`, `MAIL_FROM` ajoutés à `server/env.ts`, `.env.example` et au README.

Test de bout en bout exécuté sur l'API (PGlite) : lien généré → jeton valide → mot de passe trop court refusé → réinitialisation OK → **rejeu du lien refusé** → ancien mot de passe refusé (401) → nouveau mot de passe accepté (200).

### 11.3 KPI du dashboard branchés sur l'API

- La période (`today` / `7days` / `30days`) calcule un intervalle local `from`/`to` et pilote `GET /api/v1/reports/summary?from&to`.
- Les 4 cartes affichent les valeurs réelles : recettes (`revenue_cents`), lavages terminés (`completed_washes`, avec le total en sous-titre), dépenses (`expenses_cents`), solde (`net_cents`) — conversion centimes → FCFA, squelettes pendant le chargement, message d'erreur explicite.
- Le bloc « Évolution des recettes » affiche la série `daily` (Recharts `AreaChart`, recettes + dépenses) et retombe sur un état vide honnête quand aucune opération n'existe sur la période. Le bouton **Exporter** (auparavant désactivé) génère un CSV `;` avec BOM, compatible Excel FR.
- « État de la station » : la session de caisse provient de `GET /cash-sessions/current` (badge Ouverte/Fermée + solde théorique) et l'activité récente du résumé de période.
- Le bouton « Actualiser » n'utilise plus `setState` dans un effet (erreur ESLint `react-hooks/set-state-in-effect` supprimée) : l'état est dérivé des requêtes en vol.

---

## 12. Essai gratuit de 14 jours (20 octobre 2026)

Le forfait Gratuit ouvre désormais un **essai de 14 jours** matérialisé par un compte à rebours, puis bascule l'organisation en **lecture seule** : écritures refusées (`402 trial_expired`), export et rapports avancés coupés, historique ramené aux 7 derniers jours, consultation intégrale conservée. Moteur de droits dans `server/entitlements.ts` (fonction pure testée + middlewares globaux), état exposé par `GET /api/v1/subscription`, interface dans `src/lib/subscription.tsx` et `src/components/trial/*`.

→ Détail complet, contrat d'API et procédure de test : **`ESSAI-GRATUIT.md`**.

---

## 13. Audit des 11 fonctions cœur (20 octobre 2026)

Audit complet des fonctions métier essentielles d'une station de lavage, suivi
de la mise à niveau des quatre fonctions défaillantes et des trois fonctions
absentes.

| Fonction | Diagnostic | Suite donnée |
|----------|-----------|--------------|
| Encaissements | Mobile money bloqué en attente, sans route ni écran de confirmation ; paiement partiel impossible | Module `server/payments.ts` (journal, encaissement, confirmation), page `/payments`, encaissement du solde depuis la fiche de lavage |
| Suivi des laveurs | Affectations enregistrées mais jamais exploitées | Classement `top_workers` dans les rapports (écran + CSV) |
| Rapports | Granularité jour uniquement, chiffre d'affaires incohérent avec le tableau de bord | Granularité jour/semaine/mois, définition unifiée du CA, séparation confirmé / à confirmer |
| Lavage sur mobile | Cibles tactiles de 16 px, total invisible en cours de saisie | Cibles 44 px, clavier numérique, barre de total collante, « Appoint exact » |
| Sauvegarde | Absente | Export JSON par station (`/backup/export`), `scripts/db-backup.sh` et `db-restore.sh`, écran Paramètres → Données et sauvegarde |
| Relances d'abonnement | Absentes | J-3, J-1 et échéance, anti-doublon en base, planificateur horaire interne, demande d'activation de forfait |
| Assistance | Absente | Bouton WhatsApp flottant, message pré-rempli (station, forfait, écran) |
| Isolation multi-station | Correcte mais non testée | Suite `tests/tenant-isolation.test.ts` (5 tests sur deux stations réelles) |

Fonctions auditées sans défaut et laissées intactes : catalogue des
prestations, dépenses, contrôle d'accès par rôle. La caisse a reçu une
amélioration indirecte : tout encaissement en espèces y crée désormais son
mouvement.

Couverture de tests portée de **50 à 80 tests**.

→ Détail fonction par fonction, limites assumées et procédure de
vérification : **`AUDIT-FONCTIONNEL.md`**.

---

## 14. Permissions et garde-fous par rôle (20 octobre 2026)

Mise en place d'un contrôle d'accès basé sur les rôles, vérifié par le serveur
à chaque requête.

**Audit préalable.** L'authentification par session et l'appartenance en base
(`organization_members.role`) existaient déjà et ont été conservées : le
nouveau système s'y branche plutôt que de dupliquer un second mécanisme. Deux
faiblesses ont été relevées : `requireRole()` contrôlait le rôle et non
l'action (30 routes), et **aucune lecture n'était gardée** — un caissier
pouvait lire les rapports financiers, un agent de lavage les dépenses.

**Livré.**

| Niveau | Mise en œuvre |
|--------|---------------|
| Référentiel | `server/permissions.ts` : 27 permissions, 4 rôles (`owner`, `manager`, `cashier`, `washer`), refus par défaut, fonctions pures testables |
| Serveur | `requirePermission()` sur **toutes** les routes, lectures comprises ; `requireTenantContext` calcule les droits effectifs et refuse un membre désactivé ; montage extrait dans `server/app.ts` pour que les tests exercent la pile réelle |
| Base | `organization_members.status` (désactivation sans suppression) et `member_permissions` (exceptions accordées par le propriétaire) |
| Interface | `src/lib/permissions.tsx` avec `useAccess(permission, capability)` — un seul appel pour le rôle **et** le forfait ; navigation filtrée ; écran Paramètres → Gestion des accès |
| Données | Cloisonnement financier : sans `report:financial`, dépenses et marge sont renvoyées à `null` par le serveur, pas seulement masquées |

**Garde-fous.** Personne ne modifie son propre rôle (refusé et journalisé) ;
la station conserve toujours un propriétaire actif ; les permissions
sensibles (utilisateurs, paramètres, abonnement, remboursement) ne sont jamais
délégables ; un changement de rôle annule les exceptions ; un encaissement
n'est jamais supprimé mais remboursé avec motif et sortie de caisse.

**Tests** : 80 → **113**, dont 16 tests de bout en bout sur la vraie API qui
vérifient aussi bien les accès autorisés que les tentatives de contournement
par appel direct.

→ Matrice complète, contrat d'API et limites assumées : **`RBAC-PERMISSIONS.md`**.

---

*Généré automatiquement par analyse statique du dépôt `Colorado225/LAVAUTO` — `server.ts`, `server/*.ts`, `src/**/*`, `tests/*`, `package.json`, `vite.config.ts`, `tsconfig.json`. Sections 11 à 14 ajoutées au fil des itérations.*
