import test from "node:test"
import assert from "node:assert/strict"
import {
  PUBLIC_BUSINESS_HOURS_PER_DAY,
  PUBLIC_RESPONSE_HOURS,
  PUBLIC_TRIAL_DAYS,
  publicResponseLabel,
} from "../src/config/pricing.ts"
import {
  BUSINESS_HOURS_PER_DAY,
  RESPONSE_COMMITMENT_HOURS,
  commitmentLabel,
} from "../server/support-sla.ts"
import { TRIAL_DAYS } from "../server/entitlements.ts"

// ---------------------------------------------------------------------------
// Ce que la page tarifaire promet doit être ce que le produit tient.
//
// Les deux valeurs sont forcément dupliquées — la page est servie au
// navigateur, les échéances sont calculées sur le serveur. La duplication
// n'est pas le problème ; la dérive silencieuse l'est. Un prix affiché que le
// produit ne respecte pas est un litige, pas un bogue.
//
// `PUBLIC_TRIAL_DAYS` portait déjà un commentaire « doit rester égal à
// TRIAL_DAYS » sans que rien ne le vérifie. C'est désormais vérifié.
// ---------------------------------------------------------------------------

test("la durée d'essai annoncée est celle que le produit applique", () => {
  assert.equal(PUBLIC_TRIAL_DAYS, TRIAL_DAYS)
})

test("les délais de réponse annoncés sont ceux que la console mesure", () => {
  for (const plan of ["starter", "pro", "business"]) {
    assert.equal(
      PUBLIC_RESPONSE_HOURS[plan],
      RESPONSE_COMMITMENT_HOURS[plan],
      `le forfait ${plan} promet un délai que le serveur ne tient pas`,
    )
  }
})

test("aucun forfait vendu n'est oublié par l'engagement", () => {
  assert.deepEqual(
    Object.keys(PUBLIC_RESPONSE_HOURS).sort(),
    Object.keys(RESPONSE_COMMITMENT_HOURS).sort(),
  )
})

test("la journée ouvrée affichée est celle du calcul", () => {
  assert.equal(PUBLIC_BUSINESS_HOURS_PER_DAY, BUSINESS_HOURS_PER_DAY)
})

test("les libellés affichés disent la même chose des deux côtés", () => {
  // Les nombres pourraient concorder et les mots diverger : « 10 heures »
  // d'un côté, « 1 jour ouvré » de l'autre, pour la même promesse.
  for (const hours of Object.values(PUBLIC_RESPONSE_HOURS)) {
    assert.equal(publicResponseLabel(hours), commitmentLabel(hours))
  }
})
