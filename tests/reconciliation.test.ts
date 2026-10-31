import test, { before, beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"

import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { hashPassword } from "../server/auth.ts"
import { env } from "../server/env.ts"
import {
  normalizeStatementEntries,
  parseStatementCsv,
  reconcileStatement,
  runScheduledReconciliation,
} from "../server/reconciliation.ts"

let server: Server
let baseUrl: string
let pool: Pool
let organizationId = ""
let organizationName = ""
let operatorId = ""
let operatorCookie = ""

const OPERATOR_EMAIL = "reconciliation-test@washpilot.ci"
const PASSWORD = "ConsoleSecret2026!"

async function consoleReq(path: string, options: { method?: string; body?: unknown } = {}) {
  return fetch(`${baseUrl}/api/v1/console${path}`, {
    method: options.method ?? "GET",
    headers: { "Content-Type": "application/json", Cookie: operatorCookie },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

function period() {
  const now = new Date()
  return { periodStart: new Date(now.getTime() - 3_600_000), periodEnd: new Date(now.getTime() + 3_600_000) }
}

async function createPayment(options: {
  intentReference?: string
  providerReference: string
  amountCents?: number
  channel?: string
  intentStatus?: string
  payment?: boolean
}) {
  let intentId: string | null = null
  if (options.intentReference) {
    const intent = await pool.query(
      `INSERT INTO payment_intents(organization_id, reference, plan_code, months, amount_cents, provider, status)
       VALUES($1::uuid,$2,'pro',1,$3,'wave',$4) RETURNING id`,
      [organizationId, options.intentReference, options.amountCents ?? 2_000_000, options.intentStatus ?? "paid"],
    )
    intentId = intent.rows[0].id
  }
  if (options.payment === false) return { intentId, paymentId: null }
  const payment = await pool.query(
    `INSERT INTO subscription_payments(
       organization_id, organization_name, plan_code, plan_name, amount_cents, months,
       period_start, period_end, channel, payment_reference, payment_intent_id, source, occurred_at)
     VALUES($1::uuid,$2,'pro','Pro',$3,1,now() - interval '1 day',now() + interval '29 days',
            $4,$5,$6::uuid,'test',now()) RETURNING id`,
    [
      organizationId, organizationName, options.amountCents ?? 2_000_000,
      options.channel ?? "wave", options.providerReference, intentId,
    ],
  )
  return { intentId, paymentId: payment.rows[0].id as string }
}

async function reconcile(records: Array<Record<string, unknown>>, provider = "wave") {
  return reconcileStatement(pool, {
    provider,
    ...period(),
    entries: normalizeStatementEntries(records),
    actor: { operatorId, email: OPERATOR_EMAIL },
  })
}

before(async () => {
  assert.ok(await initDatabaseSchema(), "base de test initialisée")
  pool = getPool() as Pool
  const app = createApiApp()
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve) })
  const address = server.address()
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`

  const org = await pool.query("SELECT id, name FROM organizations ORDER BY created_at LIMIT 1")
  organizationId = org.rows[0].id
  organizationName = org.rows[0].name
  const operator = await pool.query(
    `INSERT INTO platform_operators(email, password_hash, full_name, status, role, managed_by)
     VALUES($1,$2,'Test rapprochement','active','admin','console') RETURNING id`,
    [OPERATOR_EMAIL, await hashPassword(PASSWORD)],
  )
  operatorId = operator.rows[0].id
  const login = await fetch(`${baseUrl}/api/v1/console/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: OPERATOR_EMAIL, password: PASSWORD }),
  })
  assert.equal(login.status, 200)
  operatorCookie = login.headers.getSetCookie?.().join("; ") ?? login.headers.get("set-cookie") ?? ""
})

beforeEach(async () => {
  await pool.query("DELETE FROM subscription_payments")
  await pool.query("DELETE FROM reconciliation_runs")
  await pool.query("DELETE FROM reconciliation_batches")
  await pool.query("DELETE FROM payment_intents")
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

test("le CSV gère BOM, guillemets et montants français sans confondre francs et centimes", () => {
  const records = parseStatementCsv(
    "\uFEFFreference;transaction_id;amount;status;paid_at\n\"WP-CSV-1\";\"WAVE,001\";\"20 000,00\";SUCCESS;2026-10-24T10:00:00Z",
  )
  const [entry] = normalizeStatementEntries(records)
  assert.equal(entry.merchantReference, "WP-CSV-1")
  assert.equal(entry.providerReference, "WAVE,001")
  assert.equal(entry.amountCents, 2_000_000)
  assert.equal(entry.occurredAt?.toISOString(), "2026-10-24T10:00:00.000Z")

  const [cents] = normalizeStatementEntries([{ reference: "WP-CENTS", amount_cents: 2_000_000 }])
  assert.equal(cents.amountCents, 2_000_000)
})

test("une référence et un montant exacts marquent le paiement sans activer ni réécrire l'abonnement", async () => {
  const { paymentId } = await createPayment({ intentReference: "WP-MATCH-1", providerReference: "WAVE-MATCH-1" })
  const subscriptionsBefore = await pool.query("SELECT count(*)::int AS n FROM subscriptions")
  const result = await reconcile([{ reference: "wp-match-1", transaction_id: "wave-match-1", amount: "20000", status: "paid" }])
  assert.equal(result.matched_rows, 1)
  assert.equal(result.discrepancy_rows, 0)

  const payment = await pool.query(
    "SELECT reconciled_at, reconciliation_batch_id, amount_cents FROM subscription_payments WHERE id = $1::uuid",
    [paymentId],
  )
  assert.ok(payment.rows[0].reconciled_at)
  assert.equal(payment.rows[0].reconciliation_batch_id, result.batch_id)
  assert.equal(Number(payment.rows[0].amount_cents), 2_000_000)
  const subscriptionsAfter = await pool.query("SELECT count(*)::int AS n FROM subscriptions")
  assert.equal(subscriptionsAfter.rows[0].n, subscriptionsBefore.rows[0].n)
})

test("un montant divergent ouvre un écart, résoluble sans toucher au registre", async () => {
  const { paymentId } = await createPayment({ intentReference: "WP-DIFF-1", providerReference: "WAVE-DIFF-1" })
  const csv = "reference,transaction_id,amount,status\nWP-DIFF-1,WAVE-DIFF-1,25000,paid"
  const imported = await consoleReq("/reconciliation/batches", {
    method: "POST",
    body: { provider: "wave", source_name: "releve-test.csv", from: "2020-01-01", to: "2099-01-01", csv },
  })
  const result = await imported.json()
  assert.equal(imported.status, 201, JSON.stringify(result))
  assert.equal(result.discrepancy_rows, 1)

  const detailResponse = await consoleReq(`/reconciliation/batches/${result.batch_id}`)
  const detail = await detailResponse.json()
  assert.equal(detail.discrepancies[0].kind, "amount_mismatch")
  assert.equal(Number(detail.discrepancies[0].expected_amount_cents), 2_000_000)
  assert.equal(Number(detail.discrepancies[0].actual_amount_cents), 2_500_000)

  const resolved = await consoleReq(`/reconciliation/discrepancies/${detail.discrepancies[0].id}/resolve`, {
    method: "POST",
    body: { note: "Vérifié auprès de Wave : le trop-perçu sera traité séparément." },
  })
  assert.equal(resolved.status, 200, await resolved.text())
  const payment = await pool.query(
    "SELECT amount_cents, reconciled_at FROM subscription_payments WHERE id = $1::uuid",
    [paymentId],
  )
  assert.equal(Number(payment.rows[0].amount_cents), 2_000_000)
  assert.equal(payment.rows[0].reconciled_at, null)
  const audit = await pool.query(
    "SELECT count(*)::int AS n FROM platform_audit_logs WHERE action = 'reconciliation.discrepancy_resolved'",
  )
  assert.equal(audit.rows[0].n, 1)
})

test("une ligne payée rattachée à une intention en attente ne devient jamais un encaissement automatique", async () => {
  const { intentId } = await createPayment({
    intentReference: "WP-PENDING-1", providerReference: "WAVE-PENDING-1", intentStatus: "pending", payment: false,
  })
  const result = await reconcile([{ reference: "WP-PENDING-1", amount: 20000, status: "successful" }])
  assert.equal(result.matched_rows, 0)
  assert.equal(result.discrepancy_rows, 1)
  const discrepancy = await pool.query(
    "SELECT kind, payment_intent_id FROM reconciliation_discrepancies WHERE batch_id = $1::uuid",
    [result.batch_id],
  )
  assert.equal(discrepancy.rows[0].kind, "missing_in_register")
  assert.equal(discrepancy.rows[0].payment_intent_id, intentId)
  const intent = await pool.query("SELECT status FROM payment_intents WHERE id = $1::uuid", [intentId])
  assert.equal(intent.rows[0].status, "pending")
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM subscription_payments")).rows[0].n, 0)
})

test("un encaissement du registre absent du relevé apparaît dans la file d'écarts", async () => {
  await createPayment({ providerReference: "WAVE-NOT-ON-STATEMENT" })
  const result = await reconcile([{ reference: "IGNORED-FAILED", amount: 1000, status: "failed" }])
  assert.equal(result.ignored_rows, 1)
  assert.equal(result.discrepancy_rows, 1)
  const discrepancy = await pool.query(
    "SELECT kind, reference FROM reconciliation_discrepancies WHERE batch_id = $1::uuid",
    [result.batch_id],
  )
  assert.equal(discrepancy.rows[0].kind, "missing_in_statement")
  assert.equal(discrepancy.rows[0].reference, "WAVE-NOT-ON-STATEMENT")
})

test("une même référence chez deux agrégateurs ne rapproche pas le paiement du mauvais canal", async () => {
  const { paymentId } = await createPayment({
    providerReference: "REFERENCE-PARTAGEE",
    channel: "orange_money",
  })
  const result = await reconcile(
    [{ transaction_id: "REFERENCE-PARTAGEE", amount: 20000, status: "paid" }],
    "wave",
  )
  assert.equal(result.matched_rows, 0)
  const payment = await pool.query(
    "SELECT reconciled_at FROM subscription_payments WHERE id = $1::uuid",
    [paymentId],
  )
  assert.equal(payment.rows[0].reconciled_at, null)
})

test("le connecteur planifié transmet la période et ne réimporte pas la même fenêtre", async () => {
  await createPayment({ intentReference: "WP-SCHEDULED-1", providerReference: "WAVE-SCHEDULED-1" })
  const previous = {
    enabled: env.RECONCILIATION_ENABLED,
    provider: env.RECONCILIATION_PROVIDER,
    url: env.RECONCILIATION_STATEMENT_URL,
    token: env.RECONCILIATION_STATEMENT_TOKEN,
    lookback: env.RECONCILIATION_LOOKBACK_HOURS,
  }
  env.RECONCILIATION_ENABLED = true
  env.RECONCILIATION_PROVIDER = "wave"
  env.RECONCILIATION_STATEMENT_URL = "https://aggregateur.example.test/statement"
  env.RECONCILIATION_STATEMENT_TOKEN = "secret-test"
  env.RECONCILIATION_LOOKBACK_HOURS = 24
  let calls = 0
  const fetchImpl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    calls += 1
    const url = new URL(String(input))
    assert.ok(url.searchParams.get("from"))
    assert.ok(url.searchParams.get("to"))
    assert.equal(init?.headers?.Authorization, "Bearer secret-test")
    return new Response(JSON.stringify({ entries: [{ reference: "WP-SCHEDULED-1", amount: 20000, status: "paid" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as unknown as typeof fetch

  try {
    const now = new Date()
    const first = await runScheduledReconciliation(pool, { now, fetchImpl, force: true })
    assert.equal(first?.status, "success")
    assert.equal(calls, 1)
    const second = await runScheduledReconciliation(pool, { now: new Date(now.getTime() + 300_000), fetchImpl })
    assert.equal(second?.status, "skipped")
    assert.equal(calls, 1, "aucun second téléchargement dans la même fenêtre")
    const runs = await pool.query("SELECT count(*)::int AS n FROM reconciliation_runs WHERE trigger_kind = 'scheduled'")
    assert.equal(runs.rows[0].n, 1)
  } finally {
    env.RECONCILIATION_ENABLED = previous.enabled
    env.RECONCILIATION_PROVIDER = previous.provider
    env.RECONCILIATION_STATEMENT_URL = previous.url
    env.RECONCILIATION_STATEMENT_TOKEN = previous.token
    env.RECONCILIATION_LOOKBACK_HOURS = previous.lookback
  }
})
