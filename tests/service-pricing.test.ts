/**
 * Prix d'une prestation selon le véhicule.
 *
 * Le serveur appliquait déjà ces tarifs, l'interface non : le caissier
 * annonçait 1 000 F et le lavage était enregistré à 5 000 F. Ces tests fixent
 * l'ordre de résolution (catégorie exacte → famille → prix de base) et
 * vérifient qu'aucune valeur douteuse ne peut produire un prix faux.
 */
import test from "node:test"
import assert from "node:assert/strict"

import { effectivePriceForFamily, hasVehiclePricing, isFamilyPriceKey, priceRange, resolveUnitPrice, isEligibleFor, configuredPriceFor, configuredPriceRange } from "../src/lib/service-pricing.ts"

const SUV = { id: "cat-suv", family: "suv" }
const MOTO = { id: "cat-moto", family: "deux_roues" }

test("sans tarif spécifique, le prix de base s'applique", () => {
  const service = { price_cents: 300_000, price_by_vehicle_type: {} }
  assert.equal(resolveUnitPrice(service, SUV), 300_000)
  assert.equal(resolveUnitPrice(service, null), 300_000)
  assert.equal(resolveUnitPrice({ price_cents: 300_000 }, SUV), 300_000)
})

test("un tarif de famille s'applique à toutes ses catégories", () => {
  const service = { price_cents: 300_000, price_by_vehicle_type: { suv: 500_000 } }
  assert.equal(resolveUnitPrice(service, SUV), 500_000)
  // Une autre famille garde le prix de base.
  assert.equal(resolveUnitPrice(service, MOTO), 300_000)
})

test("un tarif de catégorie exacte prime sur celui de la famille", () => {
  const service = {
    price_cents: 300_000,
    price_by_vehicle_type: { suv: 500_000, "cat-suv": 650_000 },
  }
  assert.equal(resolveUnitPrice(service, SUV), 650_000)
})

test("une catégorie inconnue retombe sur le prix de base, jamais sur un tarif voisin", () => {
  const service = { price_cents: 300_000, price_by_vehicle_type: { suv: 500_000 } }
  assert.equal(resolveUnitPrice(service, { id: "autre", family: null }), 300_000)
  assert.equal(resolveUnitPrice(service, { id: "autre", family: "inconnue" }), 300_000)
})

test("un identifiant seul (sans famille) reste utilisable", () => {
  const service = { price_cents: 100_000, price_by_vehicle_type: { "cat-suv": 400_000, suv: 900_000 } }
  assert.equal(resolveUnitPrice(service, "cat-suv"), 400_000)
  // Sans la famille, le tarif de famille n'est pas deviné : c'est voulu.
  assert.equal(resolveUnitPrice(service, "cat-inconnue"), 100_000)
})

test("les valeurs douteuses sont ignorées plutôt que facturées", () => {
  const service = {
    price_cents: 100_000,
    price_by_vehicle_type: { suv: Number.NaN, "cat-suv": -5, deux_roues: null },
  }
  assert.equal(resolveUnitPrice(service, SUV), 100_000)
  assert.equal(resolveUnitPrice(service, MOTO), 100_000)
})

test("le prix le plus bas et le plus haut décrivent l'amplitude réelle", () => {
  const service = {
    price_cents: 300_000,
    price_by_vehicle_type: { suv: 500_000, deux_roues: 200_000 },
  }
  assert.deepEqual(priceRange(service), { min: 200_000, max: 500_000 })
  // Sans tarif spécifique, l'amplitude est nulle : l'affichage doit rester
  // « 3 000 F » et non « à partir de 3 000 F ».
  assert.deepEqual(priceRange({ price_cents: 300_000 }), { min: 300_000, max: 300_000 })
})

test("savoir si une prestation a des tarifs par véhicule", () => {
  assert.equal(hasVehiclePricing({ price_cents: 1, price_by_vehicle_type: {} }), false)
  assert.equal(hasVehiclePricing({ price_cents: 1 }), false)
  assert.equal(hasVehiclePricing({ price_cents: 1, price_by_vehicle_type: { suv: 2 } }), true)
})

test("une clé de famille se distingue d'un identifiant de catégorie", () => {
  assert.equal(isFamilyPriceKey("suv"), true)
  assert.equal(isFamilyPriceKey("poids_lourds"), true)
  assert.equal(isFamilyPriceKey("3f2c1b4a-0000-4000-8000-000000000000"), false)
  assert.equal(isFamilyPriceKey("SUC"), false)
})

test("le formulaire pré-remplit le tarif de famille, pas le prix de base", () => {
  const service = { price_cents: 300_000, price_by_vehicle_type: { suv: 500_000 } }
  assert.equal(effectivePriceForFamily(service, "suv"), 500_000)
  assert.equal(effectivePriceForFamily(service, "deux_roues"), 300_000)
})

// ---------------------------------------------------------------------------
// Modèle explicite : l'éligibilité est distincte du tarif
// ---------------------------------------------------------------------------

test("sans association, la prestation n'est pas autorisée — le prix de base ne l'ouvre pas", () => {
  const service = { price_cents: 300_000, vehicle_prices: { "cat-berline": 500_000 } }
  assert.equal(isEligibleFor(service, "cat-moto"), false)
  assert.equal(isEligibleFor(service, null), false)
  assert.equal(isEligibleFor(service, undefined), false)
})

test("la présence de la clé autorise, sa valeur fixe le prix", () => {
  const service = { price_cents: 300_000, vehicle_prices: { "cat-berline": 500_000, "cat-suv": 800_000 } }
  assert.equal(isEligibleFor(service, "cat-berline"), true)
  assert.equal(configuredPriceFor(service, "cat-berline"), 500_000)
  assert.equal(configuredPriceFor(service, "cat-suv"), 800_000)
})

test("une prestation non configurée est close : aucun repli, aucun prix", () => {
  const legacy = { price_cents: 300_000 }
  assert.equal(isEligibleFor(legacy, "cat-berline"), false)
  assert.equal(configuredPriceFor(legacy, "cat-berline"), null)
  assert.equal(configuredPriceRange(legacy), null)
})

test("les valeurs douteuses d'une association n'autorisent rien", () => {
  const service = {
    price_cents: 0,
    vehicle_prices: { "cat-a": Number.NaN, "cat-b": -5, "cat-c": null as unknown as number },
  }
  assert.equal(isEligibleFor(service, "cat-a"), false)
  assert.equal(isEligibleFor(service, "cat-b"), false)
  assert.equal(isEligibleFor(service, "cat-c"), false)
})

test("l'amplitude des tarifs configurés reflète les associations, pas la famille", () => {
  const service = { price_cents: 1, vehicle_prices: { "cat-berline": 500_000, "cat-suv": 800_000 } }
  assert.deepEqual(configuredPriceRange(service), { min: 500_000, max: 800_000 })
})
