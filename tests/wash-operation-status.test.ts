/**
 * Avancement operationnel d'un lavage.
 *
 * Le lavage est enregistre quand il est rendu : il est donc ne "completed"
 * des sa creation, et tout le comptable (rapports, rendement, encaissements)
 * repose sur cette valeur. L'avancement — en attente, en cours, termine —
 * dit autre chose : ou en est la voiture.
 *
 * Ce test verifie que les deux ne se confondent jamais, et que le geste
 * reste dans les mains de ceux qui tiennent le poste.
 */
import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { randomUUID } from "node:crypto"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import {
  nextOperationStatus,
  normaliseOperationStatus,
  OPERATION_STATUSES,
} from "../src/lib/wash-operation-status.ts"

const PASSWORD = "WashPilot2026!"

let server: Server
let baseUrl: string
let pool: Pool
let orgId: string
let siteId: string
let vehicleCategoryId: string
let serviceId: string
let servicePriceCents: number

const sessions = new Map<string, string>()

async function api(
  path: string,
  options: { as?: string; method?: string; body?: unknown; key?: string } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (options.as) {
    const cookie = sessions.get(options.as)
    if (cookie) headers.Cookie = cookie
  }
  if (options.key) headers["Idempotency-Key"] = options.key
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
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

interface WashCree {
  id: string
  reference: string
  status: string
  operation_status: string
  payment_status: string
  total_cents: number
}

/** Enregistre un lavage par l'API, comme le caissier le fait. */
async function enregistrerLavage(): Promise<WashCree> {
  const response = await api("/api/v1/washes", {
    as: "caisse@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: {
      site_id: siteId,
      vehicle_category_id: vehicleCategoryId,
      items: [{ service_id: serviceId, quantity: 1 }],
      payment_method: "wave",
      amount_received_cents: servicePriceCents,
    },
  })
  assert.equal(response.status, 201, "création du lavage")
  return (await response.json()) as WashCree
}

async function avancer(washId: string, status: string, as = "caisse@washpilot.ci") {
  return api(`/api/v1/washes/${washId}/status`, {
    as,
    method: "PATCH",
    body: { status },
  })
}

/** Les chiffres du rapport du jour : le comptable, pas l'avancement. */
async function resumeRapport(): Promise<{ total_washes: number; completed_washes: number }> {
  const today = new Date().toISOString().slice(0, 10)
  const response = await api(
    `/api/v1/reports/summary?from=${today}&to=${today}&granularity=day`,
    { as: "demo@washpilot.ci" },
  )
  assert.equal(response.status, 200, "lecture du rapport")
  const rapport = (await response.json()) as {
    summary?: { total_washes?: number; completed_washes?: number }
  }
  return {
    total_washes: Number(rapport.summary?.total_washes ?? 0),
    completed_washes: Number(rapport.summary?.completed_washes ?? 0),
  }
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

  for (const email of ["demo@washpilot.ci", "caisse@washpilot.ci", "laveur@washpilot.ci"]) {
    await login(email)
  }

  const org = await pool.query(
    "SELECT m.organization_id FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email='demo@washpilot.ci'",
  )
  orgId = String(org.rows[0].organization_id)

  const site = await pool.query(
    "SELECT id FROM sites WHERE organization_id=$1::uuid AND is_active ORDER BY created_at LIMIT 1",
    [orgId],
  )
  siteId = String(site.rows[0].id)

  const vehicle = await pool.query(
    "SELECT id FROM vehicle_categories WHERE organization_id=$1::uuid AND is_active ORDER BY created_at LIMIT 1",
    [orgId],
  )
  vehicleCategoryId = String(vehicle.rows[0].id)

  const service = await pool.query(
    "SELECT id, price_cents FROM services WHERE organization_id=$1::uuid AND is_active ORDER BY created_at LIMIT 1",
    [orgId],
  )
  serviceId = String(service.rows[0].id)
  servicePriceCents = Number(service.rows[0].price_cents)
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

test("un lavage enregistre attend, mais il est deja comptabilise", async () => {
  const wash = await enregistrerLavage()
  assert.equal(wash.operation_status, "pending", "un lavage naît en attente")
  assert.equal(wash.status, "completed", "le statut comptable reste terminé")
  assert.equal(wash.payment_status, "paid", "l'encaissement n'attend pas l'avancement")
})

test("un lavage en attente ne fait pas disparaître la station des rapports", async () => {
  const avant = await resumeRapport()
  const wash = await enregistrerLavage()
  const apres = await resumeRapport()

  assert.equal(
    apres.total_washes,
    avant.total_washes + 1,
    "un lavage en attente reste compté dans les rapports",
  )
  assert.equal(
    apres.completed_washes,
    avant.completed_washes + 1,
    "et il reste compté comme terminé : l'avancement ne touche pas au comptable",
  )
  assert.ok(wash.id)
})

test("faire avancer un lavage le fait passer de « en attente » à « en cours », puis à « terminé »", async () => {
  const wash = await enregistrerLavage()

  const premier = await avancer(wash.id, "in_progress")
  assert.equal(premier.status, 200)
  const apresUn = (await premier.json()) as WashCree
  assert.equal(apresUn.operation_status, "in_progress")
  assert.equal(apresUn.status, "completed", "le statut comptable n'est pas touché")

  const second = await avancer(wash.id, "completed")
  assert.equal(second.status, 200)
  const apresDeux = (await second.json()) as WashCree
  assert.equal(apresDeux.operation_status, "completed")
  assert.equal(apresDeux.status, "completed")
})

test("un lavage déjà terminé reste terminé : le clic suivant ne fait rien", async () => {
  const wash = await enregistrerLavage()
  await avancer(wash.id, "in_progress")
  await avancer(wash.id, "completed")
  const encore = await avancer(wash.id, "completed")
  assert.equal(encore.status, 200)
  const final = (await encore.json()) as WashCree
  assert.equal(final.operation_status, "completed")
})

test("le caissier fait avancer le lavage : c'est son poste", async () => {
  const wash = await enregistrerLavage()
  const response = await avancer(wash.id, "in_progress", "caisse@washpilot.ci")
  assert.equal(response.status, 200)
})

test("l'agent de lavage ne fait pas avancer le statut : ce n'est pas son droit", async () => {
  const wash = await enregistrerLavage()
  const response = await avancer(wash.id, "in_progress", "laveur@washpilot.ci")
  assert.equal(response.status, 403)
})

test("un avancement inconnu est refusé", async () => {
  const wash = await enregistrerLavage()
  const response = await avancer(wash.id, "volé")
  assert.equal(response.status, 400)
})

test("un lavage annulé ne se fait plus avancer", async () => {
  const wash = await enregistrerLavage()
  const annulation = await api(`/api/v1/washes/${wash.id}/cancel`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Test : lavage annulé" },
  })
  assert.equal(annulation.status, 200)

  const response = await avancer(wash.id, "in_progress")
  assert.equal(response.status, 409)
})

test("le lavage d'une autre station reste introuvable", async () => {
  // Un lavage appartenant a une autre organisation : le caissier de la
  // station demo ne doit meme pas savoir qu'il existe.
  const autre = await pool.query(
    "INSERT INTO organizations(name, slug) VALUES('Station Eprouvee','station-eprouvee') RETURNING id",
  )
  const autreOrg = String(autre.rows[0].id)
  try {
    const site = await pool.query(
      "INSERT INTO sites(organization_id, name, city) VALUES($1::uuid,'Station Eprouvee','Abidjan') RETURNING id",
      [autreOrg],
    )
    const wash = await pool.query(
      `INSERT INTO washes(organization_id, site_id, status, payment_status, operation_status, total_cents, reference)
       VALUES($1::uuid,$2::uuid,'completed','paid','pending',100000,'EPR-0001') RETURNING id`,
      [autreOrg, site.rows[0].id],
    )
    const washId = String(wash.rows[0].id)

    const response = await api(`/api/v1/washes/${washId}/status`, {
      as: "caisse@washpilot.ci",
      method: "PATCH",
      body: { status: "in_progress" },
    })
    assert.equal(response.status, 404, "un lavage d'une autre station est introuvable")

    const apres = await pool.query("SELECT operation_status FROM washes WHERE id=$1::uuid", [washId])
    assert.equal(apres.rows[0].operation_status, "pending", "l'avancement n'a pas bougé")
  } finally {
    await pool.query("DELETE FROM washes WHERE organization_id=$1::uuid", [autreOrg])
    await pool.query("DELETE FROM sites WHERE organization_id=$1::uuid", [autreOrg])
    await pool.query("DELETE FROM organizations WHERE id=$1::uuid", [autreOrg])
  }
})

test("chaque changement d'avancement est tracé dans le journal", async () => {
  const wash = await enregistrerLavage()
  await avancer(wash.id, "in_progress")
  const journal = await pool.query(
    "SELECT action, metadata FROM audit_logs WHERE entity_id=$1 AND action='wash.status_changed'",
    [wash.id],
  )
  assert.equal(journal.rowCount, 1, "le changement doit laisser une trace")
  const metadata = journal.rows[0].metadata as { from?: string; to?: string }
  assert.equal(metadata.from, "pending")
  assert.equal(metadata.to, "in_progress")
})

test("l'avancement est bien rangé en base, à côté du statut comptable", async () => {
  const wash = await enregistrerLavage()
  await avancer(wash.id, "in_progress")
  const ligne = await pool.query(
    "SELECT status, operation_status FROM washes WHERE id=$1::uuid",
    [wash.id],
  )
  assert.equal(ligne.rows[0].status, "completed")
  assert.equal(ligne.rows[0].operation_status, "in_progress")
})

test("le parcours des états est linéaire et terminal", () => {
  assert.equal(nextOperationStatus("pending"), "in_progress")
  assert.equal(nextOperationStatus("in_progress"), "overtime")
  assert.equal(nextOperationStatus("overtime"), "completed")
  assert.equal(nextOperationStatus("completed"), null)
  assert.equal(nextOperationStatus("inconnu"), null)
})

test("un état inconnu se lit comme « terminé », jamais comme un état fantôme", () => {
  assert.equal(normaliseOperationStatus("pending"), "pending")
  assert.equal(normaliseOperationStatus("in_progress"), "in_progress")
  assert.equal(normaliseOperationStatus("completed"), "completed")
  assert.equal(normaliseOperationStatus("inexistant"), "completed")
  assert.equal(normaliseOperationStatus(null), "completed")
  assert.equal(normaliseOperationStatus(undefined), "completed")
})

test("les trois états sont les seuls possibles", () => {
  assert.deepEqual([...OPERATION_STATUSES], ["pending", "in_progress", "overtime", "completed"])
})
