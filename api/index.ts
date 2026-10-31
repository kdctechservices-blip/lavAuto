/**
 * Fonction serverless unique de l'API : `/api` et **tout** `/api/...`.
 *
 * Pourquoi un fichier au nom littéral plutôt qu'une route attrape-tout
 * `api/[...slug].ts` : sur Vercel, un nom entre crochets dans `api/` n'est pas
 * traité comme un joker multi-segments. La plateforme ne génère qu'une route
 * d'un seul segment (`/api/healthz`, `/api/v1` répondaient), et tout ce qui est
 * plus profond — `/api/v1/auth/me`, `/api/v1/public/pricing` — tombait sur son
 * 404 générique **sans même appeler la fonction**. C'est précisément la panne
 * constatée en production, invisible en développement puisque `tsx` et Express
 * y reçoivent l'URL d'origine.
 *
 * `vercel.json` déclare donc une réécriture explicite de `/api/...` vers cette
 * fonction, en transmettant le chemin dans `__washpilot_api_path` :
 *
 *   { "source": "/api/:path*", "destination": "/api?__washpilot_api_path=:path*" }
 *
 * `server/vercel-url.ts` reconstitue le chemin à partir de ce paramètre (et de
 * deux autres sources possibles, par prudence).
 *
 * L'import pointe vers le bundle (`npm run build:api`) : le code serveur
 * importe ses voisins en `.ts`, que le runtime de Vercel ne résout pas fichier
 * par fichier.
 */
export { default } from "../server/vercel-bundle.js"
