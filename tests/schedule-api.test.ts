/**
 * Horaires de travail — conversions côté interface et non-divergence serveur.
 *
 * `src/` ne peut pas importer `server/` : les bornes sont donc recopiées dans
 * src/lib/schedule-api.ts. Ces tests relisent le fichier serveur pour vérifier
 * qu'elles n'ont pas divergé — un écart silencieux produirait un formulaire qui
 * accepte une valeur que le serveur refuse.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  DAYS_OF_WEEK,
  MAX_BREAK_MINUTES,
  MAX_LATE_TOLERANCE_MINUTES,
  MAX_MINUTE_OF_DAY,
  MIN_MINUTE_OF_DAY,
  describeScope,
  describeWhen,
  formatDuration,
  formatMinuteOfDay,
  isExpired,
  parseMinuteOfDay,
} from "../src/lib/schedule-api.ts"

const serverSource = readFileSync(new URL("../server/attendance.ts", import.meta.url), "utf8")

test("les bornes d'une heure de la journée n'ont pas divergé du serveur", () => {
  const match = /minuteOfDaySchema\s*=\s*z\.number\(\)\.int\(\)\.min\((\d+)\)\.max\((\d+)\)/.exec(serverSource)
  assert.ok(match, "minuteOfDaySchema introuvable dans server/attendance.ts")
  assert.equal(Number(match[1]), MIN_MINUTE_OF_DAY)
  assert.equal(Number(match[2]), MAX_MINUTE_OF_DAY)
})

test("la tolérance de retard maximale n'a pas divergé du serveur", () => {
  const match = /late_tolerance_minutes:\s*z\.number\(\)\.int\(\)\.min\(\d+\)\.max\((\d+)\)/.exec(serverSource)
  assert.ok(match, "late_tolerance_minutes introuvable dans server/attendance.ts")
  assert.equal(Number(match[1]), MAX_LATE_TOLERANCE_MINUTES)
})

test("la pause maximale n'a pas divergé du serveur", () => {
  const match = /break_duration_minutes:\s*z\.number\(\)\.int\(\)\.min\(\d+\)\.max\((\d+)\)/.exec(serverSource)
  assert.ok(match, "break_duration_minutes introuvable dans server/attendance.ts")
  assert.equal(Number(match[1]), MAX_BREAK_MINUTES)
})

test("les jours de la semaine couvrent la plage acceptée par le serveur", () => {
  const match = /day_of_week:\s*z\.number\(\)\.int\(\)\.min\((\d+)\)\.max\((\d+)\)/.exec(serverSource)
  assert.ok(match, "day_of_week introuvable dans server/attendance.ts")
  const valeurs = DAYS_OF_WEEK.map((d) => d.value)
  assert.equal(Math.min(...valeurs), Number(match[1]))
  assert.equal(Math.max(...valeurs), Number(match[2]))
  assert.equal(new Set(valeurs).size, 7, "chaque jour doit apparaître une seule fois")
})

test("les minutes depuis minuit s'affichent en heures lisibles", () => {
  assert.equal(formatMinuteOfDay(0), "00:00")
  assert.equal(formatMinuteOfDay(480), "08:00")
  assert.equal(formatMinuteOfDay(1439), "23:59")
  assert.equal(formatMinuteOfDay(545), "09:05")
})

test("une minute hors bornes ne produit jamais une fausse heure", () => {
  assert.equal(formatMinuteOfDay(null), "—")
  assert.equal(formatMinuteOfDay(undefined), "—")
  assert.equal(formatMinuteOfDay(-1), "—")
  assert.equal(formatMinuteOfDay(1440), "—")
  assert.equal(formatMinuteOfDay(12.5), "—")
})

test("une heure saisie revient en minutes depuis minuit", () => {
  assert.equal(parseMinuteOfDay("08:00"), 480)
  assert.equal(parseMinuteOfDay("8:00"), 480)
  assert.equal(parseMinuteOfDay("23:59"), 1439)
  assert.equal(parseMinuteOfDay(" 07:30 "), 450)
})

test("une saisie d'heure invalide est refusée plutôt qu'approximée", () => {
  assert.equal(parseMinuteOfDay(""), null)
  assert.equal(parseMinuteOfDay("24:00"), null)
  assert.equal(parseMinuteOfDay("08:60"), null)
  assert.equal(parseMinuteOfDay("huit heures"), null)
  assert.equal(parseMinuteOfDay("08h00"), null)
})

test("aller-retour heure et minutes sur toute la journée", () => {
  for (let m = MIN_MINUTE_OF_DAY; m <= MAX_MINUTE_OF_DAY; m += 1) {
    assert.equal(parseMinuteOfDay(formatMinuteOfDay(m)), m)
  }
})

test("une durée s'écrit en heures et minutes", () => {
  assert.equal(formatDuration(0), "0 min")
  assert.equal(formatDuration(45), "45 min")
  assert.equal(formatDuration(60), "1 h")
  assert.equal(formatDuration(510), "8 h 30")
  assert.equal(formatDuration(-5), "—")
})

test("la portée d'un horaire se lit en clair, du plus précis au plus général", () => {
  assert.equal(describeScope({ worker_id: "w1", site_id: "s1" }, "Koffi Yao", "Yopougon"), "Koffi Yao")
  assert.equal(describeScope({ worker_id: null, site_id: "s1" }, null, "Yopougon"), "Toute la station Yopougon")
  assert.equal(describeScope({ worker_id: null, site_id: null }, null, null), "Tout le monde")
})

test("la récurrence d'un horaire se lit en clair", () => {
  assert.equal(describeWhen({ day_of_week: null, specific_date: "2026-10-21" }), "Le 2026-10-21")
  assert.equal(describeWhen({ day_of_week: 1, specific_date: null }), "Chaque lundi")
  assert.equal(describeWhen({ day_of_week: 0, specific_date: null }), "Chaque dimanche")
  assert.equal(describeWhen({ day_of_week: null, specific_date: null }), "Tous les jours")
})

test("un horaire sans date de fin ne périme jamais", () => {
  assert.equal(isExpired({ valid_to: null }, "2026-10-21"), false)
})

test("un horaire dont la date de fin est passée est signalé comme périmé", () => {
  assert.equal(isExpired({ valid_to: "2026-10-20" }, "2026-10-21"), true)
  assert.equal(isExpired({ valid_to: "2026-10-21" }, "2026-10-21"), false, "le dernier jour reste valable")
  assert.equal(isExpired({ valid_to: "2026-12-31" }, "2026-10-21"), false)
})
