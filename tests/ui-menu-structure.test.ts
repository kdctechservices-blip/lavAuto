/**
 * Structure des menus Base UI.
 *
 * Contexte : `DropdownMenuLabel` est un `Menu.GroupLabel`. Au montage, il
 * enregistre son identifiant auprès du `Menu.Group` parent, qui s'en sert comme
 * `aria-labelledby`. Sans groupe parent, le contexte est `undefined` et Base UI
 * lève « MenuGroupContext is missing » — une erreur qui fait tomber l'écran sur
 * l'ErrorBoundary de React Router.
 *
 * Ce défaut échappe à `tsc` (les types n'expriment pas la relation parent/enfant)
 * et au build (le contenu d'un menu n'est rendu qu'à l'ouverture). Il n'apparaît
 * donc qu'au clic de l'utilisateur. D'où ces deux filets :
 *
 *   1. un test d'exécution qui prouve que l'invariant est réel et non supposé ;
 *   2. un contrôle statique de tout `src/`, pour que la règle vaille partout et
 *      pas seulement dans le composant corrigé aujourd'hui.
 */
import { strict as assert } from "node:assert"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { Menu } from "@base-ui/react/menu"

// ---------------------------------------------------------------------------
// 1. L'invariant Base UI, vérifié à l'exécution
// ---------------------------------------------------------------------------

test("un libellé de menu rend normalement à l'intérieur d'un groupe", () => {
  const html = renderToStaticMarkup(
    createElement(
      Menu.Group,
      null,
      createElement(Menu.GroupLabel, null, "Apparence")
    )
  )

  assert.match(html, /role="group"/)
  assert.match(html, /Apparence/)
})

test("un libellé de menu hors d'un groupe lève l'erreur Base UI", () => {
  assert.throws(
    () =>
      renderToStaticMarkup(
        createElement(Menu.GroupLabel, null, "Apparence")
      ),
    /MenuGroupContext is missing/,
    "si Base UI cesse d'exiger un groupe parent, le contrôle statique ci-dessous n'a plus de raison d'être"
  )
})

// ---------------------------------------------------------------------------
// 2. Contrôle statique : aucun libellé orphelin dans src/
// ---------------------------------------------------------------------------

/** Parts qui exigent un ancêtre, et ancêtres qui les satisfont. */
const REQUIRES_ANCESTOR: Record<string, string[]> = {
  DropdownMenuLabel: ["DropdownMenuGroup", "DropdownMenuRadioGroup"],
  DropdownMenuRadioItem: ["DropdownMenuRadioGroup"],
}

/** Le fichier qui *définit* ces composants n'est pas un lieu d'usage. */
const DEFINITION_FILE = join("src", "components", "ui", "dropdown-menu.tsx")

function tsxFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...tsxFiles(full))
    else if (entry.name.endsWith(".tsx")) found.push(full)
  }
  return found
}

type Orphan = { file: string; line: number; part: string; expected: string[] }

/**
 * Parcourt les balises dans l'ordre du fichier en tenant une pile des groupes
 * ouverts. Une part surveillée rencontrée avec une pile vide est orpheline.
 */
function findOrphans(file: string, source: string): Orphan[] {
  const watched = Object.keys(REQUIRES_ANCESTOR)
  const ancestors = [
    ...new Set(Object.values(REQUIRES_ANCESTOR).flat()),
  ]
  const names = [...new Set([...watched, ...ancestors])].join("|")
  const tags = new RegExp(`<(/?)(${names})(?=[\\s/>])([^>]*)>`, "g")

  const open: string[] = []
  const orphans: Orphan[] = []

  for (const match of source.matchAll(tags)) {
    const [, closing, name, rest] = match

    if (closing) {
      const at = open.lastIndexOf(name)
      if (at !== -1) open.splice(at, 1)
      continue
    }

    if (watched.includes(name)) {
      const satisfied = REQUIRES_ANCESTOR[name].some((a) => open.includes(a))
      if (!satisfied) {
        orphans.push({
          file,
          line: source.slice(0, match.index).split("\n").length,
          part: name,
          expected: REQUIRES_ANCESTOR[name],
        })
      }
    }

    // Une balise auto-fermante n'ouvre rien de durable.
    if (ancestors.includes(name) && !rest.trimEnd().endsWith("/")) {
      open.push(name)
    }
  }

  return orphans
}

test("aucun libellé de menu n'est posé hors de son groupe dans src/", () => {
  const orphans = tsxFiles("src")
    .filter((f) => f !== DEFINITION_FILE)
    .flatMap((f) => findOrphans(f, readFileSync(f, "utf8")))

  const report = orphans
    .map(
      (o) =>
        `${o.file}:${o.line} — <${o.part}> doit être placé dans ${o.expected.join(" ou ")}`
    )
    .join("\n")

  assert.equal(
    orphans.length,
    0,
    `Base UI lèvera « MenuGroupContext is missing » à l'ouverture du menu :\n${report}`
  )
})

test("le contrôle statique repère bien un libellé orphelin", () => {
  // Témoin négatif : sans lui, le test précédent passerait même si la détection
  // était cassée et ne trouvait jamais rien.
  const orphan = findOrphans(
    "exemple.tsx",
    `<DropdownMenuContent>
       <DropdownMenuLabel>Apparence</DropdownMenuLabel>
     </DropdownMenuContent>`
  )
  assert.equal(orphan.length, 1)
  assert.equal(orphan[0].part, "DropdownMenuLabel")

  const wrapped = findOrphans(
    "exemple.tsx",
    `<DropdownMenuContent>
       <DropdownMenuGroup>
         <DropdownMenuLabel>Apparence</DropdownMenuLabel>
       </DropdownMenuGroup>
     </DropdownMenuContent>`
  )
  assert.equal(wrapped.length, 0)
})
