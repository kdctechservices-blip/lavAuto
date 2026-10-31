/**
 * Définitions des étapes de la configuration initiale.
 *
 * Ces règles décident de ce que l'utilisateur voit dans la Timeline : quelle
 * étape est cochée, laquelle est ouverte, et quel résumé s'affiche. Une erreur
 * ici ferait croire à une étape validée alors qu'elle ne l'est pas — d'où les
 * tests sur les cas vides, pas seulement sur le parcours nominal.
 */
import { strict as assert } from "node:assert"
import test from "node:test"

import {
  STAGES,
  STAGE_LABELS,
  TIMELINE_STEPS,
  overallPercent,
  planLabel,
  stageIndex,
  stepState,
  stepSummary,
  type OnboardingSnapshot,
} from "../src/lib/onboarding-stages.ts"

test("chaque étape a une entrée de Timeline, dans l'ordre du serveur", () => {
  assert.deepEqual(
    TIMELINE_STEPS.map((step) => step.id),
    [...STAGES],
  )
  for (const step of TIMELINE_STEPS) {
    assert.ok(step.title.length > 0, `titre manquant pour ${step.id}`)
    assert.ok(step.description.length > 0, `description manquante pour ${step.id}`)
    assert.ok(step.waiting.length > 0, `texte d'attente manquant pour ${step.id}`)
    assert.equal(STAGE_LABELS[step.id].length > 0, true)
  }
})

test("stageIndex retombe sur la première étape pour une valeur inconnue", () => {
  assert.equal(stageIndex("station"), 0)
  assert.equal(stageIndex("plan"), 3)
  assert.equal(stageIndex("review"), 4)
  assert.equal(stageIndex("n'importe quoi"), 0)
  assert.equal(stageIndex(null), 0)
  assert.equal(stageIndex(undefined), 0)
})

test("stepState ne coche que les étapes réellement dépassées", () => {
  assert.equal(stepState(0, 2), "completed")
  assert.equal(stepState(2, 2), "active")
  assert.equal(stepState(3, 2), "pending")
})

test("overallPercent progresse de la première à la dernière étape", () => {
  assert.equal(overallPercent(0), 20)
  assert.equal(overallPercent(4), 100)
  assert.equal(overallPercent(2), 60)
})

test("stepSummary n'invente jamais de valeur", () => {
  assert.equal(stepSummary("station", null), "À renseigner")
  assert.equal(stepSummary("plan", null), "À renseigner")

  const vide: OnboardingSnapshot = {
    station_data: null,
    services_data: null,
    workers_data: null,
    plan_code: null,
  }
  assert.equal(stepSummary("station", vide), "À renseigner")
  assert.equal(stepSummary("services", vide), "Aucune prestation sélectionnée")
  assert.equal(stepSummary("workers", vide), "Vous exercez seul")
  assert.equal(stepSummary("plan", vide), "À choisir")
  assert.equal(stepSummary("review", vide), "À vérifier")
})

test("stepSummary résume les données enregistrées", () => {
  const rempli: OnboardingSnapshot = {
    station_data: { name: "  Star Wash  ", city: "Cocody" },
    services_data: {
      selected: [{ name: "Lavage simple", price_cents: 200000 }],
      custom: [{ name: "Cire", price_cents: null }],
    },
    workers_data: { workers: [{ first_name: "Awa", last_name: "Koné" }] },
    plan_code: "essentiel",
  }

  assert.equal(stepSummary("station", rempli), "Star Wash · Cocody")
  assert.equal(stepSummary("services", rempli), "2 prestations sélectionnées")
  assert.equal(stepSummary("workers", rempli), "1 travailleur")
  assert.equal(stepSummary("plan", rempli), "Forfait Essentiel")
  assert.equal(stepSummary("review", rempli), "Prêt à confirmer")

  // Une station sans ville n'affiche pas de séparateur orphelin.
  assert.equal(
    stepSummary("station", { ...rempli, station_data: { name: "Star Wash" } }),
    "Star Wash",
  )
  // Pluriel singulier correct.
  assert.equal(
    stepSummary("services", {
      ...rempli,
      services_data: { selected: [], custom: [{ name: "Cire", price_cents: null }] },
    }),
    "1 prestation sélectionnée",
  )
})

test("planLabel rend un code lisible", () => {
  assert.equal(planLabel("starter"), "Starter")
  assert.equal(planLabel("plan_pro"), "Plan pro")
  assert.equal(planLabel(null), "Aucun forfait")
})
