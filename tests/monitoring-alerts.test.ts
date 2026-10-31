import test, { before, beforeEach, after } from "node:test"
import assert from "node:assert/strict"
import type { Pool } from "pg"

import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { env } from "../server/env.ts"
import { recordRequest } from "../server/monitoring.ts"
import {
  evaluateMonitoringAlerts,
  runMonitoringAlerts,
  saveMonitoringAlertSettings,
  sendTestMonitoringAlert,
} from "../server/monitoring-alerts.ts"

let pool: Pool
let operatorId = ""

const previousWhatsApp = {
  token: env.WHATSAPP_ACCESS_TOKEN,
  phone: env.WHATSAPP_PHONE_NUMBER_ID,
  template: env.WHATSAPP_ALERT_TEMPLATE,
}

async function configure(overrides: Partial<Parameters<typeof saveMonitoringAlertSettings>[1]> = {}) {
  return saveMonitoringAlertSettings(pool, {
    enabled: true,
    error_rate_percent: 5,
    min_requests: 10,
    slow_request_count: 100,
    window_minutes: 15,
    cooldown_minutes: 60,
    email_recipients: [],
    whatsapp_recipients: ["+2250700000000"],
    ...overrides,
  }, operatorId)
}

before(async () => {
  assert.ok(await initDatabaseSchema(), "base de test initialisée")
  pool = getPool() as Pool
  const operator = await pool.query(
    `INSERT INTO platform_operators(email, full_name, status, role, managed_by)
     VALUES('alerts-test@washpilot.ci','Test alertes','active','admin','console') RETURNING id`,
  )
  operatorId = operator.rows[0].id
  env.WHATSAPP_ACCESS_TOKEN = "whatsapp-test-token"
  env.WHATSAPP_PHONE_NUMBER_ID = "123456789"
  env.WHATSAPP_ALERT_TEMPLATE = "washpilot_operations_alert"
})

beforeEach(async () => {
  await pool.query("DELETE FROM platform_alert_events")
  await pool.query("DELETE FROM request_metrics")
  await configure()
})

after(async () => {
  env.WHATSAPP_ACCESS_TOKEN = previousWhatsApp.token
  env.WHATSAPP_PHONE_NUMBER_ID = previousWhatsApp.phone
  env.WHATSAPP_ALERT_TEMPLATE = previousWhatsApp.template
  await closeDatabase()
})

test("le minimum de trafic évite une alerte à 100 % sur une seule requête", async () => {
  const candidates = evaluateMonitoringAlerts({
    requests: 1,
    server_errors: 1,
    slow_requests: 0,
    error_rate_percent: 100,
    window_minutes: 15,
  }, { error_rate_percent: 5, min_requests: 10, slow_request_count: 100 })
  assert.deepEqual(candidates, [])

  const now = new Date()
  await recordRequest(pool, { method: "GET", route: "/api/v1/one", status: 500, durationMs: 10, at: now })
  const outcomes = await runMonitoringAlerts(pool, { now })
  assert.deepEqual(outcomes, [])
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM platform_alert_events")).rows[0].n, 0)
})

test("un seuil dépassé produit une remise WhatsApp par modèle, puis respecte le cooldown", async () => {
  const now = new Date()
  for (let index = 0; index < 10; index += 1) {
    await recordRequest(pool, {
      method: "GET", route: "/api/v1/alerts", status: index < 2 ? 500 : 200, durationMs: 20, at: now,
    })
  }
  let whatsappPayload: Record<string, unknown> | null = null
  const fetchImpl = (async (_input: unknown, init?: { body?: unknown }) => {
    whatsappPayload = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ messages: [{ id: "wamid.test" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as unknown as typeof fetch

  const outcomes = await runMonitoringAlerts(pool, { now, fetchImpl })
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].kind, "error_rate")
  assert.equal(outcomes[0].deliveries[0].delivered, true)
  assert.equal(whatsappPayload?.type, "template")
  assert.equal((whatsappPayload?.template as { name: string }).name, "washpilot_operations_alert")

  const second = await runMonitoringAlerts(pool, { now, fetchImpl })
  assert.deepEqual(second, [], "le même incident ne doit pas spammer les destinataires")
  const events = await pool.query("SELECT kind, deliveries FROM platform_alert_events")
  assert.equal(events.rowCount, 1)
  assert.equal(events.rows[0].deliveries[0].delivered, true)
})

test("une lenteur anormale possède sa propre alerte et son propre cooldown", async () => {
  await configure({ error_rate_percent: 100, slow_request_count: 2 })
  const now = new Date()
  for (let index = 0; index < 10; index += 1) {
    await recordRequest(pool, {
      method: "GET", route: "/api/v1/slow-alert", status: 200, durationMs: index < 2 ? 2500 : 10, at: now,
    })
  }
  const fetchImpl = (async () => new Response("{}", { status: 200 })) as typeof fetch
  const outcomes = await runMonitoringAlerts(pool, { now, fetchImpl })
  assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["slow_requests"])
})

test("un refus du fournisseur est historisé sans supprimer l'événement", async () => {
  await configure({ min_requests: 1, error_rate_percent: 1 })
  const now = new Date()
  await recordRequest(pool, { method: "GET", route: "/api/v1/failure", status: 500, durationMs: 10, at: now })
  const fetchImpl = (async () => new Response("indisponible", { status: 503 })) as typeof fetch
  const outcomes = await runMonitoringAlerts(pool, { now, fetchImpl })
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].deliveries[0].delivered, false)
  assert.match(outcomes[0].deliveries[0].error ?? "", /503/)
  const event = await pool.query("SELECT deliveries FROM platform_alert_events")
  assert.equal(event.rowCount, 1)
  assert.equal(event.rows[0].deliveries[0].delivered, false)
})

test("le test manuel fonctionne même quand la surveillance automatique est désactivée", async () => {
  await configure({ enabled: false })
  const fetchImpl = (async () => new Response("{}", { status: 200 })) as typeof fetch
  const first = await sendTestMonitoringAlert(pool, { fetchImpl })
  const second = await sendTestMonitoringAlert(pool, { fetchImpl })
  assert.notEqual(first.event_id, second.event_id, "le test manuel contourne volontairement le cooldown")
  assert.equal(first.deliveries[0].delivered, true)
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM platform_alert_events WHERE kind = 'test'")).rows[0].n, 2)
})
