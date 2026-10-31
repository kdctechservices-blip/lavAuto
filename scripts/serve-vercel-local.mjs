/**
 * Reproduit localement le runtime des fonctions serverless de Vercel.
 *
 * Pourquoi ce fichier : sur Vercel, une fonction de `api/` ne reçoit pas
 * l'URL demandée par le navigateur. La réécriture déclarée dans `vercel.json`
 * la remplace par la destination (`/api`) et le chemin d'origine arrive dans un
 * paramètre de requête ; le corps JSON, lui, est **déjà analysé**. C'est
 * exactement ce comportement qui faisait répondre 404 à toutes les routes en
 * production, et il est impossible à retrouver avec `npm run dev`, où Express
 * reçoit l'URL d'origine.
 *
 * Pourquoi lire `vercel.json` plutôt que recopier la règle ici : une
 * simulation qui diverge de la configuration déployée ne prouve rien. Si la
 * réécriture disparaît ou change de forme, ce serveur refuse de démarrer — le
 * test de fumée échoue alors en CI, au lieu de valider une configuration qui
 * n'existe plus.
 *
 * Deux sources possibles pour la fonction :
 *   • par défaut, le code source (`server/vercel-handler.ts`), lisible ;
 *   • avec `--bundle`, l'artefact réellement déployé (`server/vercel-bundle.js`,
 *     produit par `npm run build:api`) — c'est ce que fait `npm run
 *     smoke:serverless`, pour vérifier ce que la production exécutera et non
 *     seulement les sources.
 *
 * Usage :
 *   node --import tsx scripts/serve-vercel-local.mjs [--bundle] [--preserve-url]
 *   PORT=3001
 */
import http from "node:http"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const useBundle = process.argv.includes("--bundle")
/**
 * Par défaut, on simule le cas **défavorable** : l'URL reçue est celle de la
 * destination, pas celle du navigateur. C'est le comportement qui a cassé la
 * production ; s'en écarter ici reviendrait à valider un déploiement qui ne
 * fonctionne pas.
 *
 * `--preserve-url` simule l'autre comportement possible de la plateforme
 * (URL d'origine conservée). Le code doit fonctionner dans les deux cas, et ce
 * drapeau sert à le vérifier.
 */
const preserveUrl = process.argv.includes("--preserve-url")
const bundlePath = path.join(root, "server", "vercel-bundle.js")

if (useBundle && !existsSync(bundlePath)) {
  console.error("[vercel-local] server/vercel-bundle.js absent : lancez d'abord `npm run build:api`.")
  process.exit(1)
}

// La réécriture réellement déployée : elle doit exister et viser la fonction.
const config = JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8"))
const API_PATH_PARAM = "__washpilot_api_path"
const apiRewrite = (config.rewrites ?? []).find(
  (rule) => rule.source === "/api/:path*" && String(rule.destination ?? "").includes(API_PATH_PARAM),
)
if (!apiRewrite) {
  console.error(
    "[vercel-local] vercel.json ne réécrit pas /api/:path* vers /api?" +
      API_PATH_PARAM +
      "=:path* : les chemins de plus d'un segment répondraient 404 sur Vercel.",
  )
  process.exit(1)
}

const handler = useBundle
  ? (await import(new URL("../server/vercel-bundle.js", import.meta.url).href)).default
  : (await import("../server/vercel-handler.ts")).default

const port = Number(process.env.PORT || 3001)

/** Comme @vercel/node : le JSON est analysé avant l'appel de la fonction. */
async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return undefined
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks)
  if (raw.length === 0) return undefined
  const type = req.headers["content-type"] ?? ""
  if (!type.includes("application/json")) return raw.toString("utf8")
  try {
    return JSON.parse(raw.toString("utf8"))
  } catch {
    return raw.toString("utf8")
  }
}

/**
 * Applique la réécriture de `vercel.json` à une requête entrante.
 *
 * La plateforme fusionne la chaîne de requête du visiteur (`?limit=2`) avec
 * celle de la destination ; les paramètres du visiteur ne doivent pas écraser
 * la destination.
 */
function applyApiRewrite(url) {
  const rest = url.pathname.replace(/^\/api\/?/, "")
  const destination = new URL(apiRewrite.destination.replace(":path*", rest), "http://vercel.local")
  for (const [key, value] of url.searchParams) {
    if (!destination.searchParams.has(key)) destination.searchParams.set(key, value)
  }
  return destination
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)

  if (!url.pathname.startsWith("/api")) {
    res.writeHead(404, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: { code: "not_found", message: "Cette route n'existe pas." } }))
    return
  }

  const destination = applyApiRewrite(url)

  // @vercel/node analyse le corps avant d'appeler la fonction. Le flux est
  // donc consommé : la fonction ne doit pas tenter de le relire.
  const body = await readBody(req)

  req.query = { ...Object.fromEntries(destination.searchParams) }
  if (body !== undefined) req.body = body
  // C'est ici que se joue la panne réelle : le chemin demandé n'est plus dans
  // `req.url`, il n'est plus que dans le paramètre de la réécriture.
  req.url = preserveUrl
    ? `${url.pathname}${url.search}`
    : `${destination.pathname}${destination.search}`

  await handler(req, res)
})

server.listen(port, "0.0.0.0", () => {
  const mode = useBundle ? "bundle déployé" : "sources"
  const urlMode = preserveUrl ? "URL d'origine conservée" : "URL réécrite"
  console.log(`[vercel-local] http://0.0.0.0:${port} — runtime serverless simulé (${mode}, ${urlMode})`)
})
