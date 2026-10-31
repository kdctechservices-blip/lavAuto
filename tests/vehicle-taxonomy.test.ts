/**
 * Référentiel des véhicules.
 *
 * Cette liste est la source unique de trois choses qui ne doivent jamais
 * diverger : ce que l'écran propose, ce que l'API accepte, et ce qui porte un
 * tarif. Un code dupliqué, un libellé en double ou une famille vide casse
 * l'une des trois sans bruit — d'où ces vérifications.
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  VEHICLE_FAMILIES,
  VEHICLE_FAMILY_CODES,
  VEHICLE_TYPES,
  VEHICLE_TYPE_COUNT,
  familyLabel,
  familyOrder,
  isVehicleFamily,
  sortVehicleCategories,
  vehicleFamily,
  vehicleType,
} from "../src/config/vehicle-taxonomy.ts"

test("neuf familles, dans l'ordre annoncé", () => {
  assert.deepEqual(VEHICLE_FAMILY_CODES, [
    "deux_roues",
    "petites_voitures",
    "berlines",
    "suv",
    "utilitaires",
    "transport_personnes",
    "poids_lourds",
    "speciaux",
    "electriques",
  ])
})

test("les codes et libellés de famille sont uniques et renseignés", () => {
  assert.equal(new Set(VEHICLE_FAMILY_CODES).size, VEHICLE_FAMILIES.length)
  assert.equal(new Set(VEHICLE_FAMILIES.map((f) => f.label)).size, VEHICLE_FAMILIES.length)
  for (const family of VEHICLE_FAMILIES) {
    assert.ok(family.types.length > 0, `famille vide : ${family.code}`)
    assert.ok(family.description.trim().length > 0)
    // Le code sert de clé de tarif : minuscules, soulignés, sans accent.
    assert.match(family.code, /^[a-z][a-z0-9_]*$/)
  }
})

test("les soixante et un types demandés sont présents", () => {
  assert.equal(VEHICLE_TYPE_COUNT, 61)
  assert.equal(VEHICLE_TYPES.length, 61)
  // Un type par ligne du référentiel, et chacun rattaché à une famille.
  for (const type of VEHICLE_TYPES) {
    assert.match(type.code, /^[a-z0-9_]+$/)
    assert.ok(type.name.trim().length > 0)
    assert.ok(isVehicleFamily(type.family))
  }
})

test("aucun doublon de code ni de nom dans tout le référentiel", () => {
  const codes = VEHICLE_TYPES.map((type) => type.code)
  const names = VEHICLE_TYPES.map((type) => type.name.toLowerCase())
  assert.equal(new Set(codes).size, codes.length, "un code de type est dupliqué")
  assert.equal(new Set(names).size, names.length, "un libellé de type est dupliqué")
})

test("on retrouve un type par son code comme par son libellé", () => {
  assert.equal(vehicleType("suv_familial")?.name, "SUV familial")
  assert.equal(vehicleType("SUV familial")?.code, "suv_familial")
  assert.equal(vehicleType("  berline moyenne  ")?.code, "berline_moyenne")
  assert.equal(vehicleType("soucoupe volante"), null)
  assert.equal(vehicleType(null), null)
})

test("une famille inconnue n'est jamais acceptée", () => {
  assert.equal(isVehicleFamily("suv"), true)
  assert.equal(isVehicleFamily("suvs"), false)
  assert.equal(isVehicleFamily(""), false)
  assert.equal(isVehicleFamily(null), false)
  assert.equal(vehicleFamily("poids_lourds")?.label, "Poids lourds et camions")
  assert.equal(familyLabel("inconnue"), null)
})

test("les familles inconnues passent après les autres au tri", () => {
  assert.equal(familyOrder("deux_roues"), 0)
  assert.ok(familyOrder(null) >= VEHICLE_FAMILIES.length)
  assert.ok(familyOrder("inconnue") >= VEHICLE_FAMILIES.length)
})

test("le tri des catégories suit famille, rang puis nom", () => {
  const rows = [
    { name: "Camion-benne", family: "poids_lourds", sort_order: 2 },
    { name: "Moto", family: "deux_roues", sort_order: 0 },
    { name: "SUV familial", family: "suv", sort_order: 2 },
    { name: "Scooter", family: "deux_roues", sort_order: 1 },
    { name: "Crossover", family: "suv", sort_order: 0 },
    { name: "Catégorie maison", family: null, sort_order: 0 },
  ]
  const sorted = sortVehicleCategories(rows).map((row) => row.name)
  assert.deepEqual(sorted, [
    "Moto",
    "Scooter",
    "Crossover",
    "SUV familial",
    "Camion-benne",
    "Catégorie maison",
  ])
})

test("le tri ne modifie pas la liste d'origine", () => {
  const rows = [
    { name: "SUV", family: "suv" },
    { name: "Moto", family: "deux_roues" },
  ]
  const copie = [...rows]
  sortVehicleCategories(rows)
  assert.deepEqual(rows, copie)
})
