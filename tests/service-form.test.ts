/**
 * Contrat du formulaire Prestations — vérifié sur la source.
 *
 * L'écran est un formulaire React sans harnais de composants dans ce dépôt ;
 * ses règles se garantissent donc là où elles se lisent vraiment : dans le
 * code du formulaire. Ces assertions sont les garde-fous de la refonte — si
 * quelqu'un réintroduit un champ « Nom de la prestation » ou un prix général
 * « Prix (FCFA) », la suite devient rouge.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = readFileSync(path.join(root, "src", "app", "services", "page.tsx"), "utf8")
const washSource = readFileSync(path.join(root, "src", "app", "washes", "page.tsx"), "utf8")

test("le champ « Nom de la prestation » a disparu du formulaire principal", () => {
  assert.ok(!source.includes("Nom de la prestation"), "le champ nom est de retour dans le formulaire")
})

test("le champ général « Prix (FCFA) » a disparu du formulaire principal", () => {
  assert.ok(!source.includes("Prix (F CFA)"), "le champ prix général est de retour dans le formulaire")
  assert.ok(!source.includes("price_xof"), "l'état du prix général est de retour")
  assert.ok(!source.includes("family_prices"), "les tarifs par famille sont de retour")
})

test("le sélecteur « Type de service » occupe toute la largeur", () => {
  const selector = /Type de service[\s\S]{0,400}?<SelectTrigger className="w-full">/.test(source)
  assert.ok(selector, "le sélecteur de type n'est pas en pleine largeur")
})

test("la section « Catégories de véhicules autorisées » existe avec son explication", () => {
  assert.ok(source.includes("Catégories de véhicules autorisées"), "section absente")
  assert.ok(
    source.includes("Sélectionnez les catégories de véhicules pouvant bénéficier de cette prestation"),
    "texte explicatif absent",
  )
  assert.ok(source.includes("Prix en FCFA"), "libellé de prix par catégorie absent")
  assert.ok(source.includes("<Checkbox"), "cases à cocher absentes")
})

test("les catégories proposées viennent du référentiel réel de la station", () => {
  assert.ok(source.includes("/api/v1/vehicle-categories"), "les catégories ne sont pas chargées depuis l'API")
  assert.ok(source.includes("vehicleGroups"), "le regroupement des catégories réelles est absent")
})

test("les messages de validation parlent de catégories et de prix", () => {
  assert.ok(source.includes("Sélectionnez au moins une catégorie de véhicule."), "message d'absence de catégorie absent")
  assert.ok(source.includes("Renseignez le prix pour la catégorie"), "message de prix manquant absent")
  assert.ok(source.includes("Le prix doit être un montant valide en FCFA."), "message de prix invalide absent")
})

test("la création de type de service passe par un flux distinct", () => {
  assert.ok(
    source.includes("Ajouter un type de service au catalogue"),
    "la boîte « Ajouter un type de service au catalogue » est absente",
  )
})

test("la caisse n'offre que les prestations autorisées pour le véhicule", () => {
  assert.ok(washSource.includes("isEligibleFor"), "l'écran caisse ne filtre pas par éligibilité")
  assert.ok(washSource.includes("configuredPriceFor"), "l'écran caisse n'utilise pas le tarif configuré")
  assert.ok(
    washSource.includes("Aucune prestation n’est autorisée pour cette catégorie"),
    "l'état vide « aucune prestation autorisée » est absent",
  )
})
