import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { hashPassword } from "../server/auth.ts"
import { PURGE_EXEMPT, purgeTables, runScheduledPurges } from "../server/organization-deletion.ts"

// ---------------------------------------------------------------------------
// Suppression d'une station, en deux temps
//
// C'est la seule opération irréversible de l'application. Les tests portent
// donc autant sur ce qui NE doit pas arriver — purger sans avoir programmé,
// purger la mauvaise station, emporter un compte qui travaille ailleurs —
// que sur le fonctionnement nominal.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool

const OPERATOR_EMAIL = "ops-deletion@washpilot.ci"
const OPERATOR_PASSWORD = "ConsoleSecret2026!"
const USER_PASSWORD = "WashPilot2026!"
let operatorCookie = ""

async function console_(path: string, options: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (operatorCookie) headers.Cookie = operatorCookie
  return fetch(`${baseUrl}/api/v1/console${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

/** Crée une station jetable, avec un propriétaire et un lavage. */
async function createDisposableStation(suffix: string) {
  const org = await pool.query(
    "INSERT INTO organizations(name, slug, onboarding_completed) VALUES($1,$2,true) RETURNING id",
    [`Station Jetable ${suffix}`, `jetable-${suffix}`],
  )
  const orgId = org.rows[0].id as string

  const email = `proprio-${suffix}@exemple.ci`
  const user = await pool.query(
    `INSERT INTO users(email, password_hash, first_name, last_name, status)
     VALUES($1,$2,'Ama','Konan','active') RETURNING id`,
    [email, await hashPassword(USER_PASSWORD)],
  )
  const userId = user.rows[0].id as string
  await pool.query(
    "INSERT INTO organization_members(organization_id, user_id, role, status) VALUES($1,$2,'owner','active')",
    [orgId, userId],
  )
  await pool.query(
    `INSERT INTO subscriptions(organization_id, plan_id, status, current_period_end)
     VALUES($1,(SELECT id FROM plans WHERE code='pro'),'active', now() + interval '30 days')`,
    [orgId],
  )
  const site = await pool.query(
    "INSERT INTO sites(organization_id, name, city) VALUES($1,'Site','Abidjan') RETURNING id",
    [orgId],
  )
  const vehicle = await pool.query(
    "INSERT INTO vehicle_categories(organization_id, name) VALUES($1,'Berline') RETURNING id",
    [orgId],
  )
  const wash = await pool.query(
    `INSERT INTO washes(organization_id, site_id, vehicle_category_id, reference, status, payment_status, total_cents)
     VALUES($1,$2,$3,$4,'completed','paid',500000) RETURNING id`,
    [orgId, site.rows[0].id, vehicle.rows[0].id, `JET-${suffix}`],
  )
  await pool.query(
    "INSERT INTO payments(organization_id, wash_id, method, amount_cents) VALUES($1,$2,'cash',500000)",
    [orgId, wash.rows[0].id],
  )
  return { orgId, userId, email }
}

async function loginStation(email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: USER_PASSWORD }),
  })
  assert.equal(response.status, 200, `connexion ${email}`)
  return response.headers.getSetCookie?.().join("; ") ?? response.headers.get("set-cookie") ?? ""
}

before(async () => {
  assert.ok(await initDatabaseSchema(), "base de test initialisée")
  pool = getPool() as Pool

  const app = createApiApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`

  await pool.query(
    `INSERT INTO platform_operators(email, password_hash, full_name, status)
     VALUES($1,$2,'Operateur suppression','active')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'`,
    [OPERATOR_EMAIL, await hashPassword(OPERATOR_PASSWORD)],
  )
  const login = await fetch(`${baseUrl}/api/v1/console/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD }),
  })
  assert.equal(login.status, 200)
  operatorCookie = login.headers.getSetCookie?.().join("; ") ?? login.headers.get("set-cookie") ?? ""
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// ---------------------------------------------------------------------------
// 1. L'énumération des tables, vérifiée contre le schéma réel
// ---------------------------------------------------------------------------

test("la purge couvre toutes les tables rattachées à une organisation", async () => {
  // Le risque réel n'est pas la purge d'aujourd'hui mais celle de demain :
  // une table ajoutée plus tard et oubliée dans PURGE_ORDER laisserait des
  // orphelins derrière chaque suppression, sans que rien ne le signale.
  const q = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'organization_id'
      ORDER BY table_name`,
  )
  const inSchema = q.rows.map((row) => row.table_name)
  const covered = new Set([...purgeTables(), ...PURGE_EXEMPT])
  const forgotten = inSchema.filter((name) => !covered.has(name))

  assert.deepEqual(
    forgotten,
    [],
    `tables à organization_id absentes de PURGE_ORDER : ${forgotten.join(", ")}`,
  )
})

// ---------------------------------------------------------------------------
// 2. Premier temps : couper l'accès
// ---------------------------------------------------------------------------

test("programmer la suppression coupe l'accès immédiatement", async () => {
  const { orgId, email } = await createDisposableStation("acces")

  // Avant : la station fonctionne.
  const before_ = await fetch(`${baseUrl}/api/v1/subscription`, {
    headers: { Cookie: await loginStation(email) },
  })
  assert.equal(before_.status, 200, "la station répond avant la suppression")

  const scheduled = await console_(`/organizations/${orgId}/schedule-deletion`, {
    method: "POST",
    body: { reason: "Fermeture demandée par le client" },
  })
  assert.equal(scheduled.status, 200)
  const payload = await scheduled.json()
  assert.ok(payload.scheduled_for, "une échéance d'effacement est renvoyée")

  // Après : l'accès est coupé tout de suite, pas à l'échéance. Le délai de
  // grâce protège les données, il n'offre pas un sursis d'exploitation.
  const after_ = await fetch(`${baseUrl}/api/v1/subscription`, {
    headers: { Cookie: await loginStation(email).catch(() => "") },
  })
  assert.equal(after_.status, 403)
  assert.equal((await after_.json()).error.code, "organization_deleted")
})

test("programmer deux fois la même suppression est refusé", async () => {
  const { orgId } = await createDisposableStation("double")
  await console_(`/organizations/${orgId}/schedule-deletion`, {
    method: "POST",
    body: { reason: "Premier motif suffisamment long" },
  })
  const second = await console_(`/organizations/${orgId}/schedule-deletion`, {
    method: "POST",
    body: { reason: "Second motif suffisamment long" },
  })
  assert.equal(second.status, 409)
  assert.equal((await second.json()).error.code, "deletion_already_scheduled")
})

test("un motif court est refusé", async () => {
  const { orgId } = await createDisposableStation("motif")
  const response = await console_(`/organizations/${orgId}/schedule-deletion`, {
    method: "POST",
    body: { reason: "non" },
  })
  assert.equal(response.status, 400)
})

test("annuler la suppression rouvre l'accès, sans rendre l'abonnement", async () => {
  const { orgId, email } = await createDisposableStation("annule")
  await console_(`/organizations/${orgId}/schedule-deletion`, {
    method: "POST",
    body: { reason: "Erreur de manipulation à corriger" },
  })

  const cancelled = await console_(`/organizations/${orgId}/cancel-deletion`, { method: "POST" })
  assert.equal(cancelled.status, 200)

  const session = await loginStation(email)
  const response = await fetch(`${baseUrl}/api/v1/subscription`, { headers: { Cookie: session } })
  assert.equal(response.status, 200, "la station répond de nouveau")

  // L'abonnement reste résilié : restaurer un accès n'est pas offrir un
  // forfait. La réactivation doit rester un acte explicite et journalisé.
  const state = await pool.query("SELECT status FROM subscriptions WHERE organization_id = $1::uuid", [orgId])
  assert.equal(state.rows[0].status, "cancelled")
})

test("annuler sans suppression programmée est refusé", async () => {
  const { orgId } = await createDisposableStation("rien")
  const response = await console_(`/organizations/${orgId}/cancel-deletion`, { method: "POST" })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, "no_deletion_scheduled")
})

// ---------------------------------------------------------------------------
// 3. Second temps : effacer
// ---------------------------------------------------------------------------

test("purger sans avoir programmé est refusé", async () => {
  const { orgId } = await createDisposableStation("direct")
  const response = await console_(`/organizations/${orgId}/purge`, {
    method: "POST",
    body: { confirm_name: "Station Jetable direct" },
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, "deletion_not_scheduled")

  const still = await pool.query("SELECT 1 FROM organizations WHERE id = $1::uuid", [orgId])
  assert.equal(still.rowCount, 1, "la station doit être intacte")
})

test("un nom de confirmation erroné arrête la purge", async () => {
  const { orgId } = await createDisposableStation("nom")
  await console_(`/organizations/${orgId}/schedule-deletion`, {
    method: "POST",
    body: { reason: "Suppression demandée par le client" },
  })
  const response = await console_(`/organizations/${orgId}/purge`, {
    method: "POST",
    body: { confirm_name: "Station Jetable nom " },
  })
  // L'espace final est toléré (comparaison sur chaîne nettoyée) ; c'est un
  // mauvais nom qui doit échouer, pas une faute de frappe sur l'espacement.
  assert.equal(response.status, 200)

  const wrong = await createDisposableStation("nom2")
  await console_(`/organizations/${wrong.orgId}/schedule-deletion`, {
    method: "POST",
    body: { reason: "Suppression demandée par le client" },
  })
  const refused = await console_(`/organizations/${wrong.orgId}/purge`, {
    method: "POST",
    body: { confirm_name: "Une autre station" },
  })
  assert.equal(refused.status, 400)
  assert.equal((await refused.json()).error.code, "confirmation_mismatch")
  assert.equal(
    (await pool.query("SELECT 1 FROM organizations WHERE id = $1::uuid", [wrong.orgId])).rowCount,
    1,
    "la station doit survivre à une confirmation erronée",
  )
})

test("la purge efface réellement la station et ses données", async () => {
  const { orgId, userId } = await createDisposableStation("purge")
  await console_(`/organizations/${orgId}/schedule-deletion`, {
    method: "POST",
    body: { reason: "Client parti, données à effacer" },
  })

  const response = await console_(`/organizations/${orgId}/purge`, {
    method: "POST",
    body: { confirm_name: "Station Jetable purge" },
  })
  assert.equal(response.status, 200)

  for (const table of ["washes", "payments", "sites", "subscriptions", "organization_members"]) {
    const left = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1::uuid`, [orgId])
    assert.equal(left.rows[0].n, 0, `${table} doit être vide`)
  }
  assert.equal((await pool.query("SELECT 1 FROM organizations WHERE id = $1::uuid", [orgId])).rowCount, 0)
  assert.equal((await pool.query("SELECT 1 FROM users WHERE id = $1::uuid", [userId])).rowCount, 0)
})

test("la purge conserve la trace dans le journal de l'éditeur", async () => {
  const { orgId } = await createDisposableStation("trace")
  await console_(`/organizations/${orgId}/schedule-deletion`, {
    method: "POST",
    body: { reason: "Vérification de la traçabilité" },
  })
  await console_(`/organizations/${orgId}/purge`, {
    method: "POST",
    body: { confirm_name: "Station Jetable trace" },
  })

  // Le registre de l'éditeur survit : c'est la seule preuve qu'il y a eu une
  // station là, et qu'on l'a effacée. Les journaux du client, eux, sont
  // partis avec lui.
  const trace = await pool.query(
    "SELECT action, operator_email FROM platform_audit_logs WHERE organization_name = 'Station Jetable trace' ORDER BY created_at",
  )
  const actions = trace.rows.map((row) => row.action)
  assert.ok(actions.includes("organization.deletion_scheduled"))
  assert.ok(actions.includes("organization.purged"))
  assert.equal(trace.rows[0].operator_email, OPERATOR_EMAIL)
})

test("un compte qui travaille sur une autre station survit à la purge", async () => {
  const a = await createDisposableStation("partage-a")
  const b = await createDisposableStation("partage-b")
  // Le propriétaire de A est aussi caissier chez B.
  await pool.query(
    "INSERT INTO organization_members(organization_id, user_id, role, status) VALUES($1,$2,'cashier','active')",
    [b.orgId, a.userId],
  )

  await console_(`/organizations/${a.orgId}/schedule-deletion`, {
    method: "POST",
    body: { reason: "Fermeture de la station partagée" },
  })
  await console_(`/organizations/${a.orgId}/purge`, {
    method: "POST",
    body: { confirm_name: "Station Jetable partage-a" },
  })

  // Supprimer ce compte lui ferait perdre son emploi chez B.
  assert.equal(
    (await pool.query("SELECT 1 FROM users WHERE id = $1::uuid", [a.userId])).rowCount,
    1,
    "le compte doit survivre, il appartient aussi à une autre station",
  )
  assert.equal(
    (await pool.query("SELECT 1 FROM organization_members WHERE user_id = $1::uuid", [a.userId])).rowCount,
    1,
    "il ne doit lui rester que son appartenance à l'autre station",
  )
})

// ---------------------------------------------------------------------------
// 4. Le planificateur
// ---------------------------------------------------------------------------

test("le planificateur n'efface que les échéances atteintes", async () => {
  const due = await createDisposableStation("echue")
  const notDue = await createDisposableStation("future")

  await console_(`/organizations/${due.orgId}/schedule-deletion`, {
    method: "POST",
    body: { reason: "Échéance à faire passer dans le passé" },
  })
  await console_(`/organizations/${notDue.orgId}/schedule-deletion`, {
    method: "POST",
    body: { reason: "Échéance encore devant nous" },
  })
  // On avance l'horloge d'une seule des deux.
  await pool.query(
    "UPDATE organizations SET deletion_scheduled_for = now() - interval '1 day' WHERE id = $1::uuid",
    [due.orgId],
  )

  const { purged, failed } = await runScheduledPurges(pool)
  assert.deepEqual(failed, [], "aucune purge ne doit échouer")
  assert.ok(purged.includes(due.orgId), "l'échéance dépassée doit être purgée")
  assert.ok(!purged.includes(notDue.orgId), "celle encore à venir doit être épargnée")

  assert.equal((await pool.query("SELECT 1 FROM organizations WHERE id = $1::uuid", [due.orgId])).rowCount, 0)
  assert.equal((await pool.query("SELECT 1 FROM organizations WHERE id = $1::uuid", [notDue.orgId])).rowCount, 1)
})

// ---------------------------------------------------------------------------
// Garde-fou jumeau : l'export de données
//
// La purge et l'export sont les deux faces du même devoir envers le client :
// pouvoir tout effacer, et pouvoir tout lui rendre. Une table oubliée dans
// l'un l'est généralement dans l'autre. Ce test a été ajouté après que le
// lot « stock » eut fait tomber le garde-fou de la purge sans que rien ne
// signale l'absence correspondante dans l'export.
// ---------------------------------------------------------------------------

test("l'export de données couvre toutes les tables métier rattachées à une organisation", async () => {
  const { EXPORT_QUERIES } = await import("../server/backup.ts")
  const exported = new Set(EXPORT_QUERIES.map((entry) => entry.key))

  // Tables techniques : elles portent un `organization_id` mais ne sont pas
  // des données que le client reconnaîtrait comme siennes.
  const horsPerimetre = new Set([
    "organizations",
    "organization_members",
    "subscriptions",
    "platform_audit_logs",
    "users",
    "idempotency_keys",
    "member_permissions",
    "onboarding_progress",
    "subscription_reminders",
    "subscription_payments",
    "payment_intents",
    "error_events",
    "request_metrics",
    "support_requests",
    "support_messages",
    "receipt_issues",
    "audit_logs",
    "clerk_webhook_events",
    "auth_sessions",
    "password_reset_tokens",
  ])

  const q = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'organization_id'
      ORDER BY table_name`,
  )
  const oubliees = q.rows
    .map((row) => row.table_name)
    .filter((name) => !exported.has(name) && !horsPerimetre.has(name))

  assert.deepEqual(
    oubliees,
    [],
    `tables métier absentes de EXPORT_QUERIES : ${oubliees.join(", ")}`,
  )
})
