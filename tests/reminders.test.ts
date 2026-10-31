import test from "node:test"
import assert from "node:assert/strict"
import { planReminder, REMINDER_KINDS } from "../server/reminders.ts"
import {
  normalizeWhatsAppNumber,
  formatWhatsAppNumber,
  buildWhatsAppUrl,
} from "../server/support.ts"
import { backupFileName } from "../server/backup.ts"

// ---------------------------------------------------------------------------
// Relances d'échéance
// ---------------------------------------------------------------------------

test("trois relances au maximum", () => {
  assert.deepEqual([...REMINDER_KINDS], ["trial_j3", "trial_j1", "trial_expired"])
})

test("aucune relance tant que l'essai a plus de trois jours devant lui", () => {
  assert.equal(planReminder({ is_trial: true, is_expired: false, days_remaining: 9 }), null)
  assert.equal(planReminder({ is_trial: true, is_expired: false, days_remaining: 4 }), null)
})

test("relance J-3 dès qu'il reste trois jours", () => {
  assert.equal(planReminder({ is_trial: true, is_expired: false, days_remaining: 3 }), "trial_j3")
  assert.equal(planReminder({ is_trial: true, is_expired: false, days_remaining: 2 }), "trial_j3")
})

test("relance J-1 le dernier jour", () => {
  assert.equal(planReminder({ is_trial: true, is_expired: false, days_remaining: 1 }), "trial_j1")
})

test("relance d'expiration quand l'essai est terminé", () => {
  assert.equal(planReminder({ is_trial: false, is_expired: true, days_remaining: 0 }), "trial_expired")
})

test("une relance déjà envoyée n'est jamais renvoyée", () => {
  assert.equal(
    planReminder({ is_trial: true, is_expired: false, days_remaining: 2 }, ["trial_j3"]),
    null,
  )
  assert.equal(
    planReminder({ is_trial: false, is_expired: true, days_remaining: 0 }, ["trial_expired"]),
    null,
  )
})

test("la relance J-1 passe même si la J-3 a déjà été envoyée", () => {
  assert.equal(
    planReminder({ is_trial: true, is_expired: false, days_remaining: 1 }, ["trial_j3"]),
    "trial_j1",
  )
})

test("un abonnement payant actif n'est jamais relancé", () => {
  assert.equal(planReminder({ is_trial: false, is_expired: false, days_remaining: 12 }), null)
})

// ---------------------------------------------------------------------------
// Assistance WhatsApp
// ---------------------------------------------------------------------------

test("le numéro WhatsApp est réduit à ses chiffres", () => {
  assert.equal(normalizeWhatsAppNumber("+225 07 00 00 00 00"), "2250700000000")
  assert.equal(normalizeWhatsAppNumber("(225) 07-00-00-00-00"), "2250700000000")
})

test("le numéro ivoirien est affiché par groupes de deux chiffres", () => {
  assert.equal(formatWhatsAppNumber("2250700000000"), "+225 07 00 00 00 00")
})

test("le lien WhatsApp encode le message pré-rempli", () => {
  const url = buildWhatsAppUrl("+225 07 00 00 00 00", "Bonjour, j’ai besoin d’aide")
  assert.ok(url.startsWith("https://wa.me/2250700000000?text="))
  assert.ok(url.includes("Bonjour"))
  assert.ok(!url.includes(" "))
})

test("sans numéro configuré, aucun lien n'est produit", () => {
  assert.equal(buildWhatsAppUrl("", "Bonjour"), "")
})

// ---------------------------------------------------------------------------
// Sauvegarde
// ---------------------------------------------------------------------------

test("le nom du fichier de sauvegarde est lisible et daté", () => {
  const name = backupFileName("Station Cocody Angré", new Date("2026-10-20T08:00:00Z"))
  assert.equal(name, "washpilot-sauvegarde-station-cocody-angre-2026-10-20.json")
})

test("le nom de fichier reste valide sans nom de station", () => {
  const name = backupFileName(null, new Date("2026-01-05T08:00:00Z"))
  assert.equal(name, "washpilot-sauvegarde-washpilot-2026-01-05.json")
})
