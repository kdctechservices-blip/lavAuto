import test from "node:test"
import assert from "node:assert/strict"
import {
  parseQuantity,
  quantityToInput,
  formatQuantity,
  stockValueCents,
} from "../src/lib/quantity.ts"
import {
  formatQuantity as formatQuantiteServeur,
  stockValueCents as valeurServeur,
} from "../server/stock-rules.ts"

test("un entier se convertit en millièmes", () => {
  assert.equal(parseQuantity("5"), 5000)
})

test("la virgule francophone est acceptée", () => {
  assert.equal(parseQuantity("1,5"), 1500)
  assert.equal(parseQuantity("0,25"), 250)
})

test("le point décimal reste accepté", () => {
  assert.equal(parseQuantity("1.5"), 1500)
})

test("les espaces de frappe sont tolérés", () => {
  assert.equal(parseQuantity(" 2 "), 2000)
  assert.equal(parseQuantity("1 , 5"), 1500)
})

test("une saisie vide ne vaut pas zéro", () => {
  // Renvoyer 0 ferait enregistrer un mouvement nul sans que personne
  // ne s'en aperçoive.
  assert.equal(parseQuantity(""), null)
  assert.equal(parseQuantity("   "), null)
})

test("une saisie non numérique est refusée plutôt que convertie en NaN", () => {
  assert.equal(parseQuantity("abc"), null)
  assert.equal(parseQuantity("1,5 litre"), null)
  assert.equal(parseQuantity("--3"), null)
})

test("au-delà du millième la valeur est arrondie, pas rejetée", () => {
  assert.equal(parseQuantity("0,0004"), 0)
  assert.equal(parseQuantity("0,0006"), 1)
  assert.equal(Number.isInteger(parseQuantity("1,23456") as number), true)
})

test("aller-retour saisie puis réaffichage conserve la valeur", () => {
  for (const texte of ["1", "1.5", "0.25", "12.125"]) {
    const milli = parseQuantity(texte) as number
    assert.equal(parseQuantity(quantityToInput(milli)), milli, `aller-retour sur ${texte}`)
  }
})

test("l'affichage en lecture utilise la virgule et accorde le pluriel", () => {
  assert.equal(formatQuantity(1000, "litre"), "1 litre")
  assert.equal(formatQuantity(2000, "litre"), "2 litres")
  assert.equal(formatQuantity(1500, "litre"), "1,5 litre")
  assert.equal(formatQuantity(1000, "unite"), "1 unité")
})

test("une unité inconnue s'affiche telle quelle", () => {
  assert.equal(formatQuantity(1000, "sachet"), "1 sachet")
})

test("la valeur du stock est un entier de centimes", () => {
  // 2,5 litres à 1 200 F le litre = 3 000 F
  assert.equal(stockValueCents(2500, 120000), 300000)
  assert.equal(Number.isInteger(stockValueCents(1, 1)), true)
})

test("l'interface et le serveur affichent une quantité de la même façon", () => {
  // Les deux modules sont volontairement dupliqués : `tsconfig.app.json` ne
  // compile que `src/`, l'interface ne peut donc pas importer `server/`.
  // Cette duplication est une dette assumée — ce test est le garde-fou qui
  // empêche les deux copies de diverger en silence.
  const cas = [0, 1, 999, 1000, 1500, 250, 123456, 2000]
  for (const milli of cas) {
    for (const unite of ["unite", "litre", "kilogramme", "sachet"]) {
      assert.equal(
        formatQuantity(milli, unite),
        formatQuantiteServeur(milli, unite),
        `divergence sur ${milli} ${unite}`,
      )
    }
  }
})

test("l'interface et le serveur valorisent un stock de la même façon", () => {
  const cas: Array<[number, number]> = [
    [0, 500000],
    [1, 1],
    [2500, 120000],
    [333, 99999],
  ]
  for (const [milli, cout] of cas) {
    assert.equal(stockValueCents(milli, cout), valeurServeur(milli, cout), `divergence sur ${milli}/${cout}`)
  }
})
