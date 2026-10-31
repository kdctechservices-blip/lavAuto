# WashPilot CI 🚿🚗

Application SaaS **multi-tenant** de gestion de stations de lavage auto en Côte d'Ivoire :
enregistrement des lavages, caisse (sessions, mouvements, clôture), dépenses, équipe,
rapports d'activité et onboarding guidé. Montants en **F CFA (XOF)**, stockés en centimes.

## Stack

| Couche | Technologies |
|---|---|
| Frontend | React 19 · Vite · TypeScript · CoreUI (Console) · Tailwind CSS 4 · shadcn/ui · React Router 7 · Recharts |
| Backend | Express 5 (exécuté via `tsx`), API REST `/api/v1` |
| Authentification | Maison : e-mail + mot de passe (scrypt), sessions httpOnly stockées dans PostgreSQL |
| Base de données | PostgreSQL ([Neon](https://neon.tech)) — schéma auto-créé au démarrage |

Un seul serveur sert l'API **et** la SPA (middleware Vite en développement, `dist/` en production).

## Démarrage rapide

```bash
# 1. Dépendances
npm install

# 2. Environnement
cp .env.example .env     # puis complétez DATABASE_URL

# 3. Développement (API + frontend sur http://localhost:3000)
npm run dev
```

### Scripts

| Commande | Description |
|---|---|
| `npm run dev` | Serveur de développement (Express + Vite middleware) |
| `npm run build` | Typecheck (`tsc -b`) + build frontend (`vite build`) |
| `npm start` | Serveur (en production : servir `dist/`, build préalable requis) |
| `npm test` | Suite complète, base en mémoire (voir ci-dessous) |
| `npm run smoke` | Test de fumée de bout en bout sur un serveur jetable |
| `npm run lint` | ESLint |
| `npm run console:password -- <email>` | Définit le mot de passe d'un opérateur de console |
| `npm run db:purge-stations` | Simulation : liste les comptes de station qui seraient effacés |
| `npm run db:purge-stations -- --yes` | Efface les comptes de station (console et forfaits conservés) |

### Tests

`npm test` lance `scripts/run-tests.mjs`, et non `tsx --test` directement. Ce
script force `NODE_ENV=test`, ouvre une base **en mémoire** par fichier de tests
et ignore `DATABASE_URL` : sans cela, la suite écrivait dans la base de
développement (`.data/pglite`), la polluait et échouait par centaines de
raisons sans rapport avec le code testé. Il développe aussi la liste des
fichiers lui-même, ce qui fonctionne sous Windows comme sous Linux :

```bash
npm test                              # toute la suite
npm test -- tests/format.test.ts      # un fichier
npm test -- --test-name-pattern=timeline
```

`npm run smoke` démarre son propre serveur (port libre, base en mémoire), joue
le parcours complet — inscription, configuration, catalogue, forfait,
confirmation — puis un encaissement de bout en bout (caisse, lavage, paiement,
reçu, remboursement, clôture) et les actions de la console. Rien ne survit au
processus, donc aucune donnée réelle n'est touchée :

```bash
npm run smoke
npm run smoke -- --base-url http://localhost:3000   # contre un serveur déjà lancé
```

`db:purge-stations` sert à repartir d'une base vierge avant une mise en
production : elle supprime les organisations, leurs utilisateurs et toutes
leurs données, ainsi que les opérateurs de console désactivés. Les opérateurs
actifs, les forfaits et le catalogue de prestations sont conservés. Arrêter le
serveur avant de la lancer si la base est la base embarquée (PGlite), et
renseigner `SEED_DEMO_DATA=false` pour que la station de démonstration ne
réapparaisse pas au démarrage suivant.

## Configuration

Variables d'environnement (voir [`.env.example`](.env.example)) :

- `DATABASE_URL` — connexion Neon/PostgreSQL. **Obligatoire en production.**
  Sur Supabase, utilisez le pooler en **mode session** (port 5432), jamais le
  mode transaction (6543) : voir [`SUPABASE.md`](SUPABASE.md).
- `DATABASE_SSL_CA` — autorité de certification à faire confiance quand
  l'hébergeur signe avec sa propre AC (Supabase). Chemin d'un `.crt` ou
  contenu PEM.
- `CORS_ORIGINS` — origines frontend autorisées (séparées par des virgules).
- `APP_URL` — URL publique utilisée pour construire les liens envoyés par e-mail.
- `PASSWORD_RESET_TTL_MINUTES` — validité d'un lien de réinitialisation (défaut `60`).
- `RESEND_API_KEY` / `MAIL_FROM` — envoi des e-mails transactionnels via Resend.
- `PLATFORM_ADMIN_EMAILS` — adresses des opérateurs de la console de
  l'éditeur (`/console`), séparées par des virgules. Les comptes sont créés au
  démarrage. **Vide = console entièrement fermée.**
- `PLATFORM_ADMIN_PASSWORD` — mot de passe posé sur les comptes d'opérateur
  **créés** au démarrage. Ne réécrit jamais un mot de passe existant.
- `MONITORING_ALERT_INTERVAL_MINUTES` — cadence des alertes de surveillance.
  Leurs seuils et destinataires sont réglés dans la Console.
- `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` /
  `WHATSAPP_ALERT_TEMPLATE` — alertes WhatsApp Cloud par modèle approuvé.
- `RECONCILIATION_ENABLED` / `RECONCILIATION_PROVIDER` /
  `RECONCILIATION_STATEMENT_URL` / `RECONCILIATION_STATEMENT_TOKEN` —
  connecteur planifié facultatif de relevé d'agrégateur. L'import CSV/JSON
  manuel dans `/console/rapprochement` fonctionne sans ces variables.
- `NEON_AUTH_JWKS_URL` / `NEON_AUTH_ISSUER` / `NEON_AUTH_AUDIENCE` — accepte en
  plus des sessions maison les jetons JWT de Neon Auth (facultatif, voir
  [`NEON-AUTH.md`](NEON-AUTH.md)). Vide = fonctionnalité éteinte.

> L'authentification ne dépend d'aucun service externe : les comptes (mot de passe
> haché scrypt) et les sessions (cookies httpOnly, table `auth_sessions`) vivent
> dans la base PostgreSQL/Neon. Neon Auth, quand il est configuré, ne fait
> qu'ajouter une porte d'entrée : il ne remplace ni les comptes ni les rôles.

> **Mot de passe oublié.** `POST /auth/forgot-password` crée un jeton à usage unique
> (seul son SHA-256 est stocké dans `password_reset_tokens`) et envoie le lien par
> e-mail. Sans `RESEND_API_KEY`, le lien est journalisé côté serveur ; **hors
> production uniquement**, il est aussi renvoyé dans la réponse pour faciliter les
> tests. La réponse est toujours identique, qu'un compte existe ou non.

## Architecture

```
server.ts            # Express : sécurité, CORS, montage des routeurs, SPA
server/
  env.ts             # Validation zod des variables d'environnement
  db.ts              # Pool pg + schéma SQL idempotent (CREATE/ALTER IF NOT EXISTS)
  auth.ts            # Hachage scrypt, sessions cookie httpOnly, middleware requireSession
  tenant.ts          # Résolution du tenant (organisation + rôle) de l'utilisateur
  auth-router.ts     # /auth/register, /auth/login, /auth/logout, /auth/me, /auth/profile,
                     # /auth/password, /auth/forgot-password, /auth/reset-password
  mailer.ts          # E-mails transactionnels (Resend via fetch, journalisation sinon)
  onboarding.ts      # Assistant : status, progress, summary, confirm, plans, catalogue
  api.ts             # CRUD sites, services, catégories + lavages (création idempotente, annulation)
  operations.ts      # Sessions de caisse, mouvements, clôture, dépenses
  team.ts            # Travailleurs (/workers) + comptes (/users)
  reports.ts         # Rapports d'activité + métriques du dashboard
  idempotency.ts     # Clés d'idempotence génériques (rejeu avec Idempotency-Replayed)
src/
  app/               # Pages (landing, auth, onboarding, lavages, caisse, dépenses, …)
  components/        # UI (shadcn) + layouts + gardes de routes
  lib/               # Client API (useApi/apiFetch) + types partagés
tests/               # Tests unitaires (node:test via tsx)
```

### Principes de l'API

- **Multi-tenant strict** : chaque requête SQL filtre par `organization_id`, le tenant est
  résolu côté serveur depuis la session — jamais depuis le navigateur.
- **Rôles** : `owner` / `manager` / `cashier` (stockés dans `organization_members`).
- **Idempotence** : `POST /washes`, `/cash-sessions/open`, `/cash-sessions/:id/movements` et
  `/expenses` exigent l'en-tête `Idempotency-Key`. Un rejeu renvoie la réponse d'origine avec
  l'en-tête `Idempotency-Replayed: true` ; une réutilisation avec un contenu différent → `409`.
- **Limites de forfait** : `max_workers` / `max_users` imposés sous verrou advisory PostgreSQL.
- **Argent** : entiers en centimes de XOF (`*_cents`), jamais de flottants.
- **Tout passe par la base** : chaque fonctionnalité écrit et relit ses lignes ; le
  tableau de correspondance et le contrôle automatique sont dans
  [`BASE-DE-DONNEES.md`](BASE-DE-DONNEES.md) (`tests/database-wiring.test.ts`).

### Endpoints principaux (`/api/v1`, session requise sauf `/auth/*` publics)

| Domaine | Routes |
|---|---|
| Auth | `POST /auth/register` · `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `PATCH /auth/profile` · `POST /auth/password` |
| Onboarding | `GET /onboarding/status` · `GET/PUT /onboarding/progress` · `GET /onboarding/summary` · `POST /onboarding/confirm` · `GET /plans` · `GET /service-catalog` |
| Catalogue | CRUD `/sites`, `/services`, `/service-categories`, `/vehicle-categories` |
| Lavages | `GET /washes` · `GET /washes/:id` · `POST /washes` (idempotent) · `POST /washes/:id/cancel` |
| Caisse | `GET /cash-sessions` · `GET /cash-sessions/current` · `POST /cash-sessions/open` · `GET/POST /cash-sessions/:id/movements` · `POST /cash-sessions/:id/close` |
| Dépenses | `GET/POST /expenses` |
| Équipe | `GET/POST /workers` · `PATCH /workers/:id` · `GET /users` |
| Rapports | `GET /reports/summary?from&to` · `GET /dashboard/metrics` |
| Notifications | `GET /notifications` · `POST /notifications/:id/read` · `POST /notifications/read-all` |

## Flux métier clés

1. **Inscription → Onboarding** : l'inscription crée le compte **et** son organisation,
   puis l'assistant en 5 étapes (station → services → travailleurs →
   forfait → confirmation) persiste chaque étape côté serveur ; `POST /onboarding/confirm`
   matérialise le tout (site, services, travailleurs, abonnement) en une transaction.
2. **Lavage** : prix recopiés depuis le catalogue au moment de l'enregistrement
   (`service_name`/`unit_price_cents` figés dans `wash_items`) ; un paiement espèces exige
   une session de caisse ouverte et génère un mouvement d'entrée.
3. **Caisse** : solde théorique = ouverture + entrées − sorties ; la clôture exige la
   justification de tout écart.
4. **Annulation de lavage** : motif obligatoire, paiements marqués `refunded`, contre-passation
   en caisse si la session d'origine est encore ouverte.
5. **Reçu de lavage** : format thermique 80 mm imprimé par le navigateur, un reçu
   par lavage (prestations, règlements, solde restant). Toute réimpression porte
   la mention DUPLICATA et laisse une trace. Ce n'est **pas** un reçu normalisé
   de la DGI — voir [`RECU-LAVAGE.md`](RECU-LAVAGE.md).
6. **Abonnement** : essai de 14 jours à l'inscription, puis lecture seule à
   l'expiration. Le client demande l'activation depuis l'application
   (`POST /support/upgrade-request`) ; l'éditeur encaisse hors application et
   valide — ou décline — depuis la console `/console`. Voir
   [`BACK-OFFICE.md`](BACK-OFFICE.md).

## Console de l'éditeur

Application **séparée**, servie sous `/console` dans la coquille CoreUI :
suivi du parc, registre des encaissements avec exports comptables,
rapprochement des relevés et file d'écarts, recherche de comptes, assistance
avec notification du client, alertes sortantes e-mail/WhatsApp et gestion des
opérateurs avec rôles `admin` / `supervisor` / `support` (lecture seule).

```bash
# .env — puis redémarrer le serveur
PLATFORM_ADMIN_EMAILS=vous@exemple.ci
PLATFORM_ADMIN_PASSWORD=UnMotDePasseLongEtUnique
```

Les comptes sont **créés automatiquement** au démarrage et vivent dans leur
propre table, `platform_operators`, sans aucun lien avec les comptes de
station : ni le même mot de passe, ni la même session, ni la même durée (2
jours contre 30). Retirer une adresse de la liste ne désactive que son compte
**d'amorçage** et coupe ses sessions au redémarrage suivant.

Le mot de passe posé par `PLATFORM_ADMIN_PASSWORD` ne sert qu'à l'amorçage.
Ensuite, un administrateur crée les comptes, change leurs rôles, réinitialise
leurs mots de passe et révoque leurs sessions depuis **Console → Opérateurs**.
Le script `npm run console:password -- vous@exemple.ci` reste un recours de
secours (serveur arrêté avec PGlite), voir `BACK-OFFICE.md` §2.

**Aucune passerelle depuis le produit** : rien dans l'application station ne
mentionne la console — pas d'entrée de menu, pas de lien, pas de redirection —
et un test échoue si `/console` apparaît hors de `src/console/`. Le serveur
répond `404`, et non `403`, à toute requête de console sans opérateur valide :
pour qui sonde l'application, la console n'existe pas.

Le créateur **n'a pas besoin d'exploiter une station** : la console ne réclame
ni organisation, ni abonnement, ni parcours de mise en service.

Détail des décisions, des routes et des tests : [`BACK-OFFICE.md`](BACK-OFFICE.md).

### Encaisser un abonnement

Le client ouvre une **intention de paiement** depuis son tableau de bord
(`POST /subscription/checkout`), reçoit une référence courte à mentionner lors
du transfert mobile money, paie, puis déclare sa transaction. Une déclaration
n'active rien : vous validez en un clic depuis `/console/paiements`, l'intention portant
déjà le forfait, la durée et le montant.

Les trois déclencheurs d'activation prévus — validation manuelle, webhook
d'agrégateur, rattrapage — convergent tous sur `activateSubscription()`
(`server/subscription-service.ts`). Brancher CinetPay ou PayDunya revient donc
à écrire un adaptateur, sans rien réécrire.

Le **rapprochement** est un contrôle distinct de l'encaissement : il compare
références et montants d'un relevé CSV/JSON (ou du connecteur planifié) aux
lignes de `subscription_payments`. Une ligne payée mais absente du registre
ouvre un écart ; elle n'active jamais l'abonnement d'elle-même.

Workflow complet, pièges d'intégration et ordre recommandé :
[`WORKFLOW-PAIEMENT.md`](WORKFLOW-PAIEMENT.md).

## Mise en production

Le guide complet est dans **[`DEPLOIEMENT.md`](DEPLOIEMENT.md)**. L'essentiel
tient en trois points.

**Une base PostgreSQL externe est obligatoire.** En `NODE_ENV=production`,
l'application refuse de démarrer sans `DATABASE_URL`, et refuse de se rabattre
sur la base embarquée si cette base est injoignable. C'est délibéré : un
démarrage silencieux sur PGlite donnerait une application parfaitement
fonctionnelle, qui encaisserait pendant des semaines puis perdrait tout au
premier redéploiement.

**Le plus court chemin**, pour héberger soi-même quelques stations :

```bash
cp .env.example .env     # renseigner POSTGRES_PASSWORD, APP_URL, CORS_ORIGINS
docker compose up -d
```

**Surveillance** : un répartiteur doit interroger `/readyz`, qui attend que la
base réponde. `/healthz` dirait « tout va bien » d'un serveur incapable de
servir une page.

**Sur Vercel**, l'interface et l'API vivent sur le même domaine : les fonctions
de `api/` exécutent la même pile Express, la base est un PostgreSQL hébergé
(Neon), et les relances passent par un cron plutôt que par un minuteur. Tout
est décrit au §4 bis de `DEPLOIEMENT.md` ; `npm run smoke:serverless` rejoue le
parcours complet contre un imitateur du runtime Vercel avant chaque envoi.

### Contrôle automatique

`.github/workflows/ci.yml` vérifie à chaque envoi les types, le style, la
construction, **toute la suite de tests**, puis construit l'image et vérifie
qu'elle refuse bien de démarrer sans base.
