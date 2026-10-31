/**
 * Référentiel de navigation.
 *
 * Un écran, un libellé, une section. Ces tests empêchent la dérive qui avait
 * déjà eu lieu : « Nouveau lavage » dans la barre latérale, « Lavages » dans
 * l'en-tête, et une page rangée dans « Configuration » par accident.
 */
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  NAV_SECTIONS,
  ROUTE_META,
  breadcrumbsFor,
  contextualCommands,
  matchRoute,
  routeLabel,
  sectionOf,
} from "../src/config/navigation.ts"

const SIDEBAR = readFileSync("src/components/app-sidebar.tsx", "utf8")

test("chaque écran déclaré possède un libellé, une section et une icône", () => {
  for (const [path, meta] of Object.entries(ROUTE_META)) {
    assert.ok(meta.label.trim().length > 0, `libellé manquant pour ${path}`)
    assert.ok(NAV_SECTIONS.concat("Aide").includes(meta.section), `section inconnue pour ${path}`)
    assert.ok(meta.icon, `icône manquante pour ${path}`)
  }
})

test("le fil d'Ariane suit Accueil › Section › Page", () => {
  assert.deepEqual(
    breadcrumbsFor("/payments").map((crumb) => crumb.label),
    ["Accueil", "Finance", "Encaissements"],
  )
  assert.deepEqual(
    breadcrumbsFor("/services").map((crumb) => crumb.label),
    ["Accueil", "Configuration", "Catalogue", "Prestations"],
  )
  assert.deepEqual(
    breadcrumbsFor("/washes/abc-123").map((crumb) => crumb.label),
    ["Accueil", "Opérations", "Lavages", "Détail du lavage"],
  )
})

test("la page courante n'est jamais un lien, et n'apparaît qu'une fois", () => {
  for (const path of Object.keys(ROUTE_META)) {
    const crumbs = breadcrumbsFor(path)
    const last = crumbs[crumbs.length - 1]
    assert.equal(last.href, undefined, `${path} : le dernier maillon doit être du texte`)
    const labels = crumbs.map((crumb) => crumb.label)
    assert.equal(new Set(labels).size, labels.length, `${path} : libellé dupliqué dans le fil`)
  }
})

test("les routes de détail sont reconnues sans confondre deux écrans", () => {
  assert.equal(routeLabel("/washes/9f1c"), "Détail du lavage")
  assert.equal(routeLabel("/inconnu"), "Inconnu")
  assert.equal(matchRoute("/washes/9f1c")?.path, "/washes/:washID")
  assert.equal(sectionOf("/washes/9f1c"), "Opérations")
})

test("les commandes contextuelles changent avec l'écran", () => {
  const onWashes = contextualCommands("/washes").map((command) => command.label)
  const onCash = contextualCommands("/cash-drawer").map((command) => command.label)

  assert.ok(onWashes.includes("Ouvrir la caisse"))
  assert.notDeepEqual(onWashes, onCash)
  assert.ok(contextualCommands("/washes").every((command) => command.href.startsWith("/")))
})

test("chaque entrée de la barre latérale est rangée dans SA section", () => {
  const labels = ["Opérations", "Équipe", "Finance", "Configuration"]
  const positions = labels.map((label) => SIDEBAR.indexOf(`label: "${label}"`))
  assert.ok(positions.every((position) => position >= 0), "les quatre sections doivent exister")

  const urls = [...SIDEBAR.matchAll(/url:\s*"([^"]+)"/g)]
  assert.ok(urls.length > 10, "la barre latérale doit lister les écrans")

  for (const match of urls) {
    const url = match[1]
    if (url === "#") continue
    const index = match.index ?? 0
    const groupIndex = positions.filter((position) => position <= index).length - 1
    assert.ok(groupIndex >= 0, `${url} apparaît avant la première section`)
    assert.equal(
      sectionOf(url),
      labels[groupIndex],
      `${url} est dans « ${labels[groupIndex]} » mais le référentiel dit « ${sectionOf(url)} »`,
    )
  }
})

test("les libellés de la barre latérale viennent du même vocabulaire", () => {
  // « Nouveau lavage » était un libellé d'action utilisé comme nom d'écran.
  assert.ok(!SIDEBAR.includes('title: "Nouveau lavage"'))
  assert.ok(SIDEBAR.includes('title: "Lavages"'))
  assert.ok(ROUTE_META["/washes"].primaryAction?.label === "Nouveau lavage")
})
