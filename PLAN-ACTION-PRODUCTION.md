# Plan d'action — production ready pour un premier essai

WashPilot CI · analyse du 21 octobre 2026 · HEAD `bb8c5b6f`

---

## 1. Verdict

**Le socle est solide, le périmètre est maîtrisé, mais dix points bloquent une mise en production.**

Ce qui distingue ce projet : la sécurité multi-tenant est pensée, pas improvisée. Le SQL est
entièrement paramétré, les opérations multi-écritures sont transactionnelles, les prix sont
recalculés côté serveur, les jetons sont hachés en base, la pile de middlewares est testée
telle qu'elle tourne en production (`server/app.ts:52-107`). 735 tests passent. Un garde-fou
 refuse le démarrage sans `DATABASE_URL` en production. Tout cela est réel, mesuré, et ne
doit pas être cassé par les correctifs qui suivent.

Ce qui bloque, c'est la **couche autour** : l'authentification a trois fuites exploitables
(prise de contrôle de compte via l'en-tête `Host`, énumération de comptes, fuite de jeton par
XSS), la configuration d'environnement ne refuse pas de démarrer en mode dégradé, la suite de
tests peut écrire dans la base de production, et la sauvegarde — qui contient toute la
comptabilité des clients — n'est ni planifiée ni jamais testée.

**Effort estimé pour un premier essai : 7 à 10 jours-homme** (P0 + P1), dont 3 jours de P0
pur. Ce n'est pas un chantier de refonte : ce sont 30 correctifs ciblés, tous localisés.

### Tableau de bord

| Axe | État | Verdict |
|---|---|---|
| Sécurité multi-tenant / cloisonnement | Excellent | 🟢 Aucun défaut d'IDOR trouvé |
| Intégrité de la caisse (transactions, idempotence) | Excellent | 🟢 Verrous `FOR UPDATE` + clé d'idempotence |
| Authentification | **3 failles exploitables** | 🔴 P0-1, P0-4, P0-7 |
| Configuration / durcissement de l'environnement | **Repli silencieux en mode développement** | 🔴 P0-2, P0-3 |
| Continuité de service (sauvegarde) | **Non planifiée, non testée** | 🔴 P0-5 |
| Isolation des tests vs production | **Aucune garantie** | 🔴 P0-10 |
| En-têtes de sécurité HTTP | Absents | 🔴 P0-8 |
| Observabilité & arrêt propre | Correctifs absents | 🟡 P1 |
| Dépendances | Runtime sain (0 vulnérabilité en prod) | 🟢 7 failles `high` = devDependencies only |
| Tests | 735 pass, 0 échec | 🟡 Pas de test de rendu ni d'e2e |
| Documentation | Abondante mais **périmée** | 🟡 P2-8 |
| Expérience terrain (mobile, réseau faible) | Bonne | 🟢 File hors-ligne, reçus, états de blocage |

---

## 2. P0 — Bloquants (à traiter avant la première connexion d'un vrai client)

### P0-1 · Le lien de réinitialisation de mot de passe peut être volé via l'en-tête `Host`

`server/auth-router.ts:124-134`

```ts
const candidates = [
  env.APP_URL,
  req.get("origin") && env.CORS_ORIGINS.includes(req.get("origin") as string)
    ? req.get("origin") : "",
  `${req.get("x-forwarded-proto") || req.protocol}://${req.get("host") ?? "localhost"}`,
]
```

Le troisième candidat se replie sur l'en-tête `Host` de la requête — que **l'attaquant
contrôle**. Avec `trust proxy = 1` (`server.ts:19`), l'en-tête `X-Forwarded-Proto` est également
falsifiable.

**Scénario :** `POST /api/v1/auth/forgot-password` avec `Host: attaquant.ci` → le serveur
envoie au client un e-mail contenant `http://attaquant.ci/auth/reset-password?token=…`. La
victime clique, le jeton arrive chez l'attaquant, qui prend le compte. **Prise de contrôle de
compte complète, sans aucune interaction avec le serveur de production.**

**Correctif :**
1. En production, `APP_URL` est **obligatoire** : refus de démarrer si vide (`server/env.ts`
   → `.refine()` conditionnel sur `NODE_ENV`).
2. `buildResetUrl` ne lit plus `req.get("host")` en production. Le repli sur l'hôte n'existe
   qu'hors production.
3. `x-forwarded-proto` n'est lu que si l'IP du proxy est dans la liste de confiance.

**Critère de recette :** un `POST /auth/forgot-password` avec `Host: attaquant.ci` renvoie un
lien pointant sur `APP_URL`. Un test automatisé le vérifie (voir P1-9).

---

### P0-2 · `NODE_ENV` vaut `development` par défaut : le mode dégradé s'active tout seul

`server/env.ts:4` → `NODE_ENV: z.enum([...]).default("development")`

Un déploiement qui oublie `NODE_ENV=production` démarre en mode développement, ce qui
déclenche **simultanément** quatre garde-fous désactivés :

| Conséquence | Emplacement |
|---|---|
| CORS ouvert à **toutes** les origines, avec `credentials: true` → un site tiers lit les réponses authentifiées | `server.ts:32` |
| Le lien de réinitialisation est renvoyé **dans la réponse HTTP** | `server/auth-router.ts:535` |
| Repli sur PGlite (base embarquée) si `DATABASE_URL` est injoignable | `server/db.ts:1170-1181` |
| Middleware Vite servi, `dist/` ignoré, `allowedHosts: true` | `server.ts:90-96` |

**Correctif :** `NODE_ENV` devient **obligatoire** (pas de défaut). Le serveur refuse de
démarrer avec un message explicite. Idem pour `APP_URL` (P0-1) et `RESEND_API_KEY` (P0-3).
Les comportements « développement » (CORS ouvert, `reset_url` dans la réponse) sont conditionnés
à `NODE_ENV === "development"` **et** à un drapeau explicite, pas à la négation de
`production`.

> Le test de garde-fou de la CI (`ci.yml:69-86`) ne couvre que `DATABASE_URL`. Il faut le
> compléter : `docker run -e NODE_ENV=production` sans `APP_URL` doit échouer.

---

### P0-3 · En production, le jeton de réinitialisation est écrit en clair dans les journaux

`server/mailer.ts:24-30`

```ts
if (!isMailerConfigured()) {
  console.info(`[mail] Aucun fournisseur configuré … sujet : ${message.subject}`)
  console.info(`[mail] Contenu :\n${message.text}`)   // ← contient l'URL de reset
  return false
}
```

Il n'y a **aucune** condition `NODE_ENV` ici. Le garde de `auth-router.ts:535` ne protege que la
réponse HTTP, pas les journaux.

**Scénario :** en production, `RESEND_API_KEY` n'est pas configuré (oubli de déploiement,
ou quota épuisé). Chaque demande de réinitialisation écrit dans stdout le lien complet. Les
logs d'un conteneur sont accessibles à l'opérateur d'hébergement, à l'aggregateur de logs, à
un membre de l'équipe support — et à quiconque les lit. Chaque lien lu = un compte repris.

**Correctif :**
1. En production, `RESEND_API_KEY` est obligatoire (refus de démarrer), ou à défaut le
   transport devient un no-op **silencieux** : jamais le corps du message.
2. Le contenu du message n'est jamais journalisé, quelle que soit la plateforme. Journaliser
   le destinataire et l'objet suffit.
3. `MAIL_FROM` : le défaut `onboarding@resend.dev` (sandbox partagé) doit être interdit en
   production — `env.ts` le rend obligatoire en `production`.

---

### P0-4 · Énumération de comptes + canal temporel sur le login + oracle de token

Trois fuites distinctes, à corriger ensemble (elles servent le même objectif : empêcher de
distinguer « ce compte existe » de « ce compte n'existe pas »).

**(a) Inscription — énumération par le code HTTP** · `server/auth-router.ts:229-239`
`409 email_exists` → « Un compte existe déjà avec cette adresse e-mail. »

**(b) Login — canal temporel** · `server/auth-router.ts:315-324`

```ts
const valid = row ? await verifyPassword(password, row.password_hash) : false
```

`scrypt` (≈100 ms) n'est exécuté **que** si le compte existe. Un attaquant mesure le temps de
réponse et confirme l'existence d'une adresse en quelques essais.

**(c) Validation de jeton — oracle** · `server/auth-router.ts:546-558`
`GET /api/v1/auth/reset-password?token=…` → `{ "valid": true|false }`, **sans rate limit**.
C'est un oracle de validation qui permet de tester des jetons.

**Correctif :**
- (a) Réponse générique : « Si cette adresse correspond à un compte, vous recevrez un
  e-mail. » → `202`, jamais `409`. Le cas « compte déjà existant » est traité côté serveur
  (on n'envoie pas de second e-mail).
- (b) Exécuter un `scrypt` sur un hash factice quand le compte est absent, pour que le coût
  soit identique. Même règle que `server/console-auth.ts` l'applique déjà.
- (c) Supprimer l'endpoint public, ou le protéger par le rate limit et ne jamais révéler plus
  que « ce lien est-il encore valable » — ce qui est déjà le cas. Le vrai correctif est le
  rate limit (P0-6) + la suppression pure et simple de l'endpoint (le client peut afficher
  « lien expiré » sur un POST raté).

---

### P0-5 · La sauvegarde de la base n'est ni planifiée ni jamais testée

`scripts/db-backup.sh` et `scripts/db-restore.sh` existent et sont corrects
(`set -euo pipefail`, confirmation interactive). Mais rien ne les déclenche, et
`DEPLOIEMENT.md:187-199` le dit lui-même : « à automatiser **et à tester** ».

**Scénario :** la base Neon est corrompue, ou supprimée par erreur, ou le compte est résilié
faute de paiement. Toute la comptabilité des stations clientes (lavages, encaissements, journal
d'audit, présences) est **perdue, sans aucune copie**. Un premier essai avec 5 clients payants
expose déjà leur comptabilité entière à un incident de ce type.

**Correctif (P0) :**
1. Un `pg_dump` quotidien planifié (cron de l'hôte ou `systemd timer`), avec rétention 30 j
   et **copie hors site** (bucket objet ou second hébergeur). Un dump sur le même disque que
   la base est annulé par le même incident.
2. Alerte en cas d'échec du dump (le job échoue = alerte, pas de silence).
3. **Un test de restauration exécuté au moins une fois avant la mise en production**, sur une
   base jetable, avec vérification du nombre de lignes. C'est le critère de recette.

**Critère de recette :** restauration complète d'un dump de staging sur une base neuve,
comptages de lignes comparés, procedure consignée dans `DEPLOIEMENT.md`.

---

### P0-6 · Le rate limit est en mémoire, par IP, et contournable

`server/auth-router.ts:27-47` — `Map` en mémoire, 30 tentatives / 15 min, clé = `req.ip`.

**Trois failles :**
1. **Contournable :** `trust proxy = 1` (`server.ts:19`) alors que l'application est exposée
   directement → `X-Forwarded-For` falsifiable → l'attaquant change d'IP à chaque essai.
2. **Non partagé :** le `Map` est perdu au redémarrage et n'est pas partagé entre instances.
3. **Par IP seulement :** une attaque distribuée sur un même compte n'est jamais bloquée.
   Le verrouillage par cible (adresse e-mail) manque.

**Correctif :** store partagé (table PostgreSQL — le projet a déjà `pg` et une base, aucune
nouvelle dépendance nécessaire), clé composite `ip + email`, fenêtre glissante persistante.
Ajuster `trust proxy` selon le déploiement (0 si l'app est exposée directement, la liste des IP
de confiance derrière un proxy).

---

### P0-7 · Le jeton de session est renvoyé dans le corps de la réponse et stocké en `localStorage`

**Serveur :** `server/auth-router.ts:289` (register) et `:342` (login) renvoient
`session_token: token` dans le JSON. **Client :** `src/lib/api.ts:32-40` le persiste dans
`localStorage` (`washpilot.session-token`), et `src/lib/api.ts:42-45` l'envoie **en plus** du
cookie sur chaque requête.

**Scénario :** une seule injection XSS (un message de station affiché sans échappement, un
champ de remarque, une réponse d'API mal traitée) suffit à lire `localStorage` et à voler la
session — y compris celle d'un **opérateur de la console** (`src/console/api.ts:31` fait la même
chose). Le cookie `httpOnly` ne protège plus de rien, puisque le jeton est lisible par le
JavaScript.

**Correctif :**
1. Ne plus renvoyer `session_token` dans le corps en production (garder l'iframe de
   développement, qui est la raison d'être documentée du mécanisme).
2. Côté client : ne persister le jeton **qu'en mémoire**, jamais en `localStorage`. Le cookie
   `httpOnly` suffit ; le chemin `Authorization: Bearer` reste disponible pour l'aperçu iframe
   sans persistance.
3. `server/auth.ts:183-201` : `readSessionToken` accepte `Authorization: Bearer` et
   `X-Session-Token` — à restreindre au mode développement si l'iframe n'est plus un besoin.

---

### P0-8 · Aucun en-tête de sécurité HTTP : ni CSP, ni HSTS, ni anti-clickjacking

`server.ts:21-26` ne pose que `X-Content-Type-Options`, `Referrer-Policy` et
`Permissions-Policy`. La SPA est servie par le même serveur que l'API, et cette API encaisse
de l'argent.

**Correctif :** ajouter `helmet` avec une CSP stricte (l'application n'a pas besoin de
`unsafe-eval` hors développement) et :
- `Content-Security-Policy` avec `frame-ancestors 'none'` (ou la liste des origines autorisées
  si la console doit être intégrable en iframe),
- `Strict-Transport-Security` (activé seulement derrière HTTPS),
- `X-Frame-Options: DENY` / `frame-ancestors` en remplacement,
- `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`.

---

### P0-9 · Un crash silencieux laisse le processus dans un état indéfini

`server.ts` n'installe **aucun** `process.on("uncaughtException")` ni
`process.on("unhandledRejection")`.

Le planificateur de relances (`server/reminders.ts:302-304`) et les écritures détachées de la
supervision lèvent des promesses en arrière-plan. Une rejection non gérée sur Node 26 **termine
le processus** par défaut — sans la trace structurée ni l'arrêt propre (fermeture de la base,
`SIGTERM` gestionnaire) mis en place pour le reste.

**Correctif :** handlers qui journalisent la pile complète et sortent en code 1, en laissant le
`shutdown` propre s'exécuter.

---

### P0-10 · La suite de tests peut écrire dans la base de production

`server/db.ts:1141-1168`

```ts
if (env.DATABASE_URL) {
  const externalPool = new Pool({ connectionString: env.DATABASE_URL, … })
  await externalPool.query("SELECT 1")
  await externalPool.query(schemaSql)
  pool = externalPool; ready = true; return true      // ← aucun test sur NODE_ENV
}
```

`NODE_ENV=test` ne change **que** l'emplacement du repli PGlite
(`server/pglite-location.ts:67`). Si `DATABASE_URL` est présente dans l'environnement, la
suite de tests s'y connecte et y écrit : organisations, utilisateurs, lavages, mouvements de
caisse, points de présence — **dans la base de production**.

**Constaté sur ce poste :** le `.env` local (gitignoré, donc invisible dans le dépôt) pointe
vers `ep-small-dream-…c-7.eu-central-1.aws.neon.tech` — la base Neon de production. Les tests
ne chargent pas `.env` (`dotenv/config` n'est importé que par `server.ts`, jamais par `tests/`),
donc aujourd'hui ils sont isolés **par accident**, pas par conception. Il suffit qu'un
développeur exporte `DATABASE_URL` dans son shell, qu'un `dotenvx` soit ajouté, ou qu'un
`tsx --env-file=.env` apparaisse dans un script, pour que la suite vide la base des clients.

**Correctif (garde-fou, à faire avant toute autre chose) :** dans `initDatabaseSchema`, refuser
`DATABASE_URL` quand `NODE_ENV === "test"` — ou, mieux, introduire une variable dédiée
`TEST_DATABASE_URL` et ne jamais réutiliser celle de la production. Le refus doit être explicite
et bruyant, pas silencieux.

**Critère de recette :** `DATABASE_URL=<prod> NODE_ENV=test npm test` échoue immédiatement avec
un message clair, et n'écrit aucune ligne.

---

## 3. P1 — Majeurs (à traiter dans les deux semaines suivant le premier essai)

| # | Constat | Emplacement | Correctif |
|---|---|---|---|
| **P1-1** | `/readyz` renvoie `ready` alors que la base est morte après le démarrage (booléen figé au boot) → l'orchestrateur ne voit pas la panne | `server.ts:46-55`, `server/db.ts:43` | `SELECT 1` avec timeout dans `/readyz` |
| **P1-2** | `restart: unless-stopped` ne redémarre pas sur `unhealthy` → l'app reste dégradée (500 en série) | `docker-compose.yml:44` | `pg_isready` + sortie non nulle, ou orchestrateur avec autoheal |
| **P1-3** | Le tableau de bord affiche des chiffres **globaux** alors qu'il est piloté par période | `src/components/dashboard-metrics.tsx:101` appelle `/api/v1/dashboard/metrics` sans `from`/`to` ; `server/reports.ts:68-95` ne filtre pas sur la période | Propager la période au endpoint de métriques — **sinon le gérant lit un chiffre différent de celui du rapport** |
| **P1-4** | Le service worker ne purge jamais ses caches (`VERSION = "v1"` constante) → les téléphones de station accumulent des versions périmées, et un shell HTML obsolète peut casser l'app après déploiement | `public/sw.js:38-41` | Inyecter la version (hash du build) dans le nom du cache au build + stratégie `update` |
| **P1-5** | `.gitignore` ne couvre que `.env`, `.env.local`, `.env.*.local` → un `.env.production` ou `.env.staging` est committé **avec ses secrets** | `.gitignore:1-5` | `.env*` puis `!.env.example` |
| **P1-6** | `npm test` sans `NODE_ENV=test` → les 45 fichiers de tests se partagent la base PGlite **sur disque**, se contaminent et la corrompent (constaté : base `.data/pglite` inutilisable après un `npm test`) | `package.json:10` | `"test": "NODE_ENV=test tsx --test tests/*.test.ts"` — et le garde-fou P0-10 |
| **P1-7** | `PGLITE_DATA_DIR` pointe sur `.data/pglite` par défaut, sans volume Docker → les données de développement disparaissent à chaque `up --build` | `docker-compose.yml:30-31` | Volume nommé `.data/pglite` |
| **P1-8** | Le port de l'application est publié sur **toutes** interfaces de l'hôte, en HTTP clair, sans reverse proxy dans la pile | `docker-compose.yml:66-67` | `127.0.0.1:${APP_PORT:-3000}:3000` par défaut ; TLS à-terminer devant |
| **P1-9** | Aucun test ne couvre les regressions de sécurité identifiées (lien de reset via `Host`, énumération, canal temporel) | `tests/` | Ajouter `tests/auth-security.test.ts` — chaque correctif P0 doit venir avec son test |
| **P1-10** | Aucune vérification d'e-mail à l'inscription : une adresse peut être squattée avant que le vrai client ne s'inscrive (le compte créé appartient alors à l'attaquant, l'e-mail de réinitialisation lui part) | `server/auth-router.ts` | Confirmation d'e-mail par lien à usage unique avant activation du compte |
| **P1-11** | Les relances d'échéance tournent par `setInterval` dans chaque instance → double e-mail dès qu'on passe à 2 instances | `server/reminders.ts:302-304` | Verrou advisory PostgreSQL autour du tick, ou planification externe |
| **P1-12** | `docker-compose.yml` : mot de passe PostgreSQL injecté **brut** dans l'URL `postgres://user:pass@…` → un `@`, `:` ou `%` casse l'URL avec un message trompeur | `docker-compose.yml:55` | `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` |
| **P1-13** | Aucune vérification d'e-mail : la console opérateur et les comptes de station n'ont pas de mechanism d'expiration de mot de passe | `server/console-auth.ts` | Rotation possible du mot de passe console (aujourd'hui lu **seulement à la création**, `DEPLOIEMENT.md:5`) |
| **P1-14** | Vite en développement écoute sur `0.0.0.0` avec `allowedHosts: true` → tout appareil du réseau local atteint le dev server, qui proxie l'API réelle | `vite.config.ts:21-31` | `host: "127.0.0.1"`, `allowedHosts: ["localhost"]` |
| **P1-15** | `scripts/local-db.mjs` importe `embedded-postgres`, absent de `package.json` → le script plante au lancement | `scripts/local-db.mjs:8` | Ajouter la dépendance ou supprimer le script |
| **P1-16** | Écart de version Node : **22** en CI et dans l'image Docker, **26.7** en local, `@types/node ^26` → le typecheck valide contre des API absentes du runtime | `ci.yml:32`, `package.json:54` | `.nvmrc` = 22, `engines.node` = `22.x`, `@types/node ^22` |
| **P1-17** | `docker-compose` n'a ni limite de logs (le `json-file` grossit sans fin), ni `mem_limit`/`cpus`, ni `read_only`, ni `cap_drop` | `docker-compose.yml` | Bloc `logging` + `security_opt` |
| **P1-18** | `express.static(distPath)` sans `maxAge` → les assets hachés (`dist/assets/*-[hash].js`) sont revalidés à chaque chargement ; le cache-busting ne sert à rien | `server.ts:101` | `maxAge: "1y", immutable` sur `/assets`, `no-cache` sur `index.html` et `sw.js` |
| **P1-19** | Le planificateur et les écritures détachées n'ont pas de `request-id` / log structuré → un incident est difficile à reconstituer | `server/monitoring*.ts` | `request-id` par requête, logs JSON |
| **P1-20** | `GET /dashboard/metrics` fait 6 requêtes parallèles à chaque montage, sans cache ni debounce | `server/reports.ts:83-95` | Cache court (30 s) + invalidation sur écriture |

---

## 4. P2 — Mineurs et dette

| # | Constat | Emplacement | Correctif |
|---|---|---|---|
| **P2-1** | `clerk_webhook_events` : table morte d'un ancien système d'authentification, plus des colonnes `clerk_user_id` / `clerk_org_id` | `server/db.ts:741`, `server/db.ts:58` | Supprimer (migration) |
| **P2-2** | Table `customers` non utilisée et `washes.customer_id` jamais alimenté | `server/db.ts` | Supprimer, ou acter la décision « on suit le véhicule » |
| **P2-3** | `POST /support/upgrade-request` est une route orpheline — le bouton existe, le résultat est invisible | `server/support.ts:138` | Brancher ou supprimer |
| **P2-4** | `@electric-sql/pglite` (35 Mo) est une dépendance **de production** alors qu'elle est inatteignable en production | `package.json:20` | `devDependencies` ou `npm prune` ciblé dans le Dockerfile |
| **P2-5** | `cn` est une dépendance de production au nom générique (risque de typosquatting), utilisée dans 20+ composants | `package.json:26` | Remplacer par un `src/lib/utils.ts` local (`clsx` + `tailwind-merge`) |
| **P2-6** | `bun.lock` **et** `package-lock.json` sont suivis → un développeur sous bun obtient un arbre de dépendances différent de la CI | racine | Ne garder que `package-lock.json` |
| **P2-7** | `.env.example` enseigne de mauvaises habitudes : `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION` ne sont lues par **aucun** module | `.env.example:1-4` | Supprimer les variables mortes |
| **P2-8** | **La documentation est périmée et se contredit.** `RESTE-A-FAIRE.md` §2 et §4, `ANALYSE-COMPLETE.md` (entièrement), `WORKFLOW-PAIEMENT.md` (toutes les URL `/admin` sont fausses — la console est sous `/console`), `AUDIT-BACK-OFFICE.md` §4, `AUDIT-FONCTIONNEL.md` §12.1/§12.3 | voir §6 | Réécrire autour des seuls points ouverts |
| **P2-9** | Volumétries fausses dans tous les documents : « 28 / 35 / 113 / 152 / 161 / 189 / 209 / 377 / 617 tests » → **735** ; « 27–28 permissions » → **36** ; « 23 tables » → 30+ | tous les docs | Corriger une fois pour toutes |
| **P2-10** | La stratégie de schéma `CREATE TABLE IF NOT EXISTS` ne sait pas changer un type de colonne ni poser une contrainte ; toute évolution de schéma est manuelle | `server/db.ts:56-791` | Outillage de migration versionné (table `schema_migrations`) |
| **P2-11** | `server/db.ts:406` : `ALTER TABLE expenses ALTER COLUMN site_id DROP NOT NULL` — **vérifié : idempotent** (PostgreSQL ne lève pas d'erreur sur une colonne déjà nullable). Pas de correctif nécessaire | `server/db.ts:406` | — (signalé par erreur dans un premier audit) |
| **P2-12** | Inputs `type="number" step="any"` sur les montants et quantités — le franc CFA n'a pas de subdivision, un champ décimal invite à la saisie de centimes | `src/app/washes/page.tsx:773` | `step="1"` + validation stricte (le serveur refuse déjà les montants hors entier) |
| **P2-13** | Le reçu est déjà correct pour du papier **80 mm** (72 mm imprimables, `@page { size: 80mm auto }`) — ce qui manque est le **réglage 58 / 80 mm par station** demandé par le métier | `src/components/receipt/wash-receipt.tsx:119`, `src/index.css:536-580` | Exposer le format dans les réglages de station et faire varier la largeur `@page` |
| **P2-14** | Aucun test de rendu de composant (`jsdom` / `@testing-library` absent) → un `MenuGroupContext is missing` avait pu passer | `tests/` | Ajouter l'outillage de test de rendu (la contrainte « aucune nouvelle dépendance » doit être rediscutée) |
| **P2-15** | `public/sw.js` : `skipWaiting()` + `clients.claim()` → une page ancienne peut être servie par un SW nouveau (versions mélangées) | `public/sw.js:66,76` | Activation différée |
| **P2-16** | Le cache API du SW est par origine : sur un téléphone partagé, le catalogue d'une station reste lisible après changement de session | `public/sw.js:52-57` | Inclure le tenant dans la clé de cache |
| **P2-17** | `npm audit` remonte 7 failles `high` — **toutes en `devDependencies`** (via `shadcn` → `fast-glob`/`micromatch`/`braces`). `npm audit --omit=dev` → **0 vulnérabilité**. Le runtime de production est sain | `package.json:65` | `overrides: { "braces": "^3.0.4" }` + `npm audit --omit=dev --audit-level=high` en CI |
| **P2-18** | Scripts npm manquants : `typecheck`, `audit`, `docker:build`, `docker:up` | `package.json:6-13` | Les ajouter |
| **P2-19** | Le planificateur de relances écrit dans la base même quand la session de caisse n'est pas concernée ; la purge de la file hors-ligne n'existe pas | `server/reminders.ts`, `src/lib/offline-queue.ts` | Purge automatique après N jours + alerte sur file bloquée |
| **P2-20** | Erreur ESLint 0, mais 21 warnings `react-refresh/only-export-components` | `eslint.config.js` | Ne pas bloquer ; corriger au fil de l'eau |
| **P2-21** | `index.html` : la balise `apple-mobile-web-app-capable` a été remplacée par `mobile-web-app-capable`. La seconde est la balise standard (Chrome/Android) mais **la première est la balise spécifique à iOS Safari** : le mode « application autonome » (écran d'accueil, sans barre de navigateur) est perdu sur iPhone | `index.html:26` | **Conserver les deux balises** — la standard *et* l'Apple — pour couvrir iOS et Android |
| **P2-22** | Le `.env` local de ce poste pointe sur la **base Neon de production** (`ep-small-dream-…c-7.eu-central-1.aws.neon.tech`). Toute commande qui charge `dotenv` (`npm run dev`) écrit donc en production | `.env` (gitignoré) | Un `.env.development` pointant sur une base **de développement** séparée, et un `.env.example` qui le documente |

---

## 5. Arbitrages produit (décision de l'éditeur requise)

Ces points ne sont pas des défauts techniques : ce sont des choix produits dont l'absence
bloque un réglage commercial. **Ils n'empêchent pas le premier essai**, mais ils doivent être
tranchés avant d'ouvrir la vente.

| # | Question | Options | Impact si non tranché |
|---|---|---|---|
| **A-1** | **Encaissement des abonnements** : le parcours est 100 % manuel (l'éditeur valide depuis la console). Brancher un agrégateur (CinetPay / PayDunya) ? | (a) manuel au lancement, webhook plus tard ; (b) webhook maintenant | Sans (a), chaque client paie par mobile money puis attend une validation manuelle → friction et image de marque dégradée. Le code du webhook est déjà prévu (`server/checkout.ts:13`) |
| **A-2** | **Remboursement** : l'endpoint `POST /payments/:id/refund` et l'interface existent (`src/app/payments/page.tsx:46`). Reste-t-il une limite (plafond, rôle) ? | (a) propriétaire seul ; (b) gérant aussi | Un litige au comptoir sans issue. **Le functionality est déjà là** |
| **A-3** | **Conformité FNE/RNE** : le reçu actuel n'est pas une facture normalisée (ni TVA, ni numéro fiscal, ni QR). Le produit affiche un reçu non opposable | (a) assumer et le dire ; (b) intégrer l'API FNE | Risque réglementaire si le reçu est présenté comme une facture |
| **A-4** | **Vérification d'e-mail** à l'inscription (P1-10) | activer / différer | Squattage d'adresse avant inscription du vrai client |
| **A-5** | **WhatsApp** pour les notifications client (reçu, rappel d'échéance) | (a) e-mail seul ; (b) WABA Meta | Budget + validation Meta (délai long) → ne pas bloquer le lancement sur ce point |
| **A-6** | **Tailles de papier du reçu** : 58 / 80 mm, réglage par station | (a) 80 mm seul ; (b) réglage | Imprimantes thermiques portables : réglage par station |
| **A-7** | **Sélecteur de station pour un propriétaire multi-sites** | (a) un rôle par organisation, pas de sélecteur ; (b) sélecteur | `RBAC-PERMISSIONS.md §10` l'assume ; le besoin n'est pas confirmé |

---

## 6. Corrections d'analyse (faux positifs vérifiés)

Pour que la prochaine analyse ne reparte pas de zéro sur des points déjà tranchés :

- **`ALTER TABLE … DROP NOT NULL` n'est pas un bug** — vérifié sur PostgreSQL : c'est un no-op
  idempotent, pas une erreur au second déploiement. (`server/db.ts:406`)
- **Le caissier ne peut pas annuler un lavage** — `wash:cancel` n'est **pas** dans la liste
  `cashier` (`server/permissions.ts:170-184`). `ANALYSE-COMPLETE.md §7 #4` est périmé.
- **Le remboursement existe déjà** — endpoint, permission et interface. `AUDIT-FONCTIONNEL.md`
  est périmé sur ce point.
- **Aucune injection SQL** — vérifié : aucun identifiant ni valeur utilisateur n'est
  interpolé dans une chaîne SQL. Tout est paramétré.
- **Les transactions sont correctes** — lavage, achat, dépense, caisse, remboursement sont
  chacun dans un `BEGIN/COMMIT/ROLLBACK` avec `FOR UPDATE` ou `pg_advisory_xact_lock`.
- **Le runtime de production n'a aucune vulnérabilité npm** — les 7 `high` viennent de
  `shadcn` (devDependency).
- **Le cloisonnement multi-tenant est bon** — aucune fuite trouvée : l'organisation vient
  toujours de la base, jamais du client, et les routes d'écriture verrouillent la ligne.
- **Les tests ne touchent la base de production que par accident** — `.env` n'est pas chargé
  par `tests/` (seul `server.ts` importe `dotenv/config`). C'est une chance, pas une
  conception : P0-10 transforme cette chance en garantie.
- **Le `.env` local de ce poste pointe sur la base Neon de production** — `npm run dev` y écrit
  dès qu'il démarre. À corriger avant toute manipulation de données de développement.

---

## 7. Plan d'exécution

### Semaine 1 — P0 (3 jours)

1. **P0-10, en premier de tous : garde-fou « les tests n'écrivent jamais en production ».**
   Une ligne de code, et elle protège toute la comptabilité des clients.
2. P0-2 + P0-1 : `NODE_ENV` obligatoire, `APP_URL` obligatoire, `buildResetUrl` sans repli sur
   `Host`. *(Ces deux-là touchent le même fichier : `server/env.ts` + `server/auth-router.ts`.)*
3. P0-3 : `RESEND_API_KEY` obligatoire en production + ne jamais logger le corps d'un message.
4. P0-4 : énumération (register), canal temporel (login), suppression de l'oracle de token.
5. P0-6 + P0-5 : rate limit partagé (table SQL) ; backup planifié + **test de restauration**.
6. P0-7 : ne plus renvoyer le jeton en JSON en production ; arrêt du `localStorage`.
7. P0-8 : `helmet` + CSP + HSTS.
8. P0-9 : handlers `uncaughtException` / `unhandledRejection`.
9. Écrire `tests/auth-security.test.ts` (P1-9) **en même temps** que les correctifs.

### Semaine 2 — P1 (3 à 4 jours)

10. P1-1, P1-2, P1-18 : santé réelle, reprise sur `unhealthy`, cache des assets.
11. P1-3 : période sur `/dashboard/metrics` — **corriger avant le premier client**, un chiffre
    faux dans un tableau de bord est la source numéro un de tickets support.
12. P1-4, P1-6, P1-7 : version du service worker, script de test, volume PGlite.
13. P1-5, P1-8, P1-12, P1-14 : hygiène `.gitignore`, exposition réseau, URL de base de données,
    Vite en local.
14. P1-10, P1-11 : vérification d'e-mail, verrou du planificateur.
15. P1-16 : alignement de la version Node (`.nvmrc`).
16. P2-17, P2-18, P2-21 : `npm audit --omit=dev` en CI, `overrides`, scripts manquants,
    balises iOS + Android.

### Semaine 3 — documentation et arbitrages (1 à 2 jours)

17. Réécrire `RESTE-A-FAIRE.md` sur les seuls points ouverts (voir §6). Ranger
    `ANALYSE-COMPLETE.md` en archive.
18. Corriger `WORKFLOW-PAIEMENT.md` (`/admin` → `/console`, 10 occurrences).
19. Trancher A-1 à A-7 en réunion produit ; consigner les décisions.

---

## 8. Checklist de mise en production (à exécuter le jour J)

**Avant le premier client**

- [ ] `NODE_ENV=production` défini **explicitement** (pas de défaut) — et le serveur refuse de démarrer sans
- [ ] `DATABASE_URL` pointant vers PostgreSQL/Neon, `ssl` vérifié, garde-fou PGlite actif
- [ ] `APP_URL` défini (https) — vérifié par un test : le lien de reset pointe bien dessus
- [ ] `RESEND_API_KEY` + `MAIL_FROM` (domaine réel, pas `onboarding@resend.dev`) — **un e-mail de test
      doit être reçu par une vraie adresse**
- [ ] `CORS_ORIGINS` = l'URL publique exacte, pas `*`
- [ ] `PLATFORM_ADMIN_EMAILS` renseigné (sinon la console est fermée) + mot de passe opérateur changé
- [ ] TLS terminé en amont (reverse proxy), `trust proxy` aligné sur la topologie réelle
- [ ] Sauvegarde : job planifié actif, **une restauration testée** avec succès, copie hors site
- [ ] Alerte de disponibilité branchée sur `/readyz` (et `/readyz` corrigé — P1-1)
- [ ] `npm run build` + `npm start` sur l'image Docker, smoke test : inscription → lavage →
      encaissement → reçu imprimé
- [ ] Un vrai téléphone Android, réseau 3G dégradé : enregistrement d'un lavage hors-ligne puis
      reconnexion
- [ ] `helm`/CSP ne casse pas l'application (parcours complet rejoué)
- [ ] Version Node de la production = 22 (alignée sur la CI)
- [ ] **Le `.env` de développement ne pointe pas sur la base de production** (P2-22) — sinon
      `npm run dev` écrit chez les clients
- [ ] `DATABASE_URL=<prod> NODE_ENV=test npm test` **échoue** (garde-fou P0-10 installé)

**Avant le deuxième client**

- [ ] Supervision : `request-metrics` et incidents consultables, `request-id` dans les logs
- [ ] Procédure d'astreinte écrite (qui appelle, qui redémarre, qui restaure)
- [ ] Procédure de rotation des mots de passe console
- [ ] Sauvegarde : premier dump automatique réussi et vérifié

---

## 9. Ce qu'il ne faut pas casser

Ces acquis ont été vérifiés et sont le cœur de la valeur du produit. Toute correction doit les
préserver — un test de non-régression existe déjà pour la plupart.

- **Cloisonnement multi-tenant** : l'organisation vient de la base, jamais du client ; les
  écritures verrouillent la ligne (`FOR UPDATE`) et filtrent par `organization_id`.
- **Transactions** : chaque opération multi-écritures est atomique. Ne jamais « simplifier » un
  `BEGIN/COMMIT/ROLLBACK` en une suite de requêtes.
- **Idempotence** : `withIdempotency()` + `Idempotency-Key` sur tous les écrans d'argent. Le
  rejeu renvoie la réponse stockée. C'est ce qui permet de rejouer une file hors-ligne sans
  double encaissement.
- **Recalcul serveur des prix** : le client ne peut jamais imposer un prix. Le total est
  recalculé depuis le catalogue (`server/api.ts:631`).
- **Montants entiers en centimes** : jamais de flottant, jamais de décimale.
- **Refus explicites** : la culture du « refus plutôt que du silence » (permission, forfait,
  état de l'écran) est la différence entre un logiciel fiable et un logiciel qui perd de
  l'argent. Ne pas l'assouplir.
- **Ordre des middlewares** : session → appartenance → abonnement → permission → capacité
  (`server/app.ts:52-107`). L'ordre entre rôle et forfait est délibéré.
- **Tests** : 735 tests, 0 échec. Chaque correctif P0/P1 apporte son test.
