import test from "node:test"
import assert from "node:assert/strict"
import {
  BUSINESS_DAY_END_HOUR,
  BUSINESS_DAY_START_HOUR,
  BUSINESS_HOURS_PER_DAY,
  RESPONSE_COMMITMENT_HOURS,
  addBusinessHours,
  businessHoursBetween,
  commitmentFor,
  commitmentLabel,
  nextBusinessInstant,
  responseDueAt,
  slaState,
} from "../server/support-sla.ts"

// ---------------------------------------------------------------------------
// L'arithmétique des heures ouvrées
//
// Tout l'engagement « assistance prioritaire » repose sur ces fonctions. Si
// elles se trompent, l'éditeur promet un délai qu'il ne tient pas, ou se croit
// en retard sans l'être. Les montants ne sont pas en jeu, la crédibilité si.
//
// Abidjan est à UTC+0 toute l'année : les dates ci-dessous sont donc
// directement lisibles en heure locale.
// ---------------------------------------------------------------------------

/** 2026-10-21 est un mercredi. Repère unique pour toute la suite. */
const MERCREDI_10H = new Date("2026-10-21T10:00:00Z")

test("le repère de la suite est bien un mercredi", () => {
  // Si cette ligne tombe, tous les tests suivants parlent d'autre chose.
  assert.equal(MERCREDI_10H.getUTCDay(), 3)
})

test("une demande en pleine journée court depuis son instant", () => {
  assert.equal(nextBusinessInstant(MERCREDI_10H).toISOString(), MERCREDI_10H.toISOString())
})

test("une demande avant l'ouverture attend l'ouverture", () => {
  const avant = new Date("2026-10-21T05:30:00Z")
  assert.equal(nextBusinessInstant(avant).toISOString(), "2026-10-21T08:00:00.000Z")
})

test("une demande après la fermeture bascule au lendemain", () => {
  const soir = new Date("2026-10-21T22:00:00Z")
  assert.equal(nextBusinessInstant(soir).toISOString(), "2026-10-22T08:00:00.000Z")
})

test("une demande du samedi soir démarre lundi matin", () => {
  // Le client n'est pas pénalisé pour avoir écrit le week-end : son compteur
  // démarre lundi 8 h, pas samedi 23 h.
  const samedi = new Date("2026-10-24T23:00:00Z")
  assert.equal(samedi.getUTCDay(), 6, "2026-10-24 est bien un samedi")
  const start = nextBusinessInstant(samedi)
  assert.equal(start.toISOString(), "2026-10-26T08:00:00.000Z")
  assert.equal(start.getUTCDay(), 1, "lundi")
})

test("quatre heures ouvrées depuis mercredi 10 h tombent le même jour", () => {
  assert.equal(addBusinessHours(MERCREDI_10H, 4).toISOString(), "2026-10-21T14:00:00.000Z")
})

test("une échéance qui dépasse la fermeture reprend le lendemain", () => {
  // De 10 h à 18 h il y a 8 heures ; les 4 restantes tombent jeudi dès 8 h,
  // donc à 12 h. (Première version de ce test : 10 h — faux. Le test de
  // propriété, lui, était passé : un exemple écrit à la main se trompe plus
  // facilement qu'une propriété vérifiée sur six mille tirages.)
  const due = addBusinessHours(MERCREDI_10H, 12)
  assert.equal(due.toISOString(), "2026-10-22T12:00:00.000Z")
})

test("le week-end ne consomme aucune heure", () => {
  // Vendredi 16 h + 4 h ouvrées : 2 h vendredi, puis lundi de 8 h à 10 h.
  const vendredi = new Date("2026-10-23T16:00:00Z")
  assert.equal(vendredi.getUTCDay(), 5)
  const due = addBusinessHours(vendredi, 4)
  assert.equal(due.toISOString(), "2026-10-26T10:00:00.000Z")
  assert.equal(due.getUTCDay(), 1)
})

test("trois jours ouvrés depuis jeudi tombent le mardi suivant", () => {
  const jeudi = new Date("2026-10-22T09:00:00Z")
  const due = addBusinessHours(jeudi, BUSINESS_HOURS_PER_DAY * 3)
  assert.equal(due.toISOString(), "2026-10-27T09:00:00.000Z")
  assert.equal(due.getUTCDay(), 2, "mardi")
})

test("une échéance tombe toujours dans une fenêtre ouvrée", () => {
  // Propriété, pas exemple : on balaie une année entière d'instants de départ
  // plutôt que de choisir trois dates qui arrangent.
  const base = Date.parse("2026-01-01T00:00:00Z")
  for (let i = 0; i < 2000; i += 1) {
    const start = new Date(base + i * 4_337_000) // pas non aligné sur 24 h
    for (const hours of [1, 4, 10, 30]) {
      const due = addBusinessHours(start, hours)
      const day = due.getUTCDay()
      assert.ok(day >= 1 && day <= 5, `${due.toISOString()} tombe un week-end`)
      const h = due.getUTCHours() + due.getUTCMinutes() / 60
      assert.ok(
        h >= BUSINESS_DAY_START_HOUR && h <= BUSINESS_DAY_END_HOUR,
        `${due.toISOString()} est hors de la fenêtre`,
      )
    }
  }
})

test("les deux implémentations sont d'accord sur des milliers de tirages", () => {
  // `addBusinessHours` consomme un solde ; `businessHoursBetween` balaie les
  // journées. Deux raisonnements différents : s'ils concordent partout, c'est
  // que l'arithmétique tient. Un seul des deux aurait pu être faux en silence.
  const base = Date.parse("2026-02-02T00:00:00Z")
  let checked = 0
  for (let i = 0; i < 1500; i += 1) {
    const start = new Date(base + i * 5_113_000)
    for (const hours of [0.5, 3, 10, 27]) {
      const due = addBusinessHours(start, hours)
      const measured = businessHoursBetween(nextBusinessInstant(start), due)
      assert.ok(
        Math.abs(measured - hours) < 1e-6,
        `départ ${start.toISOString()} + ${hours} h -> ${due.toISOString()} mesuré ${measured}`,
      )
      checked += 1
    }
  }
  assert.equal(checked, 6000)
})

test("l'échéance ne recule jamais quand la demande arrive plus tard", () => {
  // Monotonie : deux demandes d'un même forfait ne peuvent pas se doubler.
  const base = Date.parse("2026-03-02T00:00:00Z")
  let previous = addBusinessHours(new Date(base), 10)
  for (let i = 1; i < 1200; i += 1) {
    const due = addBusinessHours(new Date(base + i * 1_111_000), 10)
    assert.ok(due >= previous, `recul à l'itération ${i}`)
    previous = due
  }
})

test("une journée complète vaut dix heures, un week-end zéro", () => {
  assert.equal(
    businessHoursBetween(new Date("2026-10-21T00:00:00Z"), new Date("2026-10-22T00:00:00Z")),
    10,
  )
  assert.equal(
    businessHoursBetween(new Date("2026-10-24T00:00:00Z"), new Date("2026-10-26T00:00:00Z")),
    0,
  )
})

test("les engagements vendus sont ceux qu'on croit", () => {
  assert.equal(RESPONSE_COMMITMENT_HOURS.business, 4)
  assert.equal(commitmentFor("pro"), 10)
  assert.equal(commitmentFor("starter"), 30)
  // Un essai n'achète rien : il reçoit le maximum indicatif, pas un engagement.
  assert.equal(commitmentFor(null), 50)
  assert.equal(commitmentFor("forfait_inconnu"), 50)
})

test("un Business est servi avant un Starter reçu en même temps", () => {
  // La « priorité » du forfait Pro n'est pas un badge : elle se lit sur
  // l'échéance, et c'est elle qui ordonne la file de la console.
  const business = responseDueAt(MERCREDI_10H, "business")
  const pro = responseDueAt(MERCREDI_10H, "pro")
  const starter = responseDueAt(MERCREDI_10H, "starter")
  assert.ok(business < pro, "Business passe avant Pro")
  assert.ok(pro < starter, "Pro passe avant Starter")
})

test("les libellés affichés au client sont lisibles", () => {
  assert.equal(commitmentLabel(4), "4 heures ouvrées")
  assert.equal(commitmentLabel(10), "1 jour ouvré")
  assert.equal(commitmentLabel(30), "3 jours ouvrés")
})

test("le retard se mesure en négatif, il ne s'arrondit pas à zéro", () => {
  // Premier défaut trouvé en écrivant ce fichier : `businessHoursBetween`
  // renvoie 0 quand la fin précède le début, donc un retard affichait 0 h.
  const due = new Date("2026-10-21T10:00:00Z")
  const maintenant = new Date("2026-10-21T15:00:00Z")
  const state = slaState(due, null, maintenant)
  assert.equal(state.breached, true)
  assert.equal(state.hours_remaining, -5, "cinq heures de retard, pas zéro")
})

test("une demande dans les temps affiche ce qu'il reste", () => {
  const due = new Date("2026-10-21T16:00:00Z")
  const state = slaState(due, null, new Date("2026-10-21T10:00:00Z"))
  assert.equal(state.breached, false)
  assert.equal(state.hours_remaining, 6)
})

test("une réponse tardive reste tardive", () => {
  // On ne réécrit pas l'histoire : sans cela, la mesure ne vaudrait rien.
  const due = new Date("2026-10-21T10:00:00Z")
  const state = slaState(due, new Date("2026-10-21T17:00:00Z"), new Date("2026-10-30T09:00:00Z"))
  assert.equal(state.responded, true)
  assert.equal(state.breached, true)
})

test("une réponse dans les temps n'est jamais marquée en retard", () => {
  const due = new Date("2026-10-21T16:00:00Z")
  const state = slaState(due, new Date("2026-10-21T11:00:00Z"), new Date("2026-11-30T09:00:00Z"))
  assert.equal(state.breached, false, "même consultée des semaines plus tard")
  assert.equal(state.hours_remaining, 0)
})
