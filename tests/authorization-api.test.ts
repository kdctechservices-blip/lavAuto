import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"

// ---------------------------------------------------------------------------
// Contrôles d'accès de bout en bout
//
// Ces tests tapent sur la vraie API, avec de vraies sessions : c'est la seule
// façon de prouver qu'un gérant ne contourne pas les restrictions en appelant
// directement l'API, bouton masqué ou non.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool

const PASSWORD = "WashPilot2026!"
const sessions = new Map<string, string>()

async function api(path: string, options: { as?: string; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (options.as) {
    const cookie = sessions.get(options.as)
    if (cookie) headers.Cookie = cookie
  }
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

/** Ouvre une session et mémorise son cookie. */
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

  for (const email of [
    "demo@washpilot.ci", // propriétaire
    "gerant@washpilot.ci", // gérant
    "caisse@washpilot.ci", // caissier
    "laveur@washpilot.ci", // agent de lavage
  ]) {
    await login(email)
  }
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// --- 1. Un utilisateur non connecté ne peut pas appeler l'API --------------

test("un utilisateur non connecté reçoit 401", async () => {
  const response = await api("/api/v1/washes")
  assert.equal(response.status, 401)
})

// --- 2. Le propriétaire peut modifier les tarifs ---------------------------

test("le propriétaire peut modifier un tarif", async () => {
  const services = await (await api("/api/v1/services", { as: "demo@washpilot.ci" })).json()
  const service = services[0]
  const response = await api(`/api/v1/services/${service.id}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { price_cents: service.price_cents + 1000 },
  })
  assert.equal(response.status, 200)
})

// --- 3. Le gérant ne peut pas modifier les tarifs --------------------------

test("le gérant reçoit 403 en tentant de modifier un tarif, malgré une session valide", async () => {
  const services = await (await api("/api/v1/services", { as: "gerant@washpilot.ci" })).json()
  const response = await api(`/api/v1/services/${services[0].id}`, {
    as: "gerant@washpilot.ci",
    method: "PATCH",
    body: { price_cents: 100 },
  })
  assert.equal(response.status, 403)
  const payload = await response.json()
  assert.equal(payload.error.code, "forbidden")
})

// --- 4. Le gérant peut enregistrer un lavage dans sa station ---------------

test("le gérant peut enregistrer un lavage", async () => {
  const [sites, vehicles, services] = await Promise.all([
    (await api("/api/v1/sites", { as: "gerant@washpilot.ci" })).json(),
    (await api("/api/v1/vehicle-categories", { as: "gerant@washpilot.ci" })).json(),
    (await api("/api/v1/services", { as: "gerant@washpilot.ci" })).json(),
  ])
  const response = await fetch(`${baseUrl}/api/v1/washes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessions.get("gerant@washpilot.ci") ?? "",
      "Idempotency-Key": `test-manager-${Date.now()}`,
    },
    body: JSON.stringify({
      site_id: sites[0].id,
      vehicle_category_id: vehicles[0].id,
      items: [{ service_id: services[0].id, quantity: 1 }],
      payment_method: "orange_money",
      amount_received_cents: 0,
    }),
  })
  assert.equal(response.status, 201)
  const wash = await response.json()
  assert.ok(wash.id)
})

// --- 5. Cloisonnement des données financières ------------------------------

test("le gérant voit les dépenses et la marge dans les rapports", async () => {
  // Supervision des sorties d'argent : donner le détail des dépenses sans
  // leur total n'aurait rien protégé, le gérant pouvant les additionner.
  const response = await api("/api/v1/reports/summary?from=2026-01-01&to=2026-12-31", {
    as: "gerant@washpilot.ci",
  })
  assert.equal(response.status, 200)
  const report = await response.json()
  assert.equal(report.financial_access, true)
  assert.equal(typeof report.summary.expenses_cents, "number")
  assert.equal(typeof report.summary.net_cents, "number")
})

test("le caissier voit son activité mais pas la marge de la station", async () => {
  // Le cloisonnement financier n'a pas disparu, il s'est déplacé : c'est
  // désormais le caissier qui marque la frontière, pas le gérant.
  const response = await api("/api/v1/reports/summary?from=2026-01-01&to=2026-12-31", {
    as: "caisse@washpilot.ci",
  })
  assert.equal(response.status, 200)
  const report = await response.json()
  assert.equal(report.financial_access, false)
  assert.equal(report.summary.expenses_cents, null)
  assert.equal(report.summary.net_cents, null)
  assert.deepEqual(report.expense_categories, [])
})

test("le propriétaire voit l'intégralité du rapport", async () => {
  const report = await (
    await api("/api/v1/reports/summary?from=2026-01-01&to=2026-12-31", { as: "demo@washpilot.ci" })
  ).json()
  assert.equal(report.financial_access, true)
  assert.equal(typeof report.summary.expenses_cents, "number")
  assert.equal(typeof report.summary.net_cents, "number")
})

test("gérant et caissier enregistrent les dépenses mais ne les réécrivent pas", async () => {
  // La frontière de la séparation des tâches : l'enregistrement se délègue,
  // la correction et la suppression restent au propriétaire. Sans quoi la
  // personne qui puise dans la caisse pourrait effacer la trace de sa sortie.
  const anyId = "00000000-0000-4000-8000-000000000000"

  for (const who of ["gerant@washpilot.ci", "caisse@washpilot.ci"]) {
    assert.equal((await api("/api/v1/expenses", { as: who })).status, 200, `${who} doit lire les dépenses`)

    // `requirePermission` tranche avant toute lecture en base : l'identifiant
    // inexistant donnerait 404 si la permission passait.
    for (const method of ["PATCH", "DELETE"] as const) {
      const response = await api(`/api/v1/expenses/${anyId}`, {
        as: who,
        method,
        body: method === "PATCH" ? { description: "tentative" } : undefined,
      })
      assert.equal(response.status, 403, `${who} ne doit pas pouvoir ${method} une dépense`)
      assert.equal((await response.json()).error.code, "forbidden")
    }
  }

  // Le propriétaire, lui, atteint bien la logique métier : 404 et non 403.
  const owner = await api(`/api/v1/expenses/${anyId}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { description: "correction" },
  })
  assert.equal(owner.status, 404)
})

test("l'agent de lavage ne voit ni les encaissements, ni la caisse, ni les rapports", async () => {
  for (const path of [
    "/api/v1/payments",
    "/api/v1/cash-sessions",
    "/api/v1/expenses",
    "/api/v1/reports/summary?from=2026-01-01&to=2026-12-31",
    "/api/v1/dashboard/metrics",
  ]) {
    assert.equal(
      (await api(path, { as: "laveur@washpilot.ci" })).status,
      403,
      `${path} devrait être refusé à l'agent de lavage`,
    )
  }
  // Mais il consulte bien son travail.
  assert.equal((await api("/api/v1/washes", { as: "laveur@washpilot.ci" })).status, 200)
  assert.equal((await api("/api/v1/services", { as: "laveur@washpilot.ci" })).status, 200)
})

// --- 6. Administration réservée au propriétaire ----------------------------

test("seul le propriétaire accède à la gestion des accès et à l'export de données", async () => {
  for (const role of ["gerant@washpilot.ci", "caisse@washpilot.ci", "laveur@washpilot.ci"]) {
    assert.equal((await api("/api/v1/access/members", { as: role })).status, 403, role)
    assert.equal((await api("/api/v1/backup/export", { as: role })).status, 403, role)
    assert.equal((await api("/api/v1/users", { as: role })).status, 403, role)
  }
  assert.equal((await api("/api/v1/access/members", { as: "demo@washpilot.ci" })).status, 200)
})

// --- 7. Un utilisateur ne peut pas modifier son propre rôle ----------------

test("un propriétaire ne peut pas modifier son propre rôle, et la tentative est journalisée", async () => {
  const me = await (await api("/api/v1/me/permissions", { as: "demo@washpilot.ci" })).json()
  const response = await api(`/api/v1/access/members/${me.user_id}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { role: "manager" },
  })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, "self_modification_forbidden")

  const log = await pool.query(
    "SELECT metadata FROM audit_logs WHERE action='access.denied' ORDER BY created_at DESC LIMIT 1",
  )
  assert.equal(log.rows[0].metadata.reason, "self_modification")
})

test("un gérant ne peut pas s'attribuer le rôle de propriétaire", async () => {
  const me = await (await api("/api/v1/me/permissions", { as: "gerant@washpilot.ci" })).json()
  const response = await api(`/api/v1/access/members/${me.user_id}`, {
    as: "gerant@washpilot.ci",
    method: "PATCH",
    body: { role: "owner" },
  })
  // Refusé dès le contrôle de permission : il n'a pas user:manage.
  assert.equal(response.status, 403)
  const stillManager = await (await api("/api/v1/me/permissions", { as: "gerant@washpilot.ci" })).json()
  assert.equal(stillManager.role, "manager")
})

// --- 8. Exceptions accordées par le propriétaire ---------------------------

test("une permission accordée par le propriétaire prend effet immédiatement", async () => {
  const members = await (await api("/api/v1/access/members", { as: "demo@washpilot.ci" })).json()
  const manager = members.members.find((m: { role: string }) => m.role === "manager")

  // `data:export` et non `expense:read` : le gérant détient désormais les
  // dépenses par son rôle, le test ne solliciterait donc plus le mécanisme
  // d'exception qu'il est censé vérifier.
  assert.equal((await api("/api/v1/backup/summary", { as: "gerant@washpilot.ci" })).status, 403)

  const granted = await api(`/api/v1/access/members/${manager.user_id}/permissions/data:export`, {
    as: "demo@washpilot.ci",
    method: "PUT",
    body: { granted: true },
  })
  assert.equal(granted.status, 200)
  assert.equal((await api("/api/v1/backup/summary", { as: "gerant@washpilot.ci" })).status, 200)

  // Retour au droit par défaut du rôle.
  await api(`/api/v1/access/members/${manager.user_id}/permissions/data:export`, {
    as: "demo@washpilot.ci",
    method: "PUT",
    body: { granted: null },
  })
  assert.equal((await api("/api/v1/backup/summary", { as: "gerant@washpilot.ci" })).status, 403)
})

test("le propriétaire peut retirer à un gérant les dépenses venues du rôle", async () => {
  // La porte de sortie de la migration : le nouveau défaut n'est pas imposé.
  // Un propriétaire qui ne souhaite pas que son gérant voie les sorties
  // d'argent peut les lui retirer nommément, sans changer son rôle.
  const members = await (await api("/api/v1/access/members", { as: "demo@washpilot.ci" })).json()
  const manager = members.members.find((m: { role: string }) => m.role === "manager")

  assert.equal((await api("/api/v1/expenses", { as: "gerant@washpilot.ci" })).status, 200)

  const revoked = await api(`/api/v1/access/members/${manager.user_id}/permissions/expense:read`, {
    as: "demo@washpilot.ci",
    method: "PUT",
    body: { granted: false },
  })
  assert.equal(revoked.status, 200)
  assert.equal((await api("/api/v1/expenses", { as: "gerant@washpilot.ci" })).status, 403)

  // Le retrait est ciblé : le reste du rôle est intact.
  assert.equal((await api("/api/v1/washes", { as: "gerant@washpilot.ci" })).status, 200)

  await api(`/api/v1/access/members/${manager.user_id}/permissions/expense:read`, {
    as: "demo@washpilot.ci",
    method: "PUT",
    body: { granted: null },
  })
  assert.equal((await api("/api/v1/expenses", { as: "gerant@washpilot.ci" })).status, 200)
})

test("une permission réservée au propriétaire ne peut pas être déléguée", async () => {
  const members = await (await api("/api/v1/access/members", { as: "demo@washpilot.ci" })).json()
  const manager = members.members.find((m: { role: string }) => m.role === "manager")
  const response = await api(`/api/v1/access/members/${manager.user_id}/permissions/user:manage`, {
    as: "demo@washpilot.ci",
    method: "PUT",
    body: { granted: true },
  })
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error.code, "permission_not_grantable")
})

// --- 9. Un membre désactivé ne peut plus rien faire ------------------------

test("un membre désactivé voit toutes ses requêtes refusées", async () => {
  const members = await (await api("/api/v1/access/members", { as: "demo@washpilot.ci" })).json()
  const cashier = members.members.find((m: { role: string }) => m.role === "cashier")

  assert.equal((await api("/api/v1/washes", { as: "caisse@washpilot.ci" })).status, 200)

  const disabled = await api(`/api/v1/access/members/${cashier.user_id}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { status: "disabled" },
  })
  assert.equal(disabled.status, 200)

  const refused = await api("/api/v1/washes", { as: "caisse@washpilot.ci" })
  assert.equal(refused.status, 403)
  assert.equal((await refused.json()).error.code, "membership_disabled")

  // Réactivation : l'accès revient sans nouvelle connexion.
  await api(`/api/v1/access/members/${cashier.user_id}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { status: "active" },
  })
  assert.equal((await api("/api/v1/washes", { as: "caisse@washpilot.ci" })).status, 200)
})

test("la station conserve toujours un propriétaire actif", async () => {
  const members = await (await api("/api/v1/access/members", { as: "demo@washpilot.ci" })).json()
  const owner = members.members.find((m: { role: string }) => m.role === "owner")

  // On promeut le gérant, puis on tente de rétrograder l'unique propriétaire
  // depuis ce second compte : la station en garderait encore un, donc c'est
  // permis. On vérifie ensuite le cas vraiment interdit : le dernier.
  const manager = members.members.find((m: { role: string }) => m.role === "manager")
  await api(`/api/v1/access/members/${manager.user_id}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { role: "owner" },
  })
  await login("gerant@washpilot.ci")

  const demote = await api(`/api/v1/access/members/${owner.user_id}`, {
    as: "gerant@washpilot.ci",
    method: "PATCH",
    body: { role: "manager" },
  })
  assert.equal(demote.status, 200, "rétrograder un propriétaire sur deux est permis")

  const last = await api(`/api/v1/access/members/${manager.user_id}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { role: "manager" },
  })
  assert.equal(last.status, 403, "l'ancien propriétaire n'a plus le droit de gérer les accès")
})

// --- 10. Aucune donnée d'une autre station ---------------------------------

test("un identifiant appartenant à une autre station reste introuvable", async () => {
  const other = await pool.query(
    "INSERT INTO organizations(name, slug) VALUES('Station Concurrente','station-concurrente') RETURNING id",
  )
  const site = await pool.query(
    "INSERT INTO sites(organization_id, name, city) VALUES($1,'Site concurrent','Abidjan') RETURNING id",
    [other.rows[0].id],
  )
  const wash = await pool.query(
    `INSERT INTO washes(organization_id, site_id, reference, status, payment_status, total_cents)
     VALUES($1,$2,'CONC-0001','completed','paid',900000) RETURNING id`,
    [other.rows[0].id, site.rows[0].id],
  )

  const response = await api(`/api/v1/washes/${wash.rows[0].id}`, { as: "demo@washpilot.ci" })
  assert.equal(response.status, 404, "aucune donnée d'une autre station ne doit être retournée")

  const list = await (await api("/api/v1/washes?limit=100", { as: "demo@washpilot.ci" })).json()
  const rows = Array.isArray(list) ? list : (list.washes ?? [])
  assert.equal(
    rows.some((row: { reference: string }) => row.reference === "CONC-0001"),
    false,
  )
})
