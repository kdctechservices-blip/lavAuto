/**
 * Valeurs par défaut d'une nouvelle station.
 *
 * Le cas testé n'est pas cosmétique : sans catégorie de véhicule, l'API refuse
 * la création d'un lavage (`vehicle_category_id` obligatoire) et l'écran de
 * caisse désactive le sélecteur. Une station fraîchement configurée resterait
 * donc incapable d'encaisser quoi que ce soit.
 *
 * Depuis que les catégories portent une famille, un second risque apparaît :
 * un défaut mal rangé (mauvaise famille, mauvais rang) recevrait le tarif
 * d'une autre famille de véhicules. Les deux sont vérifiés ici.
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  DEFAULT_SERVICE_CATEGORY_NAMES,
  DEFAULT_VEHICLE_CATEGORIES,
  DEFAULT_VEHICLE_CATEGORY_NAMES,
  SERVICE_CATALOG_NAMES,
  SERVICE_CATALOG_TEMPLATES,
  isConsistentDefault,
  needsDefaultVehicleCategories,
  serviceCategoryName,
} from "../server/default-catalog.ts"
import { VEHICLE_FAMILIES, familyOrder, vehicleType } from "../src/config/vehicle-taxonomy.ts"
import { matchingServiceCategory } from "../src/config/service-categories.ts"

test("une station neuve reçoit des catégories de véhicules", () => {
  assert.ok(DEFAULT_VEHICLE_CATEGORIES.length > 0)
  // Une voiture et une moto au minimum : le parc ivoirien commence là.
  assert.ok(DEFAULT_VEHICLE_CATEGORY_NAMES.some((name) => /berline/i.test(name)))
  assert.ok(DEFAULT_VEHICLE_CATEGORY_NAMES.some((name) => /moto/i.test(name)))
})

test("les catégories par défaut sont toutes distinctes et non vides", () => {
  const names = [...DEFAULT_VEHICLE_CATEGORY_NAMES]
  assert.equal(new Set(names).size, names.length)
  for (const name of names) {
    assert.equal(name.trim().length > 0, true)
  }
})

test("chaque défaut vient du référentiel, avec sa famille et son rang", () => {
  for (const category of DEFAULT_VEHICLE_CATEGORIES) {
    assert.ok(vehicleType(category.name), `« ${category.name} » est absent du référentiel`)
    assert.equal(isConsistentDefault(category), true, `défaut incohérent : ${category.name}`)
    assert.ok(familyOrder(category.family) < VEHICLE_FAMILIES.length, "famille inconnue")
  }
})

test("les défauts couvrent chaque famille, une seule fois", () => {
  const families = DEFAULT_VEHICLE_CATEGORIES.map((category) => category.family)
  // Chaque famille porte un tarif : une famille absente, et ses véhicules
  // n'ont aucune case — donc aucun supplément de prix possible.
  assert.deepEqual(
    [...new Set(families)].sort(),
    VEHICLE_FAMILIES.map((family) => family.code).sort()
  )
  // Une seule ligne par famille : l'écran d'ouverture doit rester court.
  assert.equal(families.length, new Set(families).size)
  assert.equal(DEFAULT_VEHICLE_CATEGORIES.length, VEHICLE_FAMILIES.length)
})

test("aucun défaut n'est rangé dans une famille inventée", () => {
  const codes = new Set(VEHICLE_FAMILIES.map((family) => family.code))
  for (const category of DEFAULT_VEHICLE_CATEGORIES) {
    assert.ok(codes.has(category.family), `famille inconnue : ${category.family}`)
  }
})

test("l'initialisation ne concerne qu'une liste vide", () => {
  assert.equal(needsDefaultVehicleCategories(0), true)
  // Une station qui a supprimé ses catégories ne doit pas les voir revenir.
  assert.equal(needsDefaultVehicleCategories(1), false)
  assert.equal(needsDefaultVehicleCategories(12), false)
})

test("les catégories de prestations par défaut sont distinctes", () => {
  assert.ok(DEFAULT_SERVICE_CATEGORY_NAMES.length >= 4)
  assert.equal(
    new Set(DEFAULT_SERVICE_CATEGORY_NAMES.map((name) => name.toLowerCase())).size,
    DEFAULT_SERVICE_CATEGORY_NAMES.length,
  )
})

test("chaque modèle du référentiel tombe dans une catégorie existante", () => {
  // Tout modèle du catalogue (server/default-catalog.ts) doit atterrir dans
  // l'une des catégories créées avec la station : sinon la prestation
  // s'afficherait « sans catégorie » et le filtre du catalogue serait faux.
  for (const template of SERVICE_CATALOG_TEMPLATES) {
    const name = serviceCategoryName(template.category)
    assert.ok(
      (DEFAULT_SERVICE_CATEGORY_NAMES as readonly string[]).includes(name),
      `« ${template.name} » tombe dans « ${name} », absent des catégories par défaut`,
    )
  }
  // Une catégorie inconnue ou absente n'est jamais laissée sans classement.
  assert.equal(serviceCategoryName(null), "Autres prestations")
  assert.equal(serviceCategoryName("modele_du_futur"), "Autres prestations")
})

// ---------------------------------------------------------------------------
// Catalogue des prestations
// ---------------------------------------------------------------------------

test("le catalogue propose la liste attendue, dans l'ordre", () => {
  assert.deepEqual([...SERVICE_CATALOG_NAMES], [
    "Lavage extérieur",
    "Lavage intérieur simple",
    "Lavage complet (intérieur + extérieur)",
    "Lavage express",
    "Nettoyage des tapis et sièges uniquement",
    "Lavage des moquettes (maison)",
    "Nettoyage des jantes et pneus",
    "Lavage du bas de caisse",
    "Lavage moteur complet",
    "Lustrage de la carrosserie",
    "Lavage de motos",
  ])
})

test("aucune prestation n'est proposée deux fois", () => {
  const names = SERVICE_CATALOG_NAMES.map((name) => name.toLowerCase())
  assert.equal(new Set(names).size, names.length)
})

test("chaque prestation a un prix, une durée et une description exploitables", () => {
  for (const template of SERVICE_CATALOG_TEMPLATES) {
    // Un prix à zéro ferait un lavage gratuit ; l'écran afficherait « 0 F CFA »
    // et personne ne verrait l'erreur avant la première recette.
    assert.ok(template.price_cents > 0, `prix absent : ${template.name}`)
    assert.ok(
      Number.isInteger(template.duration_minutes) &&
        template.duration_minutes >= 1 &&
        template.duration_minutes <= 1440,
      `durée hors bornes : ${template.name}`,
    )
    assert.ok(template.description.length >= 10, `description trop courte : ${template.name}`)
    // Contrainte de la table services.
    assert.ok(template.name.length <= 120, `nom trop long : ${template.name}`)
    assert.equal(typeof template.category, "string")
    assert.ok(template.category.length > 0)
  }
})

test("un type du catalogue retrouve sa catégorie de station par son nom", () => {
  // Le formulaire « Nouvelle prestation » pré-sélectionne la catégorie à
  // partir du type choisi : il compare des libellés, pas des identifiants.
  const stationCategories = DEFAULT_SERVICE_CATEGORY_NAMES.map((name, index) => ({
    id: `id-${index}`,
    name,
  }))
  for (const template of SERVICE_CATALOG_TEMPLATES) {
    const found = matchingServiceCategory(template.category, stationCategories)
    assert.ok(found, `aucune catégorie pour le type « ${template.name} »`)
    assert.ok(found.name.length > 0)
  }
  // La casse et les accents du libellé ne doivent pas empêcher la trouvaille.
  assert.equal(
    matchingServiceCategory("detailing", [{ id: "x", name: "Detailing & soins" }])?.id,
    "x",
  )
  // Une catégorie absente de la station rend `null` : le formulaire garde
  // alors la catégorie déjà choisie au lieu d'en inventer une.
  assert.equal(matchingServiceCategory("exterior_wash", []), null)
})
