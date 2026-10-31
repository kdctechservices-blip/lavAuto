import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { randomUUID } from "node:crypto"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"
import { buildOrganizationBackup } from "../server/backup.ts"
import type { ClosingUtilityReadingInput } from "../server/utility-analysis.ts"

let server: Server
let baseUrl: string
let pool: Pool
let orgId: string
let siteId: string
let cashSessionId: string
let cieId: string
let sodeciId: string
let cookie = ""

const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64")

function dateOffset(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

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

async function createMeter(site: string, provider: "cie" | "sodeci", number: string): Promise<string> {
  const response = await api("/api/v1/utility-meters", {
    method: "POST",
    key: randomUUID(),
    body: { site_id: site, provider, meter_number: number },
  })
  assert.equal(response.status, 201)
  return String((await response.json()).id)
}

async function seedReadings(meterId: string, startIndex: number, dailyStep: number) {
  const params: (string | number)[] = [orgId, meterId]
  const values: string[] = []
  for (let day = -15; day <= -1; day += 1) {
    const dateParam = params.push(dateOffset(day))
    const indexParam = params.push(startIndex + (day + 15) * dailyStep)
    values.push(`($1,$2,$${dateParam}::date,$${indexParam})`)
  }
  await pool.query(
    `INSERT INTO utility_readings(organization_id,meter_id,reading_date,index_milli) VALUES ${values.join(",")}`,
    params,
  )
}

async function seedWashes(site: string, days: number[], perDay: number) {
  for (const day of days) {
    const params: string[] = [orgId, site]
    const values: string[] = []
    for (let wash = 0; wash < perDay; wash += 1) {
      const param = params.push(`${dateOffset(day)}T12:00:00.000Z`)
      values.push(`($1,$2,'completed',0,'cash',$${param}::timestamptz)`)
    }
    await pool.query(
      `INSERT INTO washes(organization_id,site_id,status,total_cents,payment_method,created_at) VALUES ${values.join(",")}`,
      params,
    )
  }
}

function closingReadings(photo?: boolean, comment?: string): ClosingUtilityReadingInput[] {
  return [
    {
      meter_id: cieId,
      index_value: 1156,
      ...(comment ? { anomaly_comment: comment } : {}),
      ...(photo ? { photo: { mime_type: "image/jpeg", data_base64: PHOTO } } : {}),
    },
    { meter_id: sodeciId, index_value: 115 },
  ]
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
    body: { email: "demo@washpilot.ci", password: "WashPilot2026!" },
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
    [orgId, `Pilotage compteurs ${randomUUID().slice(0, 8)}`],
  )).rows[0].id
  const opened = await api("/api/v1/cash-sessions/open", {
    method: "POST",
    key: randomUUID(),
    body: { site_id: siteId, opening_amount_cents: 10_000_000 },
  })
  assert.equal(opened.status, 201)
  cashSessionId = String((await opened.json()).id)
  cieId = await createMeter(siteId, "cie", "PILOT-CIE")
  sodeciId = await createMeter(siteId, "sodeci", "PILOT-SOD")
  await seedReadings(cieId, 1_000_000, 10_000)
  await seedReadings(sodeciId, 100_000, 1_000)
  await seedWashes(siteId, Array.from({ length: 15 }, (_, index) => index - 14), 5)
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

test("l'aperçu calcule les ratios sur la même période et signale la hausse par lavage", async () => {
  const response = await api(`/api/v1/cash-sessions/${cashSessionId}/utility-preview`, {
    method: "POST",
    body: { utility_readings: closingReadings() },
  })
  assert.equal(response.status, 200)
  const preview = await response.json()
  const cie = preview.readings.find((reading: { provider: string }) => reading.provider === "cie")
  const sodeci = preview.readings.find((reading: { provider: string }) => reading.provider === "sodeci")
  assert.equal(cie.consumption_milli, 16_000)
  assert.equal(cie.wash_count, 5)
  assert.equal(cie.ratio_per_wash, 3.2)
  assert.equal(cie.baseline.ratio_per_wash, 2)
  assert.equal(cie.period_days, 1)
  assert.ok(cie.alerts.some((alert: { code: string }) => alert.code === "high_per_wash"))
  assert.equal(sodeci.consumption_milli, 1_000)
  assert.equal(sodeci.ratio_per_wash, 200)
  assert.deepEqual(sodeci.alerts, [])
  const persisted = await pool.query("SELECT COUNT(*)::int AS n FROM utility_readings WHERE reading_date=CURRENT_DATE AND meter_id=ANY($1::uuid[])", [[cieId, sodeciId]])
  assert.equal(persisted.rows[0].n, 0, "l'aperçu ne crée aucun relevé")
})

test("une consommation nulle avec des lavages terminés appelle une vérification", async () => {
  const readings = closingReadings()
  readings[1].index_value = 114
  const response = await api(`/api/v1/cash-sessions/${cashSessionId}/utility-preview`, {
    method: "POST",
    body: { utility_readings: readings },
  })
  assert.equal(response.status, 200)
  const preview = await response.json()
  const sodeci = preview.readings.find((reading: { provider: string }) => reading.provider === "sodeci")
  assert.equal(sodeci.wash_count, 5)
  assert.ok(sodeci.alerts.some((alert: { code: string }) => alert.code === "zero_consumption_with_washes"))
})

test("le commentaire est exigé par le serveur et la photo est enregistrée atomiquement", async () => {
  const current = await api(`/api/v1/cash-sessions/current?site_id=${siteId}`)
  const session = await current.json()
  const refused = await api(`/api/v1/cash-sessions/${cashSessionId}/close`, {
    method: "POST",
    body: { counted_amount_cents: session.theoretical_balance_cents, utility_readings: closingReadings(true) },
  })
  assert.equal(refused.status, 400)
  assert.equal((await refused.json()).error.code, "utility_anomaly_comment_required")
  assert.equal((await pool.query("SELECT status FROM cash_sessions WHERE id=$1::uuid", [cashSessionId])).rows[0].status, "open")
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM utility_reading_photos WHERE organization_id=$1::uuid", [orgId])).rows[0].n, 0)

  const invalidPhoto = closingReadings(true, "Compteur et tuyauterie vérifiés, essai technique identifié.")
  invalidPhoto[0].photo!.data_base64 = Buffer.from([0, 0, 0, 0]).toString("base64")
  const rejectedPhoto = await api(`/api/v1/cash-sessions/${cashSessionId}/close`, {
    method: "POST",
    body: { counted_amount_cents: session.theoretical_balance_cents, utility_readings: invalidPhoto },
  })
  assert.equal(rejectedPhoto.status, 400)
  assert.equal((await rejectedPhoto.json()).error.code, "invalid_utility_photo")
  assert.equal((await pool.query("SELECT status FROM cash_sessions WHERE id=$1::uuid", [cashSessionId])).rows[0].status, "open")

  const closed = await api(`/api/v1/cash-sessions/${cashSessionId}/close`, {
    method: "POST",
    body: {
      counted_amount_cents: session.theoretical_balance_cents,
      utility_readings: closingReadings(true, "Compteur et tuyauterie vérifiés, essai technique identifié."),
    },
  })
  assert.equal(closed.status, 200)
  assert.equal((await closed.json()).status, "closed")
  const reading = await pool.query(
    "SELECT id, anomaly_comment FROM utility_readings WHERE meter_id=$1::uuid AND reading_date=CURRENT_DATE",
    [cieId],
  )
  assert.match(reading.rows[0].anomaly_comment, /tuyauterie vérifiés/)
  const photo = await api(`/api/v1/utility-readings/${reading.rows[0].id}/photo`)
  assert.equal(photo.status, 200)
  assert.match(photo.headers.get("content-type") ?? "", /image\/jpeg/)
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  const backup = await buildOrganizationBackup(pool, orgId)
  assert.equal(backup.counts.utility_reading_photos, 1)
  assert.equal(backup.data.utility_reading_photos.length, 1)
})

test("la synthèse sur sept jours expose moyennes, tendance et alertes", async () => {
  const response = await api(`/api/v1/utility-insights?site_id=${siteId}`)
  assert.equal(response.status, 200)
  const insights = await response.json()
  const cie = insights.providers.find((summary: { provider: string }) => summary.provider === "cie")
  const sodeci = insights.providers.find((summary: { provider: string }) => summary.provider === "sodeci")
  assert.equal(cie.consumption_milli, 76_000)
  assert.equal(cie.previous_consumption_milli, 70_000)
  assert.equal(cie.wash_count, 35)
  assert.ok(Math.abs(cie.ratio_per_wash - 76 / 35) < 1e-9)
  assert.equal(cie.previous_ratio_per_wash, 2)
  assert.equal(cie.ratio_trend_percent, 8.6)
  assert.equal(cie.alert_count, 1)
  assert.equal(cie.missing_days, 0)
  assert.ok(Math.abs(cie.daily_average_milli - 76_000 / 7) < 1e-9)
  assert.equal(sodeci.consumption_milli, 7_000)
  assert.equal(sodeci.ratio_per_wash, 200)
  assert.equal(sodeci.ratio_trend_percent, 0)
  const today = insights.days.find((day: { date: string }) => day.date === dateOffset(0))
  const todayCie = today.readings.find((reading: { provider?: string } | null) => reading?.provider === "cie")
  assert.equal(todayCie.has_photo, true)
  assert.match(todayCie.anomaly_comment, /essai technique/)
  assert.ok(todayCie.alerts.some((alert: { code: string }) => alert.code === "high_per_wash"))
})

test("une période de trois jours conserve ses six lavages sans répartition artificielle", async () => {
  const site = (await pool.query(
    "INSERT INTO sites(organization_id,name,city) VALUES($1,$2,'Abidjan') RETURNING id",
    [orgId, `Relevé espacé ${randomUUID().slice(0, 8)}`],
  )).rows[0].id
  const meter = await createMeter(site, "cie", "GAP-CIE")
  await pool.query(
    `INSERT INTO utility_readings(organization_id,meter_id,reading_date,index_milli)
     VALUES($1,$2,$3::date,500000),($1,$2,$4::date,503000)`,
    [orgId, meter, dateOffset(-3), dateOffset(0)],
  )
  await seedWashes(site, [-2, -1, 0], 2)
  const response = await api(`/api/v1/utility-insights?site_id=${site}`)
  assert.equal(response.status, 200)
  const insights = await response.json()
  const today = insights.days.find((day: { date: string }) => day.date === dateOffset(0))
  const period = today.readings.find((reading: { provider?: string } | null) => reading?.provider === "cie")
  assert.equal(period.period_days, 3)
  assert.equal(period.consumption_milli, 3_000)
  assert.equal(period.wash_count, 6)
  assert.equal(period.ratio_per_wash, 0.5)
  assert.equal(today.wash_count, 2)
  assert.equal(insights.providers[0].multi_day_periods, 1)
  assert.equal(insights.providers[0].missing_days, 5)
})
