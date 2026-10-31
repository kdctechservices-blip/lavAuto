import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"

// ---------------------------------------------------------------------------
// Rapports multi-stations
//
// Le propriétaire de plusieurs points de lavage doit pouvoir répondre à deux
// questions distinctes : « combien a fait cette station ? » (filtre) et
// « laquelle marche le mieux ? » (consolidé). Les deux doivent tomber juste
// en même temps, et aucune ne doit laisser passer l'identifiant d'une station
// qui n'appartient pas à l'organisation.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool

const PASSWORD = "WashPilot2026!"
const sessions = new Map<string, string>()
let orgId: string

/** Place l'organisation de test sur un forfait donné. */
async function setPlan(code: string) {
  await pool.query(
    `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code=$2),
       status='active', plan_changed_at=now(), updated_at=now()
     WHERE organization_id=$1::uuid`,
    [orgId, code],
  )
  invalidateSubscriptionCache(orgId)
}


/** Période large mais valide : le serveur refuse au-delà d'un an. */
const FROM = new Date(Date.now() - 180 * 86_400_000).toISOString().slice(0, 10)
const TO = new Date(Date.now() + 1 * 86_400_000).toISOString().slice(0, 10)

let siteA: string
let siteB: string
let foreignSite: string

async function api(path: string, options: { as?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (options.as) {
    const cookie = sessions.get(options.as)
    if (cookie) headers.Cookie = cookie
  }
  return fetch(`${baseUrl}${path}`, { headers })
}

async function report(query: string, as = "demo@washpilot.ci") {
  const response = await api(`/api/v1/reports/summary?from=${FROM}&to=${TO}${query}`, { as })
  assert.equal(response.status, 200, `rapport ${query}`)
  return response.json()
}

async function login(email: string) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  assert.equal(response.status, 200, `connexion ${email}`)
  const cookie = response.headers.getSetCookie?.().join("; ") ?? response.headers.get("set-cookie") ?? ""
  sessions.set(email, cookie)
}

/** Lavage réglé en espèces, rattaché à une station donnée. */
async function seedWash(site: string, amountCents: number) {
  const wash = await pool.query(
    `INSERT INTO washes(organization_id, site_id, status, total_cents, payment_method, payment_status)
     VALUES($1::uuid,$2::uuid,'completed',$3::int,'cash','paid') RETURNING id`,
    [orgId, site, amountCents],
  )
  await pool.query(
    `INSERT INTO payments(organization_id, wash_id, method, amount_cents, status)
     VALUES($1::uuid,$2::uuid,'cash',$3::int,'completed')`,
    [orgId, wash.rows[0].id, amountCents],
  )
}

before(async () => {
  const ready = await initDatabaseSchema()
  assert.ok(ready, "base de test initialisée")
  pool = getPool() as Pool

  const app = createApiApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`

  await login("demo@washpilot.ci")
  await login("caisse@washpilot.ci")

  const org = await pool.query(
    "SELECT m.organization_id FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email='demo@washpilot.ci'",
  )
  orgId = org.rows[0].organization_id
  // Le multi-stations et la vue consolidée sont des fonctions Business.
  await setPlan("business")

  const existing = await pool.query(
    "SELECT id FROM sites WHERE organization_id=$1::uuid ORDER BY created_at LIMIT 1",
    [orgId],
  )
  siteA = existing.rows[0].id
  const created = await pool.query(
    "INSERT INTO sites(organization_id, name, city) VALUES($1::uuid,'Station Yopougon','Abidjan') RETURNING id",
    [orgId],
  )
  siteB = created.rows[0].id

  // Une station appartenant à une autre organisation, pour tester le cloisonnement.
  const other = await pool.query(
    "INSERT INTO organizations(name) VALUES('Lavage voisin') RETURNING id",
  )
  const otherSite = await pool.query(
    "INSERT INTO sites(organization_id, name, city) VALUES($1::uuid,'Station Bouaké','Bouaké') RETURNING id",
    [other.rows[0].id],
  )
  foreignSite = otherSite.rows[0].id

  // 2 lavages à 5 000 F sur A, 1 lavage à 3 000 F sur B, plus une dépense par station.
  await seedWash(siteA, 500_000)
  await seedWash(siteA, 500_000)
  await seedWash(siteB, 300_000)
  await pool.query(
    `INSERT INTO expenses(organization_id, site_id, category, amount_cents, payment_method, status)
     VALUES($1::uuid,$2::uuid,'supply',100000,'cash','completed')`,
    [orgId, siteA],
  )
  await pool.query(
    `INSERT INTO expenses(organization_id, site_id, category, amount_cents, payment_method, status)
     VALUES($1::uuid,$2::uuid,'utilities',50000,'cash','completed')`,
    [orgId, siteB],
  )
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// --- Validation du paramètre ----------------------------------------------

test("un identifiant de station mal formé est rejeté avant d'atteindre le SQL", async () => {
  const response = await api(
    `/api/v1/reports/summary?from=${FROM}&to=${TO}&site_id=1 OR 1=1`,
    { as: "demo@washpilot.ci" },
  )
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, "invalid_site")
})

test("la station d'une autre organisation est introuvable, pas filtrée à vide", async () => {
  // Répondre 200 avec zéro ligne révélerait qu'un identifiant valide existe
  // ailleurs ; on répond 404 comme pour un identifiant inventé.
  const response = await api(
    `/api/v1/reports/summary?from=${FROM}&to=${TO}&site_id=${foreignSite}`,
    { as: "demo@washpilot.ci" },
  )
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, "site_not_found")
})

// --- Filtrage --------------------------------------------------------------

test("sans filtre, le rapport cumule toutes les stations", async () => {
  const data = await report("")
  assert.equal(data.site, null)
  assert.ok(data.summary.total_washes >= 3)
  assert.ok(data.summary.revenue_cents >= 1_300_000)
})

test("le filtre par station ne retient que son chiffre d'affaires", async () => {
  const data = await report(`&site_id=${siteB}`)
  assert.equal(data.site.id, siteB)
  assert.equal(data.site.name, "Station Yopougon")
  assert.equal(data.summary.total_washes, 1)
  assert.equal(data.summary.revenue_cents, 300_000)
  assert.equal(data.summary.expenses_cents, 50_000)
  assert.equal(data.summary.net_cents, 250_000)
})

test("la somme des stations filtrées égale le total consolidé", async () => {
  const all = await report("")
  const a = await report(`&site_id=${siteA}`)
  const b = await report(`&site_id=${siteB}`)
  assert.equal(a.summary.revenue_cents + b.summary.revenue_cents, all.summary.revenue_cents)
  assert.equal(a.summary.total_washes + b.summary.total_washes, all.summary.total_washes)
  assert.equal(a.summary.expenses_cents + b.summary.expenses_cents, all.summary.expenses_cents)
})

test("le filtre s'applique aussi aux moyens de paiement et aux postes de dépense", async () => {
  const data = await report(`&site_id=${siteB}`)
  const cash = data.payment_methods.find((row: { method: string }) => row.method === "cash")
  assert.equal(cash.amount_cents, 300_000)
  const categories = data.expense_categories.map((row: { category: string }) => row.category)
  assert.deepEqual(categories, ["utilities"], "les dépenses de l'autre station ne doivent pas apparaître")
})

test("la série temporelle suit le filtre de station", async () => {
  const data = await report(`&site_id=${siteB}`)
  const revenue = data.series.reduce(
    (total: number, row: { revenue_cents: number }) => total + row.revenue_cents,
    0,
  )
  assert.equal(revenue, 300_000)
})

// --- Vue consolidée --------------------------------------------------------

test("la ventilation par station liste chaque station avec son résultat", async () => {
  const data = await report("")
  const byName = new Map(
    data.by_site.map((row: { site_name: string }) => [row.site_name, row]),
  )
  const yopougon = byName.get("Station Yopougon") as {
    wash_count: number
    revenue_cents: number
    expenses_cents: number
    net_cents: number
    city: string
  }
  assert.equal(yopougon.wash_count, 1)
  assert.equal(yopougon.revenue_cents, 300_000)
  assert.equal(yopougon.expenses_cents, 50_000)
  assert.equal(yopougon.net_cents, 250_000)
  assert.equal(yopougon.city, "Abidjan")
})

test("la ventilation reste consolidée même quand un filtre de station est posé", async () => {
  // C'est tout l'intérêt de la vue du propriétaire : comparer sans perdre
  // le détail de la station qu'il est en train de regarder.
  const data = await report(`&site_id=${siteB}`)
  assert.ok(data.by_site.length >= 2, "toutes les stations restent présentes")
  const total = data.by_site.reduce(
    (sum: number, row: { revenue_cents: number }) => sum + row.revenue_cents,
    0,
  )
  assert.ok(total > data.summary.revenue_cents, "le consolidé dépasse la station filtrée")
})

test("une station sans activité apparaît à zéro au lieu de disparaître", async () => {
  const empty = await pool.query(
    "INSERT INTO sites(organization_id, name, city) VALUES($1::uuid,'Station Grand-Bassam','Grand-Bassam') RETURNING id",
    [orgId],
  )
  const data = await report("")
  const row = data.by_site.find(
    (candidate: { site_id: string }) => candidate.site_id === empty.rows[0].id,
  )
  assert.ok(row, "la station ouverte mais inactive doit figurer au tableau")
  assert.equal(row.wash_count, 0)
  assert.equal(row.revenue_cents, 0)
  assert.equal(row.net_cents, 0)
})

test("la ventilation n'expose aucune station d'une autre organisation", async () => {
  const data = await report("")
  const ids = data.by_site.map((row: { site_id: string }) => row.site_id)
  assert.ok(!ids.includes(foreignSite))
})

// --- Cloisonnement financier ----------------------------------------------

test("sans droit financier, la ventilation masque dépenses et marge mais garde le chiffre d'affaires", async () => {
  const data = await report("", "caisse@washpilot.ci")
  assert.equal(data.financial_access, false)
  assert.ok(data.by_site.length >= 2)
  for (const row of data.by_site) {
    assert.equal(row.expenses_cents, null, "les dépenses doivent rester masquées")
    assert.equal(row.net_cents, null, "la marge doit rester masquée")
    assert.equal(typeof row.revenue_cents, "number")
  }
})
