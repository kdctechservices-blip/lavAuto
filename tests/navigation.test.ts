/**
 * Cohérence de la navigation.
 *
 * Trois façons de laisser un écran débranché, qu'aucun compilateur ne voit :
 *   • une page existe mais n'est déclarée dans aucune route — inatteignable ;
 *   • une route existe mais n'apparaît pas dans la barre latérale — atteignable
 *     seulement en tapant l'URL, donc invisible pour l'utilisateur ;
 *   • une entrée de barre latérale pointe vers une route supprimée — lien mort.
 *
 * Les exceptions sont nommées une par une et motivées : une liste vide
 * d'exceptions serait fausse (une page de détail n'a rien à faire dans un
 * menu), mais une exception non motivée masque un oubli.
 */
import { strict as assert } from "node:assert"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import { PERMISSIONS } from "../server/permissions.ts"

const ROUTES_FILE = "src/config/routes.tsx"
const SIDEBAR_FILE = "src/components/app-sidebar.tsx"

// ---------------------------------------------------------------------------
// Lecture des sources
// ---------------------------------------------------------------------------

/** Chemins déclarés dans routes.tsx, avec le module qu'ils chargent. */
function declaredRoutes(): Map<string, string> {
  const source = readFileSync(ROUTES_FILE, "utf8")
  const found = new Map<string, string>()
  for (const m of source.matchAll(
    /path:\s*"([^"]+)"[\s\S]{0,120}?import\("@\/([^"]+)"\)/g
  )) {
    found.set(m[1], m[2])
  }
  return found
}

/** Destinations citées par la barre latérale, hors entrées de repli "#". */
function sidebarUrls(): string[] {
  const source = readFileSync(SIDEBAR_FILE, "utf8")
  return [...source.matchAll(/url:\s*"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((url) => url !== "#")
}

/** Fichiers de page présents sur le disque. */
function pageFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...pageFiles(full))
    else if (entry.name === "page.tsx" || entry.name === "index.tsx") {
      found.push(full)
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// Exceptions assumées
// ---------------------------------------------------------------------------

/** Routes qui n'ont volontairement pas d'entrée dans la barre latérale. */
const NOT_IN_SIDEBAR: Record<string, string> = {
  "/": "redirection vers la vitrine",
  "/landing": "vitrine publique, hors application connectée",
  "/onboarding": "parcours de première configuration, atteint automatiquement",
  "/washes/:washID": "détail d'un lavage, atteint depuis la liste",
  "*": "page 404 de repli",
  "/support":
    "assistance : atteinte depuis le bouton d'aide flottant, présent sur toutes les pages. " +
    "Pas dans la barre latérale parce que celle-ci est filtrée par permission, alors que " +
    "demander de l'aide n'en exige aucune : un agent de lavage doit pouvoir signaler un problème.",
}

// Retiré : "/admin". Le back-office a quitté l'application cliente au profit
// de /console (console autonome, authentification séparée). L'entrée restait
// ici alors que la route n'existe plus — une exception sans objet finit par
// couvrir autre chose que ce qu'elle décrivait.

/** Préfixes hors barre latérale par nature. */
const PUBLIC_PREFIXES = ["/auth/", "/errors/"]

function expectedInSidebar(path: string): boolean {
  if (path in NOT_IN_SIDEBAR) return false
  return !PUBLIC_PREFIXES.some((p) => path.startsWith(p))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("chaque page du disque est déclarée dans une route", () => {
  const modules = new Set(
    [...declaredRoutes().values()].map((m) => m.replace(/^app\/|^pages\//, ""))
  )

  const unrouted = [...pageFiles("src/app"), ...pageFiles("src/pages")]
    .map((f) => f.replace(/^src\/(app|pages)\//, "").replace(/\.tsx$/, ""))
    // routes.tsx importe "@/pages/dashboard", pas ".../dashboard/index"
    .map((f) => f.replace(/\/index$/, ""))
    .filter((f) => !modules.has(f))

  assert.deepEqual(
    unrouted,
    [],
    `pages inatteignables, à déclarer dans ${ROUTES_FILE} :\n  ${unrouted.join("\n  ")}`
  )
})

test("chaque entrée de la barre latérale pointe vers une route déclarée", () => {
  const routes = declaredRoutes()
  const dead = sidebarUrls().filter((url) => !routes.has(url))

  assert.deepEqual(
    dead,
    [],
    `liens morts dans ${SIDEBAR_FILE} :\n  ${dead.join("\n  ")}`
  )
})

test("chaque route applicative est atteignable depuis la barre latérale", () => {
  const urls = new Set(sidebarUrls())
  const orphans = [...declaredRoutes().keys()]
    .filter(expectedInSidebar)
    .filter((path) => !urls.has(path))

  assert.deepEqual(
    orphans,
    [],
    "routes sans entrée de menu : les brancher dans la barre latérale, ou les " +
      `inscrire dans NOT_IN_SIDEBAR avec leur raison :\n  ${orphans.join("\n  ")}`
  )
})

test("les permissions citées par la barre latérale existent", () => {
  const source = readFileSync(SIDEBAR_FILE, "utf8")
  const cited = [...source.matchAll(/permission:\s*"([^"]+)"/g)].map((m) => m[1])
  const unknown = cited.filter(
    (p) => !(PERMISSIONS as readonly string[]).includes(p)
  )

  assert.deepEqual(unknown, [], `permissions inconnues : ${unknown.join(", ")}`)
  assert.ok(cited.length > 0, "la barre latérale doit filtrer sur les permissions")
})

test("l'écran Stations n'est annoncé qu'à qui peut y agir", () => {
  // Le serveur autorise `GET /sites` dès `wash:read`, mais création,
  // modification et désactivation exigent `settings:manage`. Annoncer la
  // rubrique à un agent de lavage lui ouvrait un écran entièrement grisé.
  const source = readFileSync(SIDEBAR_FILE, "utf8")
  const entry = source.match(/\{[^{}]*url:\s*"\/sites"[^{}]*\}/s)

  assert.ok(entry, "entrée Stations introuvable dans la barre latérale")
  assert.match(
    entry[0],
    /permission:\s*"settings:manage"/,
    "l'entrée Stations doit exiger settings:manage, la permission qu'exigent ses actions"
  )
})
