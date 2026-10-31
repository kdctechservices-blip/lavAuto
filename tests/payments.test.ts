import test from "node:test"
import assert from "node:assert/strict"
import {
  PAYMENT_METHODS,
  MOBILE_MONEY_METHODS,
  initialPaymentStatus,
  resolveWashPaymentStatus,
  remainingDueCents,
} from "../server/payments.ts"

// ---------------------------------------------------------------------------
// Encaissements : règles métier pures
// ---------------------------------------------------------------------------

test("les six moyens de paiement de la station sont couverts", () => {
  assert.deepEqual([...PAYMENT_METHODS], [
    "cash",
    "orange_money",
    "mtn_momo",
    "moov_money",
    "wave",
    "other",
  ])
})

test("les espèces sont confirmées immédiatement, le mobile money reste à confirmer", () => {
  assert.equal(initialPaymentStatus("cash"), "verified")
  for (const method of MOBILE_MONEY_METHODS) {
    assert.equal(initialPaymentStatus(method), "pending", `${method} devrait rester à confirmer`)
  }
})

test("le solde restant ignore les paiements remboursés", () => {
  const payments = [
    { amount_cents: 2000, status: "verified" },
    { amount_cents: 1000, status: "pending" },
    { amount_cents: 5000, status: "refunded" },
  ]
  assert.equal(remainingDueCents(10_000, payments), 7_000)
})

test("le solde restant ne devient jamais négatif", () => {
  assert.equal(remainingDueCents(3_000, [{ amount_cents: 5_000, status: "verified" }]), 0)
})

test("le statut du lavage suit le cumul encaissé", () => {
  assert.equal(resolveWashPaymentStatus(10_000, 0), "unpaid")
  assert.equal(resolveWashPaymentStatus(10_000, 4_000), "partial")
  assert.equal(resolveWashPaymentStatus(10_000, 10_000), "paid")
  assert.equal(resolveWashPaymentStatus(10_000, 12_000), "paid")
})

test("un lavage gratuit est considéré comme réglé", () => {
  assert.equal(resolveWashPaymentStatus(0, 0), "paid")
})
