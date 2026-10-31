/**
 * Le contrat de déploiement Vercel.
 *
 * La panne qui a motivé ces tests est une panne de **configuration**, pas de
 * code : sur Vercel, `api/[...slug].ts` ne reçoit qu'un seul segment de chemin.
 * `/api/healthz` et `/api/v1` répondaient, `/api/v1/auth/me`,
 * `/api/v1/public/pricing` et `/api/v1/auth/register` renvoyaient le 404 de la
 * plateforme sans jamais atteindre Express — l'inscription et la connexion ne
 * pouvaient donc pas fonctionner.
 *
 * Le remède tient à trois choses qui doivent rester vraies ensemble :
 *   1. une fonction unique `api/index.ts` (nom littéral, pas de crochets) ;
 *   2. une réécriture explicite de `/api/:path*` vers elle, qui transporte le
 *      chemin dans `__washpilot_api_path` ;
 *   3. une réécriture SPA qui ne capte jamais `/api/...`.
 *
 * Aucune ne produit d'erreur si elle disparaît : l'application se contente de
 * répondre 404 à ses propres appels. D'où ces vérifications, qui portent sur
 * les fichiers réellement déployés.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { API_PATH_PARAM } from "../server/vercel-url.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const config = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as {
  functions?: Record<string, unknown>
  rewrites?: { source: string; destination: string }[]
}

const rewrites = config.rewrites ?? []

test("une fonction littérale sert toute l'API", () => {
  assert.ok(existsSync(path.join(root, "api", "index.ts")), "api/index.ts doit exister")
  // Le nom entre crochets est précisément ce qui ne marchait qu'à moitié.
  assert.equal(
    existsSync(path.join(root, "api", "[...slug].ts")),
    false,
    "api/[...slug].ts ne couvre qu'un segment sur Vercel : ne pas le réintroduire",
  )
})

test("la réécriture envoie tout /api/... vers cette fonction, chemin compris", () => {
  const rule = rewrites.find((entry) => entry.source === "/api/:path*")
  assert.ok(rule, "vercel.json doit réécrire /api/:path*")
  assert.match(rule.destination, /^\/api\?/, "la destination doit viser la fonction /api")
  assert.ok(
    rule.destination.includes(`${API_PATH_PARAM}=:path*`),
    "le chemin doit voyager dans __washpilot_api_path, sinon la fonction ne saurait pas quelle route servir",
  )
})

test("la réécriture de l'application monopage ne capte jamais l'API", () => {
  const spa = rewrites.find((entry) => entry.destination === "/index.html")
  assert.ok(spa, "vercel.json doit garder une réécriture SPA")
  assert.match(spa.source, /api/, "la source doit exclure /api, sinon l'API renverrait index.html")
})

test("la fonction déclarée est celle que la réécriture cible", () => {
  const functions = Object.keys(config.functions ?? {})
  assert.deepEqual(functions, ["api/index.ts"])
})

test("le build serverless inclut la fonction littérale", () => {
  const build = readFileSync(path.join(root, "scripts", "build-api.mjs"), "utf8")
  assert.match(build, /server\/vercel-handler\.ts/, "le bundle doit partir de server/vercel-handler.ts")
  // Les fonctions de `api/` importent le bundle produit, jamais les sources.
  const entry = readFileSync(path.join(root, "api", "index.ts"), "utf8")
  assert.match(entry, /vercel-bundle\.js/)
})
