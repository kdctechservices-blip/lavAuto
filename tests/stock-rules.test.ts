import test from "node:test"
import assert from "node:assert/strict"

import {
  MILLI,
  signedQuantity,
  isLowStock,
  inventoryDelta,
  stockValueCents,
  canApply,
  formatQuantity,
} from "../server/stock-rules.ts"

// --------------------------------------------------------------- signe --

test("une entrée ajoute, une sortie retranche", () => {
  assert.equal(signedQuantity("entry", 5000), 5000)
  assert.equal(signedQuantity("exit", 5000), -5000)
})

test("une quantité saisie en négatif ne peut pas inverser le sens du mouvement", () => {
  // Sans la valeur absolue, une sortie de −5 ajouterait du stock.
  assert.equal(signedQuantity("exit", -5000), -5000)
  assert.equal(signedQuantity("entry", -5000), 5000)
})

// --------------------------------------------------------------- alerte --

test("un seuil à zéro ne déclenche jamais d'alerte", () => {
  assert.equal(isLowStock(0, 0), false)
  assert.equal(isLowStock(-1000, 0), false)
})

test("l'alerte se déclenche au seuil, pas seulement en dessous", () => {
  assert.equal(isLowStock(2000, 2000), true)
  assert.equal(isLowStock(2001, 2000), false)
  assert.equal(isLowStock(1999, 2000), true)
})

// ------------------------------------------------------------ inventaire --

test("l'inventaire enregistre un écart, pas un stock", () => {
  assert.equal(inventoryDelta(8000, 10000), -2000) // il manque 2 unités
  assert.equal(inventoryDelta(12000, 10000), 2000) // il y en a 2 de trop
})

test("un comptage conforme ne produit aucun écart", () => {
  assert.equal(inventoryDelta(10000, 10000), 0)
})

// ---------------------------------------------------------------- valeur --

test("la valeur du stock tient compte des millièmes", () => {
  // 2,5 litres à 1 200 F le litre = 3 000 F
  assert.equal(stockValueCents(2500, 120000), 300000)
})

test("la valeur est arrondie au centime, jamais laissée en flottant", () => {
  const valeur = stockValueCents(1, 1)
  assert.equal(Number.isInteger(valeur), true)
  assert.equal(valeur, 0)
})

test("un stock nul ne vaut rien", () => {
  assert.equal(stockValueCents(0, 500000), 0)
})

// ------------------------------------------------------------ faisabilité --

test("on ne peut pas sortir plus que ce qui reste", () => {
  assert.equal(canApply(3000, -4000), false)
  assert.equal(canApply(3000, -3000), true)
  assert.equal(canApply(3000, -2999), true)
})

test("une entrée est toujours réalisable", () => {
  assert.equal(canApply(0, 5000), true)
})

// ----------------------------------------------------------- affichage --

test("les quantités entières s'affichent sans décimale", () => {
  assert.equal(formatQuantity(1000, "unite"), "1 unité")
  assert.equal(formatQuantity(3000, "litre"), "3 litres")
})

test("les quantités fractionnaires utilisent la virgule", () => {
  assert.equal(formatQuantity(1500, "litre"), "1,5 litre")
  assert.equal(formatQuantity(150, "litre"), "0,15 litre")
})

test("une unité inconnue est affichée telle quelle plutôt que masquée", () => {
  assert.equal(formatQuantity(2000, "sachet"), "2 sachets")
})

test("MILLI vaut bien mille", () => {
  assert.equal(MILLI, 1000)
})
