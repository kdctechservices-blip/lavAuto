import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { randomUUID } from "node:crypto"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"
import { buildOrganizationBackup } from "../server/backup.ts"

let server: Server
let baseUrl: string
let pool: Pool
let orgId: string
let siteId: string
let otherSiteId: string
let cashSessionId: string
let otherCashSessionId: string
let cieId: string
let sodeciId: string
let invoicedReadingId: string

const PASSWORD = "WashPilot2026!"
let cookie = ""

function monthShift(offset: number): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 7)
}
const READING_MONTH = monthShift(-2)
const INVOICE_MONTH = monthShift(-1)
const DAY1 = `${READING_MONTH}-05`
const DAY2 = `${READING_MONTH}-07`
const DAY3 = `${READING_MONTH}-10`
const INVOICE_DATE = `${INVOICE_MONTH}-03`

async function api(path: string, options: { method?: string; body?: unknown; key?: string; authenticated?: boolean } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (options.authenticated !== false) headers.Cookie = cookie
  if (options.key) headers["Idempotency-Key"] = options.key
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function createMeter(site: string, provider: "cie" | "sodeci", number: string): Promise<Response> {
  return api("/api/v1/utility-meters", {
    method: "POST",
    key: randomUUID(),
    body: { site_id: site, provider, meter_number: number },
  })
}

async function createReading(meter: string, date: string, index: number, invoice?: unknown, key = randomUUID()) {
  return api(`/api/v1/utility-meters/${meter}/readings`, {
    method: "POST",
    key,
    body: { reading_date: date, index_value: index, ...(invoice ? { invoice } : {}) },
  })
}

async function overview(month: string) {
  const response = await api(`/api/v1/utilities?month=${month}&site_id=${siteId}`)
  assert.equal(response.status, 200)
  return response.json() as Promise<{
    totals: { electricity_milli: number; water_milli: number; invoiced_cents: number }
    meters: {
      id: string
      provider: string
      month_consumption_milli: number
      month_invoiced_cents: number
      readings: { id: string; reading_date: string; consumption_milli: number | null; expense: { id: string } | null }[]
    }[]
  }>
}

before(async () => {
  const ready = await initDatabaseSchema()
  assert.ok(ready, "base de test initialisée")
  pool = getPool() as Pool
  const app = createApiApp()
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve) })
  const address = server.address()
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`

  const login = await api("/api/v1/auth/login", {
    method: "POST",
    authenticated: false,
    body: { email: "demo@washpilot.ci", password: PASSWORD },
  })
  assert.equal(login.status, 200)
  cookie = login.headers.getSetCookie?.().join("; ") ?? login.headers.get("set-cookie") ?? ""

  orgId = (await pool.query(
    "SELECT m.organization_id FROM organization_members m JOIN users u ON u.id=m.user_id WHERE u.email='demo@washpilot.ci'",
  )).rows[0].organization_id
  await pool.query(
    `UPDATE subscriptions SET plan_id=(SELECT id FROM plans WHERE code='pro'), status='active', plan_changed_at=now(), updated_at=now()
     WHERE organization_id=$1::uuid`,
    [orgId],
  )
  invalidateSubscriptionCache(orgId)

  siteId = (await pool.query(
    "INSERT INTO sites(organization_id,name,city) VALUES($1,$2,'Abidjan') RETURNING id",
    [orgId, `Compteurs ${randomUUID().slice(0, 8)}`],
  )).rows[0].id
  otherSiteId = (await pool.query(
    "INSERT INTO sites(organization_id,name,city) VALUES($1,$2,'Abidjan') RETURNING id",
    [orgId, `Autre caisse ${randomUUID().slice(0, 8)}`],
  )).rows[0].id

  for (const [site, other] of [[siteId, false], [otherSiteId, true]] as const) {
    const response = await api("/api/v1/cash-sessions/open", {
      method: "POST",
      key: randomUUID(),
      body: { site_id: site, opening_amount_cents: 10_000_000 },
    })
    assert.equal(response.status, 201)
    const session = await response.json()
    if (other) otherCashSessionId = session.id
    else cashSessionId = session.id
  }
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

test("un site accepte un CIE et un SODECI, mais pas deux compteurs du même fournisseur", async () => {
  const cie = await createMeter(siteId, "cie", "CIE-00125")
  assert.equal(cie.status, 201)
  cieId = (await cie.json()).id
  const sodeci = await createMeter(siteId, "sodeci", "SOD-0099")
  assert.equal(sodeci.status, 201)
  sodeciId = (await sodeci.json()).id

  const duplicate = await createMeter(siteId, "cie", "CIE-AUTRE")
  assert.equal(duplicate.status, 409)
  const count = await pool.query("SELECT COUNT(*)::int AS n FROM utility_meters WHERE site_id=$1::uuid", [siteId])
  assert.equal(count.rows[0].n, 2)
})

test("la consommation est la différence exacte entre deux index décimaux", async () => {
  const initial = await createReading(cieId, DAY1, 1000.125)
  assert.equal(initial.status, 201)
  assert.equal((await initial.json()).consumption_milli, null, "le premier index est un point de départ")

  const next = await createReading(cieId, DAY3, 1025.5)
  assert.equal(next.status, 201)
  assert.equal((await next.json()).consumption_milli, 25_375)

  const data = await overview(READING_MONTH)
  const meter = data.meters.find((item) => item.id === cieId)
  assert.equal(meter?.month_consumption_milli, 25_375)
  assert.equal(data.totals.electricity_milli, 25_375)
})

test("un relevé oublié recalcule ses voisins sans changer la consommation totale", async () => {
  const backfilled = await createReading(cieId, DAY2, 1010)
  assert.equal(backfilled.status, 201)
  assert.equal((await backfilled.json()).consumption_milli, 9_875)

  const data = await overview(READING_MONTH)
  const meter = data.meters.find((item) => item.id === cieId)
  const third = meter?.readings.find((reading) => reading.reading_date === DAY3)
  assert.equal(third?.consumption_milli, 15_500, "1025,500 − 1010,000")
  assert.equal(meter?.month_consumption_milli, 25_375, "la somme des intervalles reste inchangée")
})

test("un index qui contredit ses voisins ou une date déjà relevée est refusé", async () => {
  const regresses = await createReading(cieId, `${READING_MONTH}-08`, 1009)
  assert.equal(regresses.status, 400)
  assert.equal((await regresses.json()).error.code, "index_regresses")

  const exceeds = await createReading(cieId, `${READING_MONTH}-08`, 1030)
  assert.equal(exceeds.status, 400)
  assert.equal((await exceeds.json()).error.code, "index_exceeds_next")

  const tooPrecise = await createReading(cieId, `${READING_MONTH}-08`, 1010.2345)
  assert.equal(tooPrecise.status, 400)
  assert.equal((await tooPrecise.json()).error.code, "invalid_data")

  const duplicate = await createReading(cieId, DAY2, 1010)
  assert.equal(duplicate.status, 409)
  assert.equal((await duplicate.json()).error.code, "reading_exists")
})

test("une facture crée exactement une dépense liée et son rejeu est idempotent", async () => {
  const data = await overview(READING_MONTH)
  const meter = data.meters.find((item) => item.id === cieId)
  invoicedReadingId = String(meter?.readings.find((reading) => reading.reading_date === DAY3)?.id)
  assert.ok(invoicedReadingId)

  const key = randomUUID()
  const invoice = { amount_cents: 4_500_000, expense_date: INVOICE_DATE, payment_method: "orange_money", reference: "CIE-FAC-42" }
  const first = await api(`/api/v1/utility-readings/${invoicedReadingId}/invoice`, { method: "POST", key, body: invoice })
  assert.equal(first.status, 201)
  const expenseId = (await first.json()).expense.id

  const replay = await api(`/api/v1/utility-readings/${invoicedReadingId}/invoice`, { method: "POST", key, body: invoice })
  assert.equal(replay.status, 201)
  assert.equal(replay.headers.get("idempotency-replayed"), "true")
  assert.equal((await replay.json()).expense.id, expenseId)

  const second = await api(`/api/v1/utility-readings/${invoicedReadingId}/invoice`, { method: "POST", key: randomUUID(), body: invoice })
  assert.equal(second.status, 409)
  const expenses = await pool.query(
    "SELECT id, category, site_id, amount_cents FROM expenses WHERE utility_reading_id=$1::uuid",
    [invoicedReadingId],
  )
  assert.equal(expenses.rowCount, 1, "la contrainte unique et l'idempotence empêchent le double comptage")
  assert.equal(expenses.rows[0].category, "utilities")
  assert.equal(expenses.rows[0].site_id, siteId)
  assert.equal(expenses.rows[0].amount_cents, 4_500_000)
})

test("consommation au mois du relevé, charge au mois de la facture", async () => {
  const readingMonth = await overview(READING_MONTH)
  assert.equal(readingMonth.totals.invoiced_cents, 0)
  assert.equal(readingMonth.totals.electricity_milli, 25_375)

  const invoiceMonth = await overview(INVOICE_MONTH)
  assert.equal(invoiceMonth.totals.invoiced_cents, 4_500_000)
  assert.equal(invoiceMonth.totals.electricity_milli, 0, "aucun relevé CIE sur le mois de facturation")
})

test("relevé et facture sont atomiques, et le rejeu ne crée ni relevé ni dépense supplémentaire", async () => {
  const key = randomUUID()
  const invoice = { amount_cents: 2_000_000, expense_date: DAY2, payment_method: "wave", reference: "SOD-77" }
  const first = await createReading(sodeciId, DAY2, 500, invoice, key)
  assert.equal(first.status, 201)
  const created = await first.json()
  assert.ok(created.expense.id)

  const replay = await createReading(sodeciId, DAY2, 500, invoice, key)
  assert.equal(replay.status, 201)
  assert.equal((await replay.json()).id, created.id)

  const readings = await pool.query("SELECT COUNT(*)::int AS n FROM utility_readings WHERE meter_id=$1::uuid", [sodeciId])
  const expenses = await pool.query("SELECT COUNT(*)::int AS n FROM expenses WHERE utility_reading_id=$1::uuid", [created.id])
  assert.equal(readings.rows[0].n, 1)
  assert.equal(expenses.rows[0].n, 1)
})

test("une caisse d'une autre station annule toute la transaction", async () => {
  const response = await createReading(cieId, `${READING_MONTH}-15`, 1040, {
    amount_cents: 800_000,
    expense_date: `${READING_MONTH}-15`,
    payment_method: "cash",
    cash_session_id: otherCashSessionId,
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, "cash_session_wrong_site")

  const reading = await pool.query(
    "SELECT 1 FROM utility_readings WHERE meter_id=$1::uuid AND reading_date=$2::date",
    [cieId, `${READING_MONTH}-15`],
  )
  assert.equal(reading.rowCount, 0, "le relevé n'est pas conservé sans sa facture")
})

test("un paiement en espèces utilise la caisse du site et écrit une seule sortie", async () => {
  const response = await createReading(sodeciId, DAY3, 510.25, {
    amount_cents: 1_000_000,
    expense_date: DAY3,
    payment_method: "cash",
    cash_session_id: cashSessionId,
  })
  assert.equal(response.status, 201)
  const created = await response.json()
  const movement = await pool.query(
    "SELECT type, amount_cents, cash_session_id FROM cash_movements WHERE expense_id=$1::uuid",
    [created.expense.id],
  )
  assert.equal(movement.rowCount, 1)
  assert.equal(movement.rows[0].type, "exit")
  assert.equal(movement.rows[0].amount_cents, 1_000_000)
  assert.equal(movement.rows[0].cash_session_id, cashSessionId)
})

test("les compteurs protègent la station contre une suppression destructive et figurent dans la sauvegarde", async () => {
  const emptySite = (await pool.query(
    "INSERT INTO sites(organization_id,name,city) VALUES($1,$2,'Abidjan') RETURNING id",
    [orgId, `Station protégée ${randomUUID().slice(0, 8)}`],
  )).rows[0].id
  const meter = await createMeter(emptySite, "cie", "PROTEGE-1")
  assert.equal(meter.status, 201)
  const deletion = await api(`/api/v1/sites/${emptySite}`, { method: "DELETE" })
  assert.equal(deletion.status, 409)

  const backup = await buildOrganizationBackup(pool, orgId)
  assert.ok(backup.counts.utility_meters >= 3)
  assert.ok(backup.counts.utility_readings >= 5)
  assert.ok(Array.isArray(backup.data.utility_readings))
})

test("la clôture exige les index quotidiens et les enregistre atomiquement sans dépense", async () => {
  const current = await api(`/api/v1/cash-sessions/current?site_id=${siteId}`)
  const session = await current.json()
  const today = new Date().toISOString().slice(0, 10)
  const expensesBefore = await pool.query("SELECT COUNT(*)::int AS n FROM expenses WHERE organization_id=$1::uuid", [orgId])

  const missing = await api(`/api/v1/cash-sessions/${cashSessionId}/close`, {
    method: "POST",
    body: { counted_amount_cents: session.theoretical_balance_cents },
  })
  assert.equal(missing.status, 400)
  assert.equal((await missing.json()).error.code, "utility_readings_required")

  const onlyCie = await api(`/api/v1/cash-sessions/${cashSessionId}/close`, {
    method: "POST",
    body: {
      counted_amount_cents: session.theoretical_balance_cents,
      utility_readings: [{ meter_id: cieId, index_value: 1100.25 }],
    },
  })
  assert.equal(onlyCie.status, 400)
  const afterFailures = await pool.query(
    "SELECT status FROM cash_sessions WHERE id=$1::uuid",
    [cashSessionId],
  )
  assert.equal(afterFailures.rows[0].status, "open", "un relevé manquant laisse la caisse ouverte")
  const partial = await pool.query("SELECT COUNT(*)::int AS n FROM utility_readings WHERE reading_date=$1::date AND meter_id=$2::uuid", [today, cieId])
  assert.equal(partial.rows[0].n, 0, "aucun relevé partiel n'est conservé")

  const closed = await api(`/api/v1/cash-sessions/${cashSessionId}/close`, {
    method: "POST",
    body: {
      counted_amount_cents: session.theoretical_balance_cents,
      utility_readings: [
        { meter_id: cieId, index_value: 1100.25, anomaly_comment: "Aucun lavage sur ce site de test ; consommation vérifiée." },
        { meter_id: sodeciId, index_value: 520.75, anomaly_comment: "Aucun lavage sur ce site de test ; consommation vérifiée." },
      ],
    },
  })
  assert.equal(closed.status, 200)
  assert.equal((await closed.json()).status, "closed")

  const readings = await pool.query(
    "SELECT id, meter_id, index_milli::text, notes FROM utility_readings WHERE cash_session_id=$1::uuid ORDER BY meter_id",
    [cashSessionId],
  )
  assert.equal(readings.rowCount, 2)
  assert.deepEqual(new Set(readings.rows.map((row) => String(row.meter_id))), new Set([cieId, sodeciId]))
  assert.ok(readings.rows.every((row) => row.notes.includes("clôture")))
  const dailyExpenses = await pool.query(
    `SELECT COUNT(*)::int AS n FROM expenses e
     JOIN utility_readings r ON r.id=e.utility_reading_id WHERE r.cash_session_id=$1::uuid`,
    [cashSessionId],
  )
  assert.equal(dailyExpenses.rows[0].n, 0, "un relevé quotidien n'est pas une facture")
  const expensesAfter = await pool.query("SELECT COUNT(*)::int AS n FROM expenses WHERE organization_id=$1::uuid", [orgId])
  assert.equal(expensesAfter.rows[0].n, expensesBefore.rows[0].n)
})

test("la clôture reste possible sans compteur configuré", async () => {
  const current = await api(`/api/v1/cash-sessions/current?site_id=${otherSiteId}`)
  const session = await current.json()
  const response = await api(`/api/v1/cash-sessions/${otherCashSessionId}/close`, {
    method: "POST",
    body: { counted_amount_cents: session.theoretical_balance_cents },
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).status, "closed")
})

test("un index du jour déjà saisi est reconnu à la clôture sans doublon", async () => {
  const site = (await pool.query(
    "INSERT INTO sites(organization_id,name,city) VALUES($1,$2,'Abidjan') RETURNING id",
    [orgId, `Clôture avec relevé ${randomUUID().slice(0, 8)}`],
  )).rows[0].id
  const meterResponse = await createMeter(site, "cie", "DEJA-RELEVE")
  const meterId = (await meterResponse.json()).id
  const opened = await api("/api/v1/cash-sessions/open", {
    method: "POST",
    key: randomUUID(),
    body: { site_id: site, opening_amount_cents: 0 },
  })
  const session = await opened.json()
  const today = new Date().toISOString().slice(0, 10)
  const reading = await createReading(meterId, today, 42.5)
  assert.equal(reading.status, 201)

  const closed = await api(`/api/v1/cash-sessions/${session.id}/close`, {
    method: "POST",
    body: { counted_amount_cents: 0, utility_readings: [] },
  })
  assert.equal(closed.status, 200)
  const readings = await pool.query(
    "SELECT COUNT(*)::int AS n FROM utility_readings WHERE meter_id=$1::uuid AND reading_date=$2::date",
    [meterId, today],
  )
  assert.equal(readings.rows[0].n, 1)
})
