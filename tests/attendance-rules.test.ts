import test from "node:test"
import assert from "node:assert/strict"
import {
  evaluateLateness,
  workedMinutes,
  isCoherent,
  dayState,
  shareMilli,
  tally,
  perPresentDay,
  perWorkedHour,
  minuteOfDay,
  formatMinuteOfDay,
  resolveSchedule,
  type ScheduleRule,
} from "../server/attendance-rules.ts"

// ---------------------------------------------------------------------------
// Le cœur de règles, éprouvé sans base ni serveur.
//
// Ces tests portent moins sur l'arithmétique que sur trois refus : refuser de
// transformer une donnée manquante en zéro, refuser de déduire une absence
// d'un silence, refuser de compter un lavage plusieurs fois.
// ---------------------------------------------------------------------------

const horaire: ScheduleRule = {
  startMinute: 7 * 60, // 07:00
  endMinute: 18 * 60,
  lateToleranceMinutes: 15,
  breakDurationMinutes: 60,
}

// ----------------------------------------------------------------- retard --

test("sans horaire configuré, personne n'est jamais en retard", () => {
  // Une station ouvre à 6 h, une autre à 9 h. Décréter une heure par défaut
  // fabriquerait des retards imaginaires dès le premier jour.
  const r = evaluateLateness(10 * 60, null)
  assert.equal(r.late, false)
  assert.equal(r.unknown, true)
  assert.equal(r.lateMinutes, null, "on ne chiffre pas un retard qui n'a pas de référence")
})

test("arriver dans la tolérance n'est pas un retard", () => {
  const r = evaluateLateness(7 * 60 + 15, horaire)
  assert.equal(r.late, false)
  assert.equal(r.lateMinutes, 0)
})

test("le retard se compte depuis l'heure prévue, pas depuis la fin de la tolérance", () => {
  // Arrivée à 7 h 40, prévu 7 h, tolérance 15 min. Le retard est de 40
  // minutes, pas de 25 : la tolérance dit quand on le signale, pas quand il
  // commence.
  const r = evaluateLateness(7 * 60 + 40, horaire)
  assert.equal(r.late, true)
  assert.equal(r.lateMinutes, 40)
})

test("sans pointage d'arrivée, le retard est indéterminé", () => {
  const r = evaluateLateness(null, horaire)
  assert.equal(r.unknown, true)
  assert.equal(r.lateMinutes, null)
})

// ------------------------------------------------------- heures pointées --

test("un pointage incomplet ne vaut pas zéro heure, il vaut inconnu", () => {
  // Le point le plus important du fichier. Un zéro se moyenne et se reproche ;
  // un inconnu appelle une correction.
  assert.equal(workedMinutes(7 * 60, null, null), null)
  assert.equal(workedMinutes(null, 18 * 60, null), null)
})

test("les heures se comptent des pointages réels", () => {
  assert.equal(workedMinutes(7 * 60, 17 * 60, null), 600)
})

test("une pause ne se retranche que si elle a été relevée", () => {
  // L'horaire prévoit 60 minutes de pause, mais rien n'a été pointé : on ne
  // retire pas du temps de travail sur la foi d'un paramètre.
  assert.equal(workedMinutes(7 * 60, 17 * 60, null), 600, "pause prévue mais non relevée")
  assert.equal(workedMinutes(7 * 60, 17 * 60, 45), 555, "pause réellement relevée")
})

test("un départ antérieur à l'arrivée est incohérent, pas négatif", () => {
  assert.equal(isCoherent(17 * 60, 7 * 60), false)
  assert.equal(workedMinutes(17 * 60, 7 * 60, null), null)
  assert.equal(isCoherent(7 * 60, null), true, "un pointage en cours reste cohérent")
})

// -------------------------------------------------------- état du jour --

test("l'absence de relevé n'est pas une absence", () => {
  assert.equal(dayState(null, horaire), "not_recorded")
})

test("une absence déclarée ne devient pas non justifiée toute seule", () => {
  const etat = dayState({ status: "absent_declared", checkInMinute: null, checkOutMinute: null }, horaire)
  assert.equal(etat, "absent_declared", "seule une validation explicite peut la requalifier")
})

test("les états de présence se distinguent correctement", () => {
  assert.equal(dayState({ status: "present", checkInMinute: 7 * 60, checkOutMinute: null }, horaire), "present")
  assert.equal(dayState({ status: "present", checkInMinute: 8 * 60, checkOutMinute: null }, horaire), "late")
  assert.equal(dayState({ status: "present", checkInMinute: 7 * 60, checkOutMinute: 17 * 60 }, horaire), "left")
  assert.equal(dayState({ status: "present", checkInMinute: null, checkOutMinute: null }, horaire), "incomplete")
})

test("sans horaire, un pointage tardif reste un simple pointage", () => {
  assert.equal(dayState({ status: "present", checkInMinute: 11 * 60, checkOutMinute: null }, null), "present")
})

// ------------------------------------------------------------ attribution --

test("un lavage fait à trois ne compte pas trois fois", () => {
  assert.equal(shareMilli(1), 1000)
  assert.equal(shareMilli(2), 500)
  assert.equal(shareMilli(3), 333)
})

test("les trois nombres d'une personne disent trois choses différentes", () => {
  const t = tally([
    { washId: "a", isPrincipal: true, participantCount: 1 },
    { washId: "b", isPrincipal: false, participantCount: 3 },
    { washId: "c", isPrincipal: true, participantCount: 2 },
  ])
  assert.equal(t.participations, 3, "elle a pris part à trois lavages")
  assert.equal(t.asPrincipal, 2, "elle en a mené deux")
  assert.equal(t.shareMilliTotal, 1000 + 333 + 500, "la part de travail qui lui revient")
})

test("une affectation remontée deux fois ne pèse qu'une fois", () => {
  const t = tally([
    { washId: "a", isPrincipal: false, participantCount: 2 },
    { washId: "a", isPrincipal: false, participantCount: 2 },
  ])
  assert.equal(t.participations, 1)
  assert.equal(t.shareMilliTotal, 500)
})

test("la somme des quote-parts d'une équipe reste celle du travail fait", () => {
  // Un lavage à trois, réparti : la station en affiche un, et les trois
  // quote-parts l'approchent sans jamais le dépasser.
  const equipe = ["x", "y", "z"].map(() => tally([{ washId: "w1", isPrincipal: false, participantCount: 3 }]))
  const somme = equipe.reduce((s, t) => s + t.shareMilliTotal, 0)
  assert.ok(somme <= 1000, `la somme ${somme} ne doit jamais gonfler le lavage unique`)
  assert.equal(somme, 999, "un millième se perd à l'arrondi, et c'est sans conséquence")
})

// ------------------------------------------------------------- rendement --

test("aucun rendement n'est calculé sans jour de présence", () => {
  assert.equal(perPresentDay(5000, 0), null, "diviser par zéro ne donne pas zéro")
})

test("aucun rendement horaire sans temps pointé", () => {
  // Le cas le plus fréquent au démarrage : personne ne pointe encore.
  assert.equal(perWorkedHour(5000, null), null)
  assert.equal(perWorkedHour(5000, 0), null)
})

test("les rendements se calculent quand les données existent", () => {
  assert.equal(perPresentDay(6000, 3), 2000, "6 lavages sur 3 jours : 2 par jour")
  assert.equal(perWorkedHour(4000, 480), 500, "4 lavages en 8 heures : une demie par heure")
})

// ------------------------------------------------------------- horaires --

test("la lecture d'une heure refuse ce qui n'est pas une heure", () => {
  assert.equal(minuteOfDay("08:30"), 510)
  assert.equal(minuteOfDay("00:00"), 0)
  assert.equal(minuteOfDay("25:00"), null)
  assert.equal(minuteOfDay("08:70"), null)
  assert.equal(minuteOfDay(null), null)
  assert.equal(minuteOfDay(""), null)
})

test("l'écriture d'une heure est stable", () => {
  assert.equal(formatMinuteOfDay(510), "08:30")
  assert.equal(formatMinuteOfDay(0), "00:00")
  assert.equal(formatMinuteOfDay(minuteOfDay("17:05") as number), "17:05")
})

// ------------------------------------------------------ horaire applicable --

const base = {
  startMinute: 7 * 60,
  endMinute: 18 * 60,
  lateToleranceMinutes: 15,
  breakDurationMinutes: 0,
  validFrom: "2026-01-01",
  validTo: null,
  workerId: null,
  siteId: null,
  dayOfWeek: null,
  specificDate: null,
}

test("sans horaire enregistré, aucun horaire ne s'applique", () => {
  assert.equal(resolveSchedule([], "w1", "s1", "2026-10-21", 3), null)
})

test("l'horaire d'une personne prime sur celui de la station", () => {
  const r = resolveSchedule(
    [base, { ...base, workerId: "w1", startMinute: 9 * 60 }],
    "w1",
    "s1",
    "2026-10-21",
    3,
  )
  assert.equal(r?.startMinute, 9 * 60)
})

test("l'exception du jour prime sur l'habitude de la semaine", () => {
  const r = resolveSchedule(
    [
      { ...base, dayOfWeek: 3, startMinute: 7 * 60 },
      { ...base, specificDate: "2026-10-21", startMinute: 10 * 60 },
    ],
    "w1",
    "s1",
    "2026-10-21",
    3,
  )
  assert.equal(r?.startMinute, 10 * 60, "ce mercredi-là, on commence à 10 h")
})

test("un horaire périmé ne s'applique plus", () => {
  const r = resolveSchedule([{ ...base, validTo: "2026-09-30" }], "w1", "s1", "2026-10-21", 3)
  assert.equal(r, null)
})

test("l'horaire d'une autre station ne s'applique pas", () => {
  const r = resolveSchedule([{ ...base, siteId: "autre" }], "w1", "s1", "2026-10-21", 3)
  assert.equal(r, null)
})

test("l'horaire d'un autre laveur ne s'applique pas", () => {
  const r = resolveSchedule([{ ...base, workerId: "w2", startMinute: 9 * 60 }], "w1", "s1", "2026-10-21", 3)
  assert.equal(r, null, "il ne doit pas non plus retomber silencieusement sur un autre")
})
