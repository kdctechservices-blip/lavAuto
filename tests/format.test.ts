/**
 * Mise en forme des montants et des dates.
 *
 * La règle testée ici n'est pas cosmétique : le dépôt affichait « XOF »,
 * « FCFA » et « F CFA » pour la même somme. Un caissier qui compare deux
 * écrans ne doit pas se demander si l'unité change le montant.
 */
import { strict as assert } from "node:assert"
import test from "node:test"

import {
  CURRENCY_LABEL,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatQuantity,
  formatRelative,
  formatXof,
  formatXofUnits,
  spokenXof,
  todayIso,
} from "../src/lib/format.ts"

test("un montant en centimes s'affiche en francs CFA, avec séparateurs", () => {
  assert.equal(formatXof(250_000), "2 500 F CFA")
  assert.equal(formatXof(0), "0 F CFA")
  // Le franc CFA n'a pas de subdivision en usage courant : on arrondit au
  // franc, jamais au centime affiché.
  assert.equal(formatXof(123_456_789), "1 234 568 F CFA")
})

test("le centime n'est jamais perdu par arrondi silencieux", () => {
  assert.equal(formatXof(1, { decimals: true }), "0,01 F CFA")
  assert.equal(formatXof(250_050, { decimals: true }), "2 500,50 F CFA")
})

test("un montant absent s'affiche « — », jamais « 0 »", () => {
  // Confondre une donnée manquante et une recette nulle serait un mensonge.
  assert.equal(formatXof(null), "—")
  assert.equal(formatXof(undefined), "—")
  assert.equal(formatXof(Number.NaN), "—")
})

test("le signe n'apparaît que sur demande, et l'écart négatif se lit", () => {
  assert.equal(formatXof(250_000, { signed: true }), "+2 500 F CFA")
  assert.equal(formatXof(-250_000, { signed: true }), "-2 500 F CFA")
  assert.equal(formatXof(-250_000), "-2 500 F CFA")
  assert.equal(spokenXof(-250_000), "moins 2 500 F CFA")
})

test("l'abréviation ne s'applique qu'aux grands montants et garde l'unité", () => {
  assert.equal(formatXof(150_000_000, { compact: true }), "1,5 M F CFA")
  assert.equal(formatXof(250_000, { compact: true }), "2 500 F CFA")
})

test("une somme déjà en francs ne subit pas de double conversion", () => {
  assert.equal(formatXofUnits(2_500), "2 500 F CFA")
  assert.equal(formatXofUnits(0), "0 F CFA")
})

test("l'unité affichée est unique dans toute l'application", () => {
  assert.equal(CURRENCY_LABEL, "F CFA")
  assert.ok(formatXof(250_000).endsWith(CURRENCY_LABEL))
  assert.equal(formatNumber(1_234_567), "1 234 567")
})

test("les pourcentages acceptent un ratio ou un pourcentage", () => {
  assert.equal(formatPercent(0.5), "50 %")
  assert.equal(formatPercent(50, { input: "percent" }), "50 %")
  assert.equal(formatPercent(0.1234, { decimals: 1 }), "12,3 %")
})

test("les dates suivent la locale ivoirienne et le fuseau d'Abidjan", () => {
  const iso = "2026-10-22T12:00:00Z"
  assert.match(formatDate(iso), /^22 oct\. 2026$/)
  assert.match(formatDate(iso, "long"), /^jeudi 22 octobre 2026$/)
  assert.match(formatDateTime(iso), /^22 oct\. 2026, 12:00$/)
  assert.equal(todayIso(), new Date().toISOString().slice(0, 10).replace(/^$/, ""))
})

test("une date invalide s'affiche « — » plutôt que « Invalid Date »", () => {
  assert.equal(formatDate("pas une date"), "—")
  assert.equal(formatDateTime(null), "—")
})

test("le temps relatif reste lisible et bascule vers une date absolue", () => {
  const now = new Date("2026-10-22T12:00:00Z")
  assert.equal(formatRelative("2026-10-22T11:59:30Z", now), "à l'instant")
  assert.equal(formatRelative("2026-10-22T11:55:00Z", now), "il y a 5 min")
  assert.equal(formatRelative("2026-10-22T09:00:00Z", now), "il y a 3 h")
  assert.equal(formatRelative("2026-10-21T09:00:00Z", now), "hier à 09:00")
  assert.equal(formatRelative("2026-10-18T09:00:00Z", now), "il y a 4 jours")
  assert.match(formatRelative("2026-09-01T09:00:00Z", now), /1 sept\. 2026/)
})

test("une quantité porte toujours son unité, au singulier comme au pluriel", () => {
  assert.equal(formatQuantity(1, { singular: "lavage" }), "1 lavage")
  assert.equal(formatQuantity(3, { singular: "lavage" }), "3 lavages")
  assert.equal(formatQuantity(4.5, { singular: "litre" }, 1), "4,5 litres")
  assert.equal(formatQuantity(2, { singular: "bidon" }), "2 bidons")
})
