/**
 * Régression du formulaire de dépense.
 *
 * La page montait deux Dialog.Root contrôlés par le même état : celui du
 * bouton et celui de CreateExpenseModal. Le premier n'avait pas de Popup ;
 * Base UI interprétait donc un clic dans n'importe quel champ comme un clic
 * extérieur et fermait le formulaire. Le bouton doit seulement piloter l'état,
 * sans créer une seconde instance de dialogue.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const pageSource = readFileSync("src/app/expenses/page.tsx", "utf8")
const modalSource = readFileSync(
  "src/components/modals/create-expense-modal.tsx",
  "utf8",
)

test("la page des dépenses ne monte pas un second Dialogue parallèle", () => {
  assert.doesNotMatch(pageSource, /<Dialog(?:\s|>)/)
  assert.doesNotMatch(pageSource, /<DialogTrigger(?:\s|>)/)
  assert.equal(pageSource.match(/<CreateExpenseModal(?:\s|>)/g)?.length, 1)
  assert.match(
    modalSource,
    /<Dialog open=\{open\} onOpenChange=\{onOpenChange\}>/,
    "le Dialogue doit appartenir au formulaire qu'il contient",
  )
})

test("le bouton Nouvelle dépense ouvre directement le formulaire", () => {
  const button = pageSource.match(
    /<Button\s+onClick=\{\(\) => setOpen\(true\)\}[\s\S]*?Nouvelle dépense[\s\S]*?<\/Button>/,
  )

  assert.ok(button, "le bouton doit seulement passer l'état open à true")
  assert.doesNotMatch(
    pageSource,
    /form-interaction/,
    "aucun motif de fermeture fictif ne doit masquer un second Dialogue",
  )
})
