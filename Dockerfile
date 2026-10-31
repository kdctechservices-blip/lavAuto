# =============================================================================
# WashPilot CI — image de production
#
# Deux étapes. La première construit l'interface avec tous les outils ; la
# seconde ne garde que ce qui sert à servir l'application. Le résultat ne
# contient ni compilateur, ni serveur de développement, ni fichiers de tests.
#
# Trois choix méritent une explication, parce qu'ils ne sont pas évidents.
#
#   • **Le serveur tourne en TypeScript, via `tsx`.** Le projet ne produit pas
#     de JavaScript : ses `tsconfig` sont en `noEmit` et les imports portent
#     l'extension `.ts`. Compiler aurait demandé de réécrire cette convention
#     partout. `tsx` est donc une dépendance d'exécution, pas un outil.
#
#   • **On lance `node` directement, jamais `npm start`.** Quand `npm` est le
#     processus principal d'un conteneur, l'arrêt demandé par l'hébergeur ne
#     parvient pas toujours au serveur. Celui-ci serait tué net, au milieu
#     d'un encaissement. En invoquant `node`, le signal arrive là où l'arrêt
#     propre est écrit.
#
#   • **L'image ne tourne pas en administrateur.** Une application qui n'a
#     besoin d'écrire nulle part n'a aucune raison d'en avoir le droit.
# =============================================================================

# --- Étape 1 : construction -------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

# Les dépendances d'abord : tant que ces deux fichiers ne changent pas, cette
# couche est réutilisée et la construction prend quelques secondes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Construit l'interface dans `dist/`. Cette commande vérifie aussi les types :
# une erreur de typage arrête l'image ici plutôt qu'en production.
RUN npm run build


# --- Étape 2 : exécution ----------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# `--omit=dev` écarte le compilateur, le serveur de développement et les
# outils de contrôle. `tsx`, lui, est bien installé : il est rangé parmi les
# dépendances d'exécution, puisque le serveur ne démarre pas sans lui.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Uniquement ce qui sert à servir : le serveur, les modules purs qu'il importe,
# et l'interface construite.
#
# `src/config` et `src/lib` ne sont pas là pour l'interface — elle est déjà
# compilée dans `dist/`. Ils sont là parce que **le serveur les importe** : le
# référentiel des véhicules, les catégories de prestations et le calcul du prix
# unitaire sont partagés entre l'API et l'écran, justement pour qu'ils ne
# puissent pas diverger. Les oublier ne casse pas la construction de l'image :
# elle réussit, et le conteneur meurt au démarrage sur un ERR_MODULE_NOT_FOUND
# qui ne dit rien de la vraie cause. `tests/docker-image.test.ts` empêche que
# cela se reproduise.
COPY --chown=node:node server.ts ./
COPY --chown=node:node server ./server
COPY --chown=node:node src/config ./src/config
COPY --chown=node:node src/lib ./src/lib
COPY --from=builder --chown=node:node /app/dist ./dist

USER node
EXPOSE 3000

# L'hébergeur saura ainsi distinguer un conteneur qui démarre d'un conteneur
# en panne. `/healthz` répond dès que le serveur écoute ; `/readyz` attend en
# plus que la base réponde.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "server.ts"]
