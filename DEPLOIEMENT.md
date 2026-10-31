# Mettre WashPilot CI en production

> Écrit le 21 octobre 2026. Ce document s'adresse à celui qui installe, pas à
> celui qui développe.

## Le point à comprendre avant tout le reste

**L'application refuse désormais de démarrer en production sans base de
données externe.** Ce n'est pas une limitation, c'est une protection, et elle
a été ajoutée après avoir constaté le contraire sur le code tel qu'il était.

Jusqu'ici, lancée en production sans `DATABASE_URL`, l'application démarrait
très bien — sur sa base embarquée, écrite dans le système de fichiers du
serveur. Tout fonctionnait. On pouvait encaisser pendant des semaines. Puis,
à la première mise à jour du conteneur, ce système de fichiers disparaissait,
et avec lui les lavages, les caisses et les abonnements.

Pire : si `DATABASE_URL` était renseignée mais momentanément injoignable au
démarrage, l'application basculait **silencieusement** sur une base vide. La
station repartait de zéro sans qu'aucune alerte ne soit levée.

Les deux cas se soldent maintenant par un refus net, avec un message qui dit
quoi faire. Un service qui ne démarre pas se remarque ; une base vide, non.

---

## 1. Ce qu'il faut avoir

| | |
| --- | --- |
| Un PostgreSQL | version 14 ou plus, accessible et sauvegardé |
| Un endroit où faire tourner l'application | une machine, un hébergeur de conteneurs, ou Vercel (voir §4 bis) |
| Un nom de domaine en HTTPS | les cookies de session l'exigent en production |

L'application ne stocke aucun fichier : tout vit dans la base. Il n'y a donc
pas de disque à prévoir pour le conteneur, et on peut en lancer plusieurs
derrière un répartiteur — sous une réserve, décrite au §6.

---

## 2. Les variables d'environnement

### Indispensables

| Variable | Rôle |
| --- | --- |
| `NODE_ENV=production` | active le service de l'interface construite et les règles strictes |
| `DATABASE_URL` | `postgres://utilisateur:motdepasse@hôte:5432/base` |
| `APP_URL` | adresse publique, pour les liens des e-mails |
| `CORS_ORIGINS` | la même adresse ; sans elle, le navigateur refusera les appels |

### Pour accéder à la console de l'éditeur

| Variable | Rôle |
| --- | --- |
| `PLATFORM_ADMIN_EMAILS` | adresses des opérateurs, séparées par des virgules |
| `PLATFORM_ADMIN_PASSWORD` | mot de passe initial, lu à la création seulement |

C'est **volontairement** la seule façon de nommer un administrateur de
plateforme : aucune route de l'application ne l'accorde, parce que ce droit
traverse l'isolation entre clients.

### Facultatives

`RESEND_API_KEY` et `MAIL_FROM` pour l'envoi réel des e-mails — sans clé, les
liens sont seulement écrits dans les journaux, ce qui suffit pour une mise en
route. `SUPPORT_WHATSAPP`, `SUPPORT_EMAIL`, `PAYMENT_MERCHANT_NUMBER` et
`PAYMENT_MERCHANT_NAME` alimentent les écrans d'assistance et de paiement.

> **Les secrets s'injectent au démarrage, jamais à la construction.** Un mot
> de passe recopié dans une image se retrouve dans chaque registre, chaque
> sauvegarde et chaque machine qui la télécharge. `.env` est exclu de l'image
> par `.dockerignore`.

---

## 3. Déploiement sur une seule machine

Le chemin le plus court, et celui qui convient à l'éditeur hébergeant
lui-même quelques stations.

```bash
cp .env.example .env
#   renseigner au minimum POSTGRES_PASSWORD, APP_URL et CORS_ORIGINS
docker compose up -d
docker compose logs -f app
```

La base vit dans un volume nommé, indépendant des conteneurs. On peut
reconstruire l'application autant qu'on veut sans y toucher.

```bash
docker compose down      # arrête, conserve les données
docker compose down -v   # DÉTRUIT les données
```

**C'est ce volume qu'il faut sauvegarder.** Rien d'autre sur la machine ne
contient de données clients.

---

## 4. Déploiement chez un hébergeur

L'image se construit et se lance sans la composition :

```bash
docker build -t washpilot-ci .
docker run -d --name washpilot \
  -e NODE_ENV=production \
  -e DATABASE_URL="postgres://…" \
  -e APP_URL="https://app.exemple.ci" \
  -e CORS_ORIGINS="https://app.exemple.ci" \
  -p 3000:3000 washpilot-ci
```

L'image écoute sur le port 3000 et ne tourne pas en administrateur.

### Les deux adresses de surveillance

| Adresse | Répond | À utiliser pour |
| --- | --- | --- |
| `/healthz` | dès que le serveur écoute | savoir si le conteneur est vivant |
| `/readyz` | quand la base répond aussi | savoir s'il peut recevoir du trafic |

Un répartiteur doit interroger **`/readyz`**. `/healthz` répondrait « tout va
bien » pour un serveur incapable de servir une seule page.

### Le schéma se crée tout seul

Au démarrage, l'application crée les tables manquantes et ajoute les colonnes
nouvelles. Il n'y a pas d'étape de migration à lancer à la main, et une mise à
jour ne demande rien de particulier : on remplace l'image, on redémarre.

Corollaire à connaître : **deux versions différentes ne doivent pas démarrer
en même temps sur la même base.** Lors d'un déploiement progressif, laissez
l'ancienne version s'arrêter avant de lancer la nouvelle.

---

## 4 bis. Déploiement sur Vercel (interface et API sur le même domaine)

Vercel ne fait pas tourner de serveur : il sert des fichiers statiques et
exécute des fonctions à la demande. Déployée telle quelle, l'application ne
servait donc **que** l'interface (`dist/`), et chaque appel `/api/v1/...`
retombait sur la page d'accueil : d'où les 404 observés en production.

Le dépôt contient maintenant de quoi servir l'API au même domaine :

| Fichier | Rôle |
| --- | --- |
| `api/index.ts` | la fonction unique : reçoit `/api` **et tout** `/api/...` |
| `server/vercel-app.ts` | la pile Express, identique à celle du serveur classique |
| `server/vercel-url.ts` | reconstitue le chemin, que Vercel ne transmet pas tel quel |
| `scripts/build-api.mjs` | empaquette l'API en un fichier (`npm run build:api`) |
| `vercel.json` | construction, réécriture `/api/*` et SPA, en-têtes, cron des relances |

Trois points méritent d'être connus, parce qu'ils expliquent la conception :

- **Une seule fonction, au nom littéral.** Sur Vercel, un fichier attrape-tout
  `api/[...slug].ts` n'est **pas** un joker multi-segments : la plateforme ne
  génère qu'une route d'un segment. Les chemins courts (`/api/healthz`,
  `/api/v1`) atteignaient bien la fonction ; tout ce qui est plus profond
  (`/api/v1/auth/me`, `/api/v1/public/pricing`, `/api/v1/auth/register`)
  tombait sur le 404 générique de Vercel, **sans même appeler la fonction**.
  C'est la panne constatée en production, et elle est invisible en
  développement puisque `tsx` y reçoit l'URL d'origine. D'où la fonction unique
  `api/index.ts`, et la réécriture explicite de `vercel.json` :

  ```json
  { "source": "/api/:path*", "destination": "/api?__washpilot_api_path=:path*" }
  ```

- **Le chemin est reconstitué.** Une fonction de `api/` ne reçoit pas l'URL
  demandée : la réécriture la remplace par celle de la destination et place la
  suite du chemin dans le paramètre `__washpilot_api_path`. Express, lui, route
  sur l'URL. `server/vercel-url.ts` reconstitue donc le chemin, en acceptant
  aussi `?path=` (paramètre que la plateforme ajoute d'elle-même) et l'URL
  d'origine si elle est transmise intacte. C'est testé
  (`tests/vercel-url.test.ts`) et rejoué de bout en bout par
  `npm run smoke:serverless`, qui simule le cas défavorable — l'URL réécrite —
  et refuse de démarrer si la réécriture disparaît de `vercel.json`.

- **L'API est empaquetée.** Le code serveur importe ses voisins en `.ts`
  explicite (`./db.ts`), ce que `tsx` comprend mais que le runtime de Vercel ne
  résout pas fichier par fichier. `npm run build:api` produit un bundle unique,
  que la fonction de `api/` importe. La construction complète est donc
  `npm run build:vercel`.

### Les variables à renseigner chez Vercel

Dans *Settings → Environment Variables* (cocher **Production** et
**Preview**) :

| Variable | Valeur |
| --- | --- |
| `DATABASE_URL` | la chaîne `postgres://…` fournie par Neon (ajouter `?sslmode=require`) |
| `APP_URL` | `https://<projet>.vercel.app` |
| `CORS_ORIGINS` | la même adresse |
| `PLATFORM_ADMIN_EMAILS` | adresses des opérateurs de la console |
| `PLATFORM_ADMIN_PASSWORD` | mot de passe initial du premier opérateur |
| `CRON_SECRET` | une chaîne aléatoire longue (`openssl rand -hex 32`) |

`NODE_ENV=production` est positionnée par la plateforme. Les variables
d'e-mail (`RESEND_API_KEY`, `MAIL_FROM`) restent facultatives.

**Sans `DATABASE_URL`, l'API ne démarre pas** : c'est la même protection que
pour le conteneur, et elle est visible immédiatement — la sonde `/api/healthz`
répond `200` avec `"database":"unavailable"`, toute autre route répond `503`
avec un message qui nomme la variable manquante. Rien n'est servi sur une base
embarquée : celle-ci n'existe pas sur Vercel, où le disque est en lecture
seule et éphémère.

### Après le premier déploiement

```bash
curl https://<projet>.vercel.app/api/healthz
# {"status":"ok","database":"ready"}

curl -i https://<projet>.vercel.app/api/v1/public/pricing
# 200, Cache-Control: private, no-store
```

Si `/api/healthz` renvoie la page HTML de l'application, la fonction n'a pas
été détectée : vérifiez que le dossier `api/` est bien déployé et que
`vercel.json` est à la racine.

### Les relances d'échéance

Un processus serverless s'endort entre deux requêtes : il ne peut pas porter
de minuteur. `vercel.json` déclare donc un cron quotidien (8 h UTC) sur
`/api/v1/cron/reminders`, que la plateforme appelle avec
`Authorization: Bearer $CRON_SECRET`. Sans `CRON_SECRET`, la route répond
`503` et n'envoie rien — un déclencheur ouvert permettrait d'inonder les
clients d'e-mails.

> Sur l'offre gratuite, le cron ne peut passer qu'une fois par jour. Les
> relances J-3 / J-1 / expiration restent correctes ; elles partent simplement
> une fois par jour au lieu de toutes les heures.

### Vérifier avant de déployer

```bash
npm run smoke:serverless
```

Ce test démarre un serveur qui imite le runtime de Vercel (chemin dans
`req.query.slug`, corps JSON déjà analysé, aucun fichier statique), charge
l'artefact réellement déployé, et rejoue tout le parcours d'encaissement :
inscription, catalogue, caisse, lavage, paiement, reçu, console. C'est le seul
contrôle capable d'attraper une régression de routage avant la production —
`npm run dev` ne le peut pas, puisqu'Express y reçoit l'URL d'origine.

---

## 5. Mise en route de la première station

1. Ouvrir l'adresse publique, créer le compte — l'essai de 14 jours démarre.
2. Se connecter à `/console` avec une adresse déclarée dans
   `PLATFORM_ADMIN_EMAILS`, pour activer l'abonnement quand le client paie.

Le mot de passe de la console n'est lu qu'à la création de l'opérateur :
le changer ensuite dans l'environnement ne change pas le mot de passe réel.

---

## 6. Ce qui n'est pas encore prêt pour plusieurs instances

Honnêtement, et parce que cela se découvre mal en production :

| Point | Conséquence avec deux instances |
| --- | --- |
| Limitation des tentatives de connexion | comptée dans la mémoire de chaque serveur : la protection est divisée par le nombre d'instances |
| Relances d'échéance d'abonnement | chaque instance a son propre minuteur : le client reçoit l'e-mail en double |

Sur Vercel (§4 bis), le minuteur est remplacé par un cron : une seule
invocation planifiée, donc pas de doublon. La limitation des tentatives de
connexion, elle, reste comptée par instance — sur une plateforme serverless,
cela revient à une protection plus faible qu'annoncé.

**Une seule instance ne pose aucun problème**, et c'est amplement suffisant
pour les volumes visés. Avant de passer à plusieurs, il faudra déplacer ces
deux mécanismes hors de la mémoire du processus.

---

## 7. Le contrôle automatique

`.github/workflows/ci.yml` s'exécute à chaque envoi et à chaque demande de
fusion :

1. vérification des types ;
2. vérification du style ;
3. construction de l'interface ;
4. **toute la suite de tests** ;
5. construction de l'image de production ;
6. vérification que le conteneur **refuse** de démarrer sans base.

La dernière étape mérite son existence : c'est exactement le genre de
protection qu'on ajoute un jour et qu'on désactive six mois plus tard sans
s'en apercevoir. Si elle saute, le contrôle échoue.

La suite de tests n'a besoin d'aucun service externe : en mode test, la base
vit en mémoire et chaque fichier repart d'une base vierge.

---

## 8. Sauvegarde

L'application expose déjà un export complet par organisation (voir
`server/backup.ts`), utile pour remettre un client ses données. **Ce n'est pas
une sauvegarde d'exploitation.** Celle-ci se fait au niveau de PostgreSQL :

```bash
# avec docker compose
docker compose exec db pg_dump -U washpilot washpilot | gzip > sauvegarde-$(date +%F).sql.gz
```

À automatiser et à **tester en restaurant**, une sauvegarde jamais restaurée
n'étant qu'une hypothèse.
