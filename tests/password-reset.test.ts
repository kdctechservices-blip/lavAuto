import { test } from "node:test"
import assert from "node:assert/strict"
import type { Request } from "express"
import { buildResetUrl } from "../server/auth-router.ts"
import { passwordResetMessage, isMailerConfigured } from "../server/mailer.ts"

/** Requête Express minimale : seules les méthodes utilisées par buildResetUrl. */
function fakeRequest(headers: Record<string, string>, protocol = "http"): Request {
  return {
    protocol,
    get(name: string) {
      return headers[name.toLowerCase()]
    },
  } as unknown as Request
}

test("buildResetUrl pointe vers la page de réinitialisation du frontend", () => {
  const url = buildResetUrl(fakeRequest({ host: "localhost:3000" }), "jeton-abc")
  assert.equal(url, "http://localhost:3000/auth/reset-password?token=jeton-abc")
})

test("buildResetUrl respecte le protocole annoncé par le proxy", () => {
  const url = buildResetUrl(
    fakeRequest({ host: "app.washpilot.ci", "x-forwarded-proto": "https" }),
    "jeton",
  )
  assert.ok(url.startsWith("https://app.washpilot.ci/auth/reset-password"))
})

test("buildResetUrl encode les jetons contenant des caractères réservés", () => {
  const url = buildResetUrl(fakeRequest({ host: "localhost:3000" }), "a+b/c=d")
  assert.ok(url.endsWith("?token=a%2Bb%2Fc%3Dd"))
  assert.equal(new URL(url).searchParams.get("token"), "a+b/c=d")
})

test("buildResetUrl ignore une origine non autorisée", () => {
  const url = buildResetUrl(
    fakeRequest({ host: "localhost:3000", origin: "https://attaquant.example" }),
    "jeton",
  )
  assert.ok(!url.includes("attaquant.example"))
})

test("passwordResetMessage contient le lien et la durée de validité", () => {
  const message = passwordResetMessage(
    "awa@washpilot.ci",
    "https://app.washpilot.ci/auth/reset-password?token=jeton",
    60,
  )
  assert.equal(message.to, "awa@washpilot.ci")
  assert.match(message.subject, /mot de passe/i)
  assert.ok(message.text.includes("https://app.washpilot.ci/auth/reset-password?token=jeton"))
  assert.ok(message.html?.includes("1 heure"))
})

test("passwordResetMessage formate les validités courtes en minutes", () => {
  const message = passwordResetMessage("awa@washpilot.ci", "https://example.ci/r", 30)
  assert.ok(message.text.includes("30 minutes"))
})

test("isMailerConfigured est faux sans clé d'API", () => {
  // Les tests tournent sans RESEND_API_KEY : le transport retombe sur la journalisation.
  assert.equal(isMailerConfigured(), Boolean(process.env.RESEND_API_KEY))
})
