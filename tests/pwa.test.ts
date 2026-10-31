import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { Script } from "node:vm"
import path from "node:path"

// ---------------------------------------------------------------------------
// L'application installable : manifeste et service worker
//
// Ces fichiers ne sont pas compilés par TypeScript et ne sont pas couverts
// par le reste de la suite. Une faute de frappe dans une URL ne se verrait
// qu'au moment où un gérant installe l'application sur son téléphone et
// tombe sur une page blanche — c'est-à-dire trop tard.
//
// Ces tests tiennent donc la promesse du manifeste : tout ce qu'il annonce
// doit exister pour de bon.
// ---------------------------------------------------------------------------

const root = path.resolve(import.meta.dirname, "..")
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8")

const manifest = JSON.parse(read("public/manifest.webmanifest")) as {
  name: string
  short_name: string
  start_url: string
  scope: string
  display: string
  icons: { src: string; sizes: string; purpose?: string }[]
  shortcuts?: { name: string; url: string }[]
}

const swSource = read("public/sw.js")

/** Chemins déclarés dans le routeur de l'application cliente. */
function declaredRoutes(): Set<string> {
  const source = read("src/config/routes.tsx")
  const found = new Set<string>()
  for (const match of source.matchAll(/path:\s*"([^"]+)"/g)) found.add(match[1])
  return found
}

// ---------------------------------------------------------------------------

test("le manifeste déclare ce qu'il faut pour être installable", () => {
  assert.ok(manifest.name.length > 0)
  assert.ok(manifest.short_name.length > 0 && manifest.short_name.length <= 12)
  assert.equal(manifest.display, "standalone", "sinon l'application s'ouvre comme un onglet")
  assert.equal(manifest.scope, "/")
})

test("chaque icône annoncée existe réellement", () => {
  // Une icône manquante fait échouer l'installation en silence sur Android.
  for (const icon of manifest.icons) {
    const file = path.join(root, "public", icon.src.replace(/^\//, ""))
    assert.ok(existsSync(file), `icône absente : ${icon.src}`)
  }
})

test("une icône masquable est fournie", () => {
  // Sans elle, Android rogne le logo dans un cercle et coupe l'emblème.
  const maskable = manifest.icons.some((icon) => icon.purpose?.includes("maskable"))
  assert.ok(maskable, "il faut au moins une icône purpose=maskable")
})

test("l'écran de démarrage pointe vers une page qui existe", () => {
  const routes = declaredRoutes()
  assert.ok(
    routes.has(manifest.start_url),
    `start_url ${manifest.start_url} ne correspond à aucune route déclarée`,
  )
})

test("chaque raccourci mène à une page réelle", () => {
  // Le piège trouvé en écrivant ce lot : « /washes/nouveau » semblait
  // naturel, mais aucune route de ce nom n'existe — l'URL serait tombée sur
  // /washes/:washID et aurait cherché un lavage dont l'identifiant serait
  // « nouveau ».
  const routes = declaredRoutes()
  for (const shortcut of manifest.shortcuts ?? []) {
    assert.ok(
      routes.has(shortcut.url),
      `le raccourci « ${shortcut.name} » pointe vers ${shortcut.url}, qui n'est pas une route`,
    )
  }
})

test("le service worker est du JavaScript valide", () => {
  // Il n'est ni compilé ni vérifié par TypeScript : une virgule de trop le
  // rendrait silencieusement inopérant, et le mode hors connexion
  // disparaîtrait sans message d'erreur visible.
  assert.doesNotThrow(() => new Script(swSource, { filename: "sw.js" }))
})

test("le service worker ne met en cache que des lectures", () => {
  // Une écriture servie depuis un cache ferait croire à un encaissement qui
  // n'a jamais atteint le serveur. Les écritures passent par la file
  // d'attente, jamais par le cache.
  assert.match(
    swSource,
    /request\.method\s*!==\s*"GET"/,
    "le service worker doit ignorer tout ce qui n'est pas un GET",
  )
})

test("la console de l'éditeur n'est jamais mise en cache sur l'appareil", () => {
  assert.match(swSource, /pathname\.startsWith\("\/console"\)/)
})

test("les routes d'API mises en cache sont bien celles de l'encaissement", () => {
  // Liste fermée et volontairement courte : de quoi composer un lavage,
  // rien de plus. Un rapport ou un chiffre d'affaires périmé affiché sans
  // avertissement serait pire qu'une page qui dit « hors ligne ».
  const block = /const CACHEABLE_API = \[([^\]]+)\]/.exec(swSource)
  assert.ok(block, "la liste CACHEABLE_API doit rester repérable")
  const cached = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])

  assert.deepEqual(cached.sort(), [
    "/api/v1/services",
    "/api/v1/sites",
    "/api/v1/vehicle-categories",
    "/api/v1/workers",
  ])

  const forbidden = ["/api/v1/reports", "/api/v1/revenue", "/api/v1/audit", "/api/v1/subscription"]
  for (const route of forbidden) {
    assert.ok(!cached.includes(route), `${route} ne doit pas être servi depuis un cache`)
  }
})

test("le service worker sait vider les données de la station", () => {
  // Téléphone partagé entre deux caissiers : à la déconnexion, le catalogue
  // et les tarifs ne doivent pas rester lisibles.
  assert.match(swSource, /clear-api-cache/)
})

test("la page d'accueil référence le manifeste", () => {
  const html = read("index.html")
  assert.match(html, /rel="manifest"\s+href="\/manifest\.webmanifest"/)
})
