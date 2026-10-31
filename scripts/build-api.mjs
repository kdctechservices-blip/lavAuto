/**
 * Empaquette l'API en un seul fichier pour les fonctions serverless.
 *
 * Ce que fait ce script : il réunit `server/vercel-handler.ts` et tout le code
 * serveur qu'il importe dans `server/vercel-bundle.js`, en laissant les paquets
 * npm externes (express, pg, zod…) à `node_modules`.
 *
 * Pourquoi c'est nécessaire : le code serveur importe ses voisins avec
 * l'extension `.ts` explicite. `tsx` (développement) et `node --test` savent le
 * faire ; le runtime de Vercel transpile chaque fichier de `api/` isolément et
 * laisse l'import en `.ts`, d'où « Cannot find module ». Le bundle supprime
 * cette dépendance au comportement de la plateforme.
 *
 * Sortie ignorée par Git : elle est reconstruite à chaque déploiement.
 *
 * Usage :
 *   npm run build:api
 */
import { build } from "esbuild"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { statSync } from "node:fs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outfile = path.join(root, "server", "vercel-bundle.js")

await build({
  absWorkingDir: root,
  entryPoints: ["server/vercel-handler.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Les paquets npm restent externes : ils sont déjà dans `node_modules` et
  // tracés par la plateforme. Seul le code du dépôt est empaqueté.
  packages: "external",
  legalComments: "none",
  logLevel: "warning",
})

const { size } = statSync(outfile)
console.log(`[build:api] ${path.relative(root, outfile)} — ${(size / 1024).toFixed(1)} Ko`)
