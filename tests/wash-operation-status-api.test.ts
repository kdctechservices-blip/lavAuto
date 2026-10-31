import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { createSession, hashPassword } from "../server/auth.ts"

// ---------------------------------------------------------------------------
// L'avancement operationnel d'un lavage, a travers l'API
//
// Ce que le terrain demande : « ou en est la voiture ? ». Ce que la
// comptabilite demande : « combien, et c'est paye ? ». Les deux reponses ne
// doivent jamais se confondre.
//
// On verifie donc trois choses, et elles se contredisent si l'implémentation
// derive :
//
//   1. **L'avancement est ecrit.** On peut faire passer un lavage d'« en
//      attente » a « en cours », puis a « termine ».
//
//   2. **L'avancement n'ecrit rien d'autre.** Ni le statut comptable, ni le
//      paiement, ni le montant, ni la caisse : avancer la voiture ne touche
//      pas a l'argent.
//
//   3. **L'avancement est trace, surveille et borne.** Chaque cran laisse une
//      ligne d'historique ; un laveur, qui n'a pas le droit, ne peut pas
//      avancer ; un lavage annule est fige ; le lavage d'une autre
//      organisation n'existe pas.
// ---------------------------------------------------------------------------

let pool: Pool
let server: Server
let baseUrl: string

const PASSWORD = "WashPilot2026!"
let seq = 0

interface Member {
  userId: string
  token: string
}

interface Station {
  organizationId: string
  siteId: string
  vehicleCategoryId: string
  serviceId: string
  /** Un laveur de l'equipe, auquel on peut affecter un lavage. */
  workerId: string
  owner: Member
  manager: Member
  cashier: Member
  washer: Member
}

async function req(token: string, path: string, options: { method?: string; body?: unknown } = {}) {
  return fetch(`${baseUrl}/api/v1${path}`, {
    method: options.method ?? "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

/**
 * Une station complete : son site, son catalogue, et un membre par role.
 *
 * Chaque role est un compte a part, avec sa propre session : c'est la seule
 * facon de verifier qu'une permission est reellement refusee a quelqu'un,
 * et pas seulement absente d'une liste.
 */
async function makeStation(name: string): Promise<Station> {
  seq += 1
  const slug = `avancement-${seq}`
  const orgQ = await pool.query(
    "INSERT INTO organizations(name, slug, onboarding_completed) VALUES($1,$2,true) RETURNING id",
    [name, slug],
  )
  const organizationId = orgQ.rows[0].id as string
  await pool.query(
    `INSERT INTO subscriptions(organization_id, plan_id, status, current_period_end)
     VALUES($1,(SELECT id FROM plans WHERE code='pro'),'active', now() + interval '60 days')`,
    [organizationId],
  )
  const siteQ = await pool.query(
    `INSERT INTO sites(organization_id, name, city, address, phone)
     VALUES($1,'Site Riviera','Abidjan','Riviera 3','07 07 07 07 07') RETURNING id`,
    [organizationId],
  )
  const siteId = siteQ.rows[0].id as string
  const categoryQ = await pool.query(
    "INSERT INTO vehicle_categories(organization_id, name, is_active) VALUES($1,'Berline',true) RETURNING id",
    [organizationId],
  )
  const vehicleCategoryId = categoryQ.rows[0].id as string
  const serviceCategoryQ = await pool.query(
    "INSERT INTO service_categories(organization_id, name, is_active) VALUES($1,'Lavage',true) RETURNING id",
    [organizationId],
  )
  const serviceQ = await pool.query(
    `INSERT INTO services(organization_id, category_id, name, price_cents, duration_minutes, is_active)
     VALUES($1,$2,'Lavage complet',600000,45,true) RETURNING id`,
    [organizationId, serviceCategoryQ.rows[0].id],
  )
  const serviceId = serviceQ.rows[0].id as string
  // Nouveau modèle : l'éligibilité est explicite. Sans cette association, le
  // lavage serait refusé — c'est précisément la règle que la refonte pose.
  await pool.query(
    "INSERT INTO service_vehicle_prices(service_id, vehicle_category_id, price_cents) VALUES($1,$2,600000)",
    [serviceId, vehicleCategoryId],
  )

  async function member(role: string, first: string): Promise<Member> {
    seq += 1
    const userQ = await pool.query(
      `INSERT INTO users(email, password_hash, first_name, last_name, status)
       VALUES($1,$2,$3,'Konan','active') RETURNING id`,
      [`${slug}-${role}-${seq}@exemple.ci`, await hashPassword(PASSWORD), first],
    )
    const userId = userQ.rows[0].id as string
    await pool.query(
      "INSERT INTO organization_members(organization_id, user_id, role, status) VALUES($1,$2,$3,'active')",
      [organizationId, userId, role],
    )
    return { userId, token: await createSession(pool, userId) }
  }

  const owner = await member("owner", "Yao")
  const manager = await member("manager", "Serge")
  const cashier = await member("cashier", "Fatou")
  const washer = await member("washer", "Koffi")

  // Un laveur de l'equipe : l'affectation d'un lavage porte sur la table
  // `workers`, qui n'a rien a voir avec les comptes d'acces.
  const workerQ = await pool.query(
    `INSERT INTO workers(organization_id, site_id, first_name, last_name, status)
     VALUES($1,$2,'Koffi','Konan','active') RETURNING id`,
    [organizationId, siteId],
  )
  const workerId = workerQ.rows[0].id as string

  return {
    organizationId,
    siteId,
    vehicleCategoryId,
    serviceId,
    workerId,
    owner,
    manager,
    cashier,
    washer,
  }
}

/**
 * Un lavage deja enregistre et deja encaisse, dont on fixe l'avancement.
 *
 * L'ecriture se fait en SQL direct : on veut un etat de depart connu, pas
 * l'etat produit par la route de creation, que l'on teste par ailleurs.
 */
async function makeWash(
  st: Station,
  options: { operationStatus?: string | null; status?: string; paymentStatus?: string } = {},
): Promise<string> {
  seq += 1
  let columns = "organization_id, site_id, reference, status, total_cents, payment_status, payment_method, created_by"
  let values = "$1,$2,$3,$4,$5,$6,'cash',$7"
  const params: unknown[] = [
    st.organizationId,
    st.siteId,
    `LAV-AVANCEMENT-${String(seq).padStart(6, "0")}`,
    options.status ?? "completed",
    600000,
    options.paymentStatus ?? "paid",
    st.owner.userId,
  ]
  if (options.operationStatus !== null) {
    columns += ", operation_status"
    values += ",$8"
    params.push(options.operationStatus ?? "pending")
  }
  const washQ = await pool.query(
    `INSERT INTO washes(${columns}) VALUES(${values}) RETURNING id`,
    params,
  )
  return washQ.rows[0].id as string
}

let station: Station
let other: Station

before(async () => {
  assert.ok(await initDatabaseSchema(), "base de test initialisée")
  pool = getPool() as Pool
  const app = createApiApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
  station = await makeStation("Station Avancement")
  other = await makeStation("Autre Station")
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// ---------------------------------------------------------------------------
// 1. L'avancement s'ecrit
// ---------------------------------------------------------------------------

test("un lavage enregistre par l'API attend d'etre traite", async () => {
  const response = await fetch(`${baseUrl}/api/v1/washes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${station.owner.token}`,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      site_id: station.siteId,
      vehicle_category_id: station.vehicleCategoryId,
      items: [{ service_id: station.serviceId, quantity: 1 }],
      worker_ids: [],
      payment_method: "orange_money",
      amount_received_cents: 600000,
      plate: "AV-001-AA",
    }),
  })
  const payload = await response.json()
  assert.equal(response.status, 201, JSON.stringify(payload))
  assert.equal(payload.operation_status, "pending")
  assert.equal(payload.status, "completed", "le statut comptable ne bouge pas")
})

test("un lavage enregistre retient sa duree estimee et le nom du client", async () => {
  // La duree estimee vient des prestations : c'est elle que la barre de
  // progression suivra. Elle est figee a l'ecriture, parce qu'une duree qui
  // change sous les pieds du compteur fait sauter la barre.
  const response = await fetch(`${baseUrl}/api/v1/washes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${station.owner.token}`,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      site_id: station.siteId,
      vehicle_category_id: station.vehicleCategoryId,
      items: [{ service_id: station.serviceId, quantity: 2 }],
      worker_ids: [station.workerId],
      payment_method: "orange_money",
      amount_received_cents: 1200000,
      customer_name: "Mme Konan",
    }),
  })
  const payload = await response.json()
  assert.equal(response.status, 201, JSON.stringify(payload))
  assert.equal(payload.estimated_minutes, 90, "45 minutes par prestation, deux fois")
  assert.equal(payload.customer_name, "Mme Konan")
})

test("la liste des lavages nomme les laveurs affectes", async () => {
  const washId = await makeWash(station, { operationStatus: "pending" })
  await pool.query(
    "INSERT INTO wash_assignments(wash_id, worker_id, assignment_role, assigned_by) VALUES($1,$2,'principal',$3)",
    [washId, station.workerId, station.owner.userId],
  )
  const payload = await (await req(station.owner.token, "/washes")).json()
  const wash = payload.find((item: { id: string }) => item.id === washId)
  assert.ok(wash, "le lavage est absent de la liste")
  assert.equal(wash.washers.length, 1)
  assert.equal(wash.washers[0].name, "Koffi Konan")
  assert.equal(wash.washers[0].role, "principal")
})

test("lancer le decompte note l'instant du depart", async () => {
  const washId = await makeWash(station, { operationStatus: "pending" })
  const row = await pool.query("SELECT operation_started_at FROM washes WHERE id=$1::uuid", [washId])
  assert.equal(row.rows[0].operation_started_at, null, "le decompte a demarre sans qu'on le demande")

  const response = await req(station.owner.token, `/washes/${washId}/status`, {
    method: "PATCH",
    body: { status: "in_progress" },
  })
  assert.equal(response.status, 200)
  const wash = await response.json()
  assert.ok(wash.operation_started_at, "aucun instant de depart note")
})

test("revenir en attente efface l'instant du depart", async () => {
  // Une tache remise en attente repart de zero : son ancien depart ne
  // decrirait plus rien.
  const washId = await makeWash(station, { operationStatus: "pending" })
  await req(station.owner.token, `/washes/${washId}/status`, {
    method: "PATCH",
    body: { status: "in_progress" },
  })
  await req(station.owner.token, `/washes/${washId}/status`, {
    method: "PATCH",
    body: { status: "pending" },
  })
  const row = await pool.query("SELECT operation_started_at FROM washes WHERE id=$1::uuid", [washId])
  assert.equal(row.rows[0].operation_started_at, null)
})

test("l'avancement avance d'un cran", async () => {
  const washId = await makeWash(station, { operationStatus: "pending" })
  const response = await req(station.owner.token, `/washes/${washId}/status`, {
    method: "PATCH",
    body: { status: "in_progress" },
  })
  assert.equal(response.status, 200)
  const wash = await response.json()
  assert.equal(wash.operation_status, "in_progress")
})

test("le lavage va jusqu'au bout", async () => {
  const washId = await makeWash(station, { operationStatus: "pending" })
  for (const status of ["in_progress", "completed"]) {
    const response = await req(station.owner.token, `/washes/${washId}/status`, {
      method: "PATCH",
      body: { status },
    })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).operation_status, status)
  }
})

test("un lavage enregistre avant l'avancement est termine", async () => {
  // Les lavages anterieurs a l'avancement n'ont pas ete traites un par un :
  // ils sont termines. Une colonne qui vaudrait « en attente » les ferait
  // tous repasser dans la file.
  const washId = await makeWash(station, { operationStatus: null })
  const row = await pool.query("SELECT operation_status FROM washes WHERE id=$1::uuid", [washId])
  assert.equal(row.rows[0].operation_status, "completed")
})

// ---------------------------------------------------------------------------
// 2. L'avancement n'ecrit rien d'autre
// ---------------------------------------------------------------------------

test("faire avancer un lavage ne touche ni a l'argent ni au statut comptable", async () => {
  const washId = await makeWash(station, {
    operationStatus: "pending",
    status: "completed",
    paymentStatus: "paid",
  })
  const before = await pool.query(
    "SELECT status, payment_status, total_cents, operation_status FROM washes WHERE id=$1::uuid",
    [washId],
  )
  const paymentsBefore = await pool.query(
    "SELECT count(*)::int AS count FROM payments WHERE wash_id=$1::uuid",
    [washId],
  )

  const response = await req(station.owner.token, `/washes/${washId}/status`, {
    method: "PATCH",
    body: { status: "in_progress" },
  })
  assert.equal(response.status, 200)

  const after = await pool.query(
    "SELECT status, payment_status, total_cents, operation_status FROM washes WHERE id=$1::uuid",
    [washId],
  )
  assert.equal(after.rows[0].status, before.rows[0].status, "le statut comptable a bouge")
  assert.equal(after.rows[0].payment_status, before.rows[0].payment_status, "le paiement a bouge")
  assert.equal(after.rows[0].total_cents, before.rows[0].total_cents, "le montant a bouge")
  assert.equal(after.rows[0].operation_status, "in_progress")

  const paymentsAfter = await pool.query(
    "SELECT count(*)::int AS count FROM payments WHERE wash_id=$1::uuid",
    [washId],
  )
  assert.equal(paymentsAfter.rows[0].count, paymentsBefore.rows[0].count, "un encaissement a ete ecrit")
})

// ---------------------------------------------------------------------------
// 3. L'avancement est trace
// ---------------------------------------------------------------------------

test("chaque avancement laisse une trace", async () => {
  const washId = await makeWash(station, { operationStatus: "pending" })
  await req(station.owner.token, `/washes/${washId}/status`, {
    method: "PATCH",
    body: { status: "in_progress" },
  })
  const logs = await pool.query(
    `SELECT action, entity_type, entity_id, metadata FROM audit_logs
      WHERE entity_type='wash' AND entity_id=$1 ORDER BY created_at DESC`,
    [washId],
  )
  assert.equal(logs.rows.length, 1)
  assert.equal(logs.rows[0].action, "wash.status_changed")
  assert.equal(logs.rows[0].entity_id, washId)
  assert.equal(logs.rows[0].metadata.from, "pending")
  assert.equal(logs.rows[0].metadata.to, "in_progress")
})

test("revenir au meme etat ne laisse pas de trace inutile", async () => {
  const washId = await makeWash(station, { operationStatus: "in_progress" })
  const response = await req(station.owner.token, `/washes/${washId}/status`, {
    method: "PATCH",
    body: { status: "in_progress" },
  })
  assert.equal(response.status, 200)
  const logs = await pool.query(
    "SELECT count(*)::int AS count FROM audit_logs WHERE entity_type='wash' AND entity_id=$1",
    [washId],
  )
  assert.equal(logs.rows[0].count, 0, "rien n'a change : rien ne se trace")
})

// ---------------------------------------------------------------------------
// 4. L'avancement est borne
// ---------------------------------------------------------------------------

test("un laveur ne fait pas avancer un lavage", async () => {
  const washId = await makeWash(station, { operationStatus: "pending" })
  const response = await req(station.washer.token, `/washes/${washId}/status`, {
    method: "PATCH",
    body: { status: "in_progress" },
  })
  assert.equal(response.status, 403)
  const payload = await response.json()
  assert.equal(payload.error.code, "forbidden")
  const row = await pool.query("SELECT operation_status FROM washes WHERE id=$1::uuid", [washId])
  assert.equal(row.rows[0].operation_status, "pending", "le lavage a bouge malgre tout")
})

test("le gerant et le caissier font avancer un lavage", async () => {
  for (const role of ["manager", "cashier"] as const) {
    const washId = await makeWash(station, { operationStatus: "pending" })
    const response = await req(station[role].token, `/washes/${washId}/status`, {
      method: "PATCH",
      body: { status: "in_progress" },
    })
    assert.equal(response.status, 200, role)
    assert.equal((await response.json()).operation_status, "in_progress", role)
  }
})

test("un lavage annule reste fige", async () => {
  const washId = await makeWash(station, { operationStatus: "pending", status: "cancelled" })
  const response = await req(station.owner.token, `/washes/${washId}/status`, {
    method: "PATCH",
    body: { status: "in_progress" },
  })
  assert.equal(response.status, 409)
  const payload = await response.json()
  assert.equal(payload.error.code, "wash_cancelled")
})

test("le lavage d'une autre organisation n'existe pas", async () => {
  const washId = await makeWash(other, { operationStatus: "pending" })
  const response = await req(station.owner.token, `/washes/${washId}/status`, {
    method: "PATCH",
    body: { status: "in_progress" },
  })
  assert.equal(response.status, 404)
  const payload = await response.json()
  assert.equal(payload.error.code, "wash_not_found")
})

test("un etat hors nomenclature est refuse", async () => {
  const washId = await makeWash(station, { operationStatus: "pending" })
  const response = await req(station.owner.token, `/washes/${washId}/status`, {
    method: "PATCH",
    body: { status: "en_attente" },
  })
  assert.equal(response.status, 400)
  const row = await pool.query("SELECT operation_status FROM washes WHERE id=$1::uuid", [washId])
  assert.equal(row.rows[0].operation_status, "pending")
})

test("un visiteur non connecte est refuse", async () => {
  const washId = await makeWash(station, { operationStatus: "pending" })
  const response = await fetch(`${baseUrl}/api/v1/washes/${washId}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "in_progress" }),
  })
  assert.equal(response.status, 401)
})
