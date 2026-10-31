# Basculer la base sur Supabase

WashPilot CI est **100 % PostgreSQL** : aucun stockage d'objets, aucune file
externe, aucune dépendance à un service managé particulier. Basculer sur
Supabase revient donc à changer une variable d'environnement — à trois
conditions près, détaillées ici, qui sont celles qui cassent silencieusement
une isolation multi-station.

## Verdict par brique

| Brique | Supabase | Remarque |
|---|---|---|
| PostgreSQL | ✅ | Postgres 17. Le schéma (58 tables) s'auto-crée au démarrage. |
| Extensions | ✅ rien à faire | `gen_random_uuid()` est natif, `pgcrypto` déjà installé. |
| Rôle applicatif + RLS | ✅ automatique | `postgres` a `CREATEROLE` : `washpilot_app` et les politiques `org_isolation` se posent seuls. |
| Stockage de fichiers | — | Inutilisé : les variables `AWS_*` du `.env.example` ne sont lues par aucun code. |
| Data API / Realtime | — | Inutilisés : l'application parle Postgres en TCP. |
| Supabase Auth | ⚠️ facultatif | Le vérificateur JWT (`server/neon-auth.ts`) accepte déjà les jetons Supabase Auth, mais l'authentification maison reste le mode par défaut. |

## 1. Ne pas réutiliser le `public` d'une autre application

Un projet Supabase héberge **un** schéma `public`. WashPilot y crée 58 tables,
dont plusieurs portent des noms très courants : `organizations`, `customers`,
`payments`, `products`, `expenses`, `stock_movements`, `attendance_records`.
Sur un projet déjà occupé, `CREATE TABLE IF NOT EXISTS` ne créerait rien pour
ces homonymes, puis les `ALTER TABLE … ADD COLUMN` modifieraient les tables de
l'autre application.

→ **Un projet Supabase dédié par application.** (Le plan gratuit limite le
nombre de projets par organisation : libérer un emplacement ou passer au plan
supérieur avant de créer.)

## 2. Choisir la bonne chaîne de connexion

Trois points d'entrée existent ; **un seul est sûr** pour cette application.

| Point d'entrée | Port | Verdict |
|---|---|---|
| **Session pooler** `aws-0-<région>.pooler.supabase.com`, utilisateur `postgres.<ref>` | **5432** | ✅ recommandé — IPv4, état de session conservé |
| Connexion directe `db.<ref>.supabase.co` | 5432 | ✅ mais IPv6 seul sur les projets récents |
| Transaction pooler `aws-0-<région>.pooler.supabase.com` | 6543 | ❌ **à éviter** |

**Pourquoi le mode transaction est exclu.** La garde multi-station
(`server/db-rls.ts`) pose `SET ROLE washpilot_app` et `set_config('app.current_org', …, false)`
au niveau **session**. Un pooler en mode transaction rend la connexion serveur
entre deux requêtes : le rôle et la variable disparaissent. La requête suivante
s'exécute alors hors portée — et une requête d'une autre station peut hériter
du contexte précédent. C'est une fuite de données entre clients, pas une
lenteur.

Le démarrage journalise un avertissement explicite si l'URL détectée est un
pooler transaction (`describeConnection` dans `server/database-target.ts`).

```
postgresql://postgres.<ref>:<mot-de-passe>@aws-0-eu-west-3.pooler.supabase.com:5432/postgres
```

## 3. Fournir l'autorité de certification

Supabase signe ses connexions avec sa propre AC. Sans elle, `pg` refuse :

```
Connection terminated unexpectedly  /  self-signed certificate in certificate chain
```

Téléchargez le certificat depuis le tableau de bord (Settings → Database → SSL
Configuration → *Download certificate*, `prod-ca-2021.crt`), puis :

```bash
# Chemin d'un fichier…
DATABASE_SSL_CA=/chemin/vers/prod-ca-2021.crt
# …ou contenu PEM directement (les \n littéraux sont acceptés)
# DATABASE_SSL_CA=-----BEGIN CERTIFICATE-----\nMIID…\n-----END CERTIFICATE-----
```

La vérification n'est **jamais** désactivée par le code : `rejectUnauthorized`
reste à `true`. Une base qui transporte des encaissements ne se connecte pas
en aveugle.

## 4. Procédure complète

```bash
# 1. Projet dédié créé dans le tableau de bord Supabase (région proche des
#    utilisateurs : eu-west-3 Paris depuis la Côte d'Ivoire).

# 2. Variables
DATABASE_URL=postgresql://postgres.<ref>:<mdp>@aws-0-eu-west-3.pooler.supabase.com:5432/postgres?sslmode=require
DATABASE_SSL_CA=/chemin/vers/prod-ca-2021.crt

# Sur une base réelle, jamais de comptes de démonstration :
SEED_DEMO_DATA=false

# 3. Démarrage : le schéma est créé, les politiques posées.
npm run dev
```

Au premier démarrage, les journaux doivent afficher :

```
[db] Connecté à PostgreSQL via DATABASE_URL
[rls] Isolation multi-station active (rôle washpilot_app, politiques org_isolation).
```

Le second message est le seul qui compte vraiment : s'il est absent, les
politiques protègent les comptes non propriétaires, **pas** le propriétaire des
tables (voir le message d'aide détaillé que le serveur imprime alors).

## 5. Vérifier

```sql
-- Dans l'éditeur SQL Supabase
select count(*) from information_schema.tables where table_schema = 'public';  -- 58
select rolname from pg_roles where rolname = 'washpilot_app';                  -- 1 ligne
select count(*) from pg_policies where policyname = 'org_isolation';           -- une par table de station
select count(*) from organizations;                                            -- 0 : base neuve
```

Puis, côté application : `npm run smoke` (parcours complet inscription →
encaissement → clôture) contre un serveur démarré sur cette base.

## 6. Données existantes

La base embarquée (`.data/pglite`) d'un poste de développement ne contient que
le jeu de démonstration : rien à reprendre. En revanche, si une base réelle a
vécu sur PGlite, il faut un `pg_dump` de ce dossier et un `psql` vers Supabase
**avant** de déclarer la bascule terminée — l'application ne migre pas les
données, elle ne crée que le schéma.

## 7. Retour arrière

Videz `DATABASE_URL` : le serveur repart sur la base embarquée
(`.data/pglite`), intacte. Aucune donnée n'est écrite des deux côtés à la fois.
