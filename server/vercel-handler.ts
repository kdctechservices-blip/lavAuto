/**
 * Point d'entrée **du bundle** des fonctions serverless.
 *
 * Ce fichier n'est jamais exécuté tel quel : `npm run build:api` l'envoie à
 * esbuild, qui produit `server/vercel-bundle.js`. Les fonctions de `api/`
 * importent cet artefact et rien d'autre.
 *
 * Pourquoi un bundle intermédiaire plutôt qu'un simple import de
 * `server/vercel-app.ts` : tout le code serveur importe ses voisins avec
 * l'extension `.ts` explicite (`./app.ts`, `./db.ts`…), ce que Node ne sait pas
 * résoudre à l'exécution. En développement, `tsx` s'en charge ; sur Vercel,
 * chaque fichier de `api/` est transpilé isolément et l'import resterait en
 * `.ts` → « Cannot find module ». Le bundle règle la question une fois pour
 * toutes, indépendamment de la stratégie de compilation de la plateforme.
 */
import type { IncomingMessage, ServerResponse } from "node:http"

import { handleServerlessRequest, type ServerlessRequest } from "./vercel-app.ts"

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // `req.query` est fourni par le runtime de Vercel ; c'est là que se trouve le
  // chemin transmis par la réécriture (`__washpilot_api_path`).
  await handleServerlessRequest(req as ServerlessRequest, res as never)
}
