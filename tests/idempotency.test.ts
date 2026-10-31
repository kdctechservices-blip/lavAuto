import { test } from "node:test"
import assert from "node:assert/strict"
import { fingerprint, requireIdempotencyKey, stableStringify } from "../server/idempotency.ts"

test("stableStringify orders object keys so equal payloads match", () => {
  const a = stableStringify({ b: 1, a: { d: 2, c: 3 } })
  const b = stableStringify({ a: { c: 3, d: 2 }, b: 1 })
  assert.equal(a, b)
})

test("fingerprint is stable for logically equal payloads", () => {
  const a = fingerprint({ site_id: "s1", items: [{ service_id: "x", quantity: 2 }] })
  const b = fingerprint({ items: [{ quantity: 2, service_id: "x" }], site_id: "s1" })
  assert.equal(a, b)
})

test("fingerprint changes when the payload changes", () => {
  const a = fingerprint({ amount_cents: 1000 })
  const b = fingerprint({ amount_cents: 1001 })
  assert.notEqual(a, b)
})

test("fingerprint keeps array order significant", () => {
  const a = fingerprint({ items: [1, 2] })
  const b = fingerprint({ items: [2, 1] })
  assert.notEqual(a, b)
})

test("requireIdempotencyKey accepts a normal UUID-style key", () => {
  assert.equal(requireIdempotencyKey("3f2c7a1e-9d42-4a08-a600-2f4f7a9b1c11"), "3f2c7a1e-9d42-4a08-a600-2f4f7a9b1c11")
})

test("requireIdempotencyKey trims surrounding whitespace", () => {
  assert.equal(requireIdempotencyKey("  abc123  "), "abc123")
})

test("requireIdempotencyKey rejects missing or empty keys", () => {
  assert.throws(() => requireIdempotencyKey(undefined))
  assert.throws(() => requireIdempotencyKey(""))
  assert.throws(() => requireIdempotencyKey("   "))
})

test("requireIdempotencyKey rejects oversized keys", () => {
  assert.throws(() => requireIdempotencyKey("x".repeat(201)))
})

test("requireIdempotencyKey rejects control characters", () => {
  assert.throws(() => requireIdempotencyKey("abc\u0000def"))
  assert.throws(() => requireIdempotencyKey("abc\u001fdef"))
})
