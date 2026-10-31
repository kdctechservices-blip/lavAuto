import test from "node:test"
import assert from "node:assert/strict"
import { HttpError } from "../server/auth.ts"
import {
  parseReportRange,
  parseGranularity,
  granularityStep,
  granularityLabel,
  REPORT_GRANULARITIES,
} from "../server/reports.ts"

// ---------------------------------------------------------------------------
// Rapports : validation de la période et de la granularité
// ---------------------------------------------------------------------------

test("une période valide est acceptée telle quelle", () => {
  const range = parseReportRange({ from: "2026-10-01", to: "2026-10-20" })
  assert.deepEqual(range, { from: "2026-10-01", to: "2026-10-20" })
})

/** Vérifie qu'un appel échoue avec le code d'erreur attendu. */
function assertRejects(run: () => unknown, code: string) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof HttpError, "une HttpError est attendue")
    assert.equal(error.code, code)
    assert.equal(error.status, 400)
    return true
  })
}

test("une période d'un seul jour est acceptée", () => {
  const range = parseReportRange({ from: "2026-10-19", to: "2026-10-19" })
  assert.equal(range.from, range.to)
})

test("une période inversée est refusée", () => {
  assertRejects(() => parseReportRange({ from: "2026-10-20", to: "2026-10-01" }), "invalid_report_range")
})

test("une période de plus d'un an est refusée", () => {
  assertRejects(() => parseReportRange({ from: "2024-01-01", to: "2026-01-01" }), "invalid_report_range")
})

test("une date mal formée est refusée", () => {
  assertRejects(() => parseReportRange({ from: "01/10/2026", to: "2026-10-20" }), "invalid_report_range")
  assertRejects(() => parseReportRange({ from: "2026-1-1", to: "2026-01-31" }), "invalid_report_range")
  assertRejects(() => parseReportRange({ from: "not-a-date", to: "2026-01-31" }), "invalid_report_range")
  assertRejects(() => parseReportRange({ from: "2026-02-31", to: "2026-03-01" }), "invalid_report_range")
})

test("les trois granularités de regroupement sont exposées", () => {
  assert.deepEqual([...REPORT_GRANULARITIES], ["day", "week", "month"])
})

test("la granularité par défaut est le jour", () => {
  assert.equal(parseGranularity(undefined), "day")
  assert.equal(parseGranularity(""), "day")
})

test("les granularités connues sont acceptées", () => {
  assert.equal(parseGranularity("week"), "week")
  assert.equal(parseGranularity("month"), "month")
})

test("une granularité inconnue est rejetée plutôt qu'interpolée en SQL", () => {
  // Protection contre l'injection : la valeur ne doit jamais atteindre le SQL.
  assertRejects(() => parseGranularity("day'); DROP TABLE washes;--"), "invalid_granularity")
  assertRejects(() => parseGranularity("year"), "invalid_granularity")
})

test("chaque granularité produit un pas SQL et un libellé français", () => {
  for (const granularity of REPORT_GRANULARITIES) {
    assert.match(granularityStep(granularity), /^1 (day|week|month)$/)
    assert.ok(granularityLabel(granularity).length > 0)
  }
  assert.equal(granularityLabel("week"), "Semaine")
})
