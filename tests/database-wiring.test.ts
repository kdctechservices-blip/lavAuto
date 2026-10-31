/**
 * La base de données est-elle réellement branchée à **toutes** les
 * fonctionnalités ?
 *
 * Un écran peut répondre 200 en servant une liste vide, une constante du code
 * ou un cache local : le test de fumée ne le verrait pas, puisqu'il ne regarde
 * que les codes HTTP. Ce fichier vérifie l'autre moitié du contrat — pour
 * chaque fonctionnalité, **la table attendue a bien reçu la ligne**, et la
 * route qui la relit la retrouve.
 *
 * Trois familles de vérifications, dans l'ordre :
 *
 *   1. **Écriture** — chaque parcours (inscription, configuration, caisse,
 *      lavage, encaissement, reçu, dépense, stock, achat, présence, équipe,
 *      support, abonnement, console) laisse une trace dans les tables métier.
 *   2. **Lecture** — les routes de consultation retrouvent ces traces ; une
 *      table écrite mais jamais lue serait un fait perdu.
 *   3. **Schéma** — toute table du schéma est utilisée par du code, et toute
 *      table utilisée existe. Deux tables mortes sont assumées et listées
 *      explicitement ci-dessous : les masquer serait pire que les nommer.
 *
 * Ce test tourne sur la base embarquée en mémoire : aucun service externe,
 * aucun effet sur les données de travail.
 */
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { initDatabaseSchema, getPool, closeDatabase, seedServiceCatalog } from "../server/db.ts"
import { SERVICE_CATALOG_NAMES } from "../server/default-catalog.ts"
import { createApiApp } from "../server/app.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

let server: Server
let baseUrl: string
let pool: Pool
let cookie = ""
let organizationId = ""
let siteId = ""
let vehicleCategoryId = ""
let serviceId = ""
let workerId = ""
let cashSessionId = ""
let washId = ""

/**
 * Réponse d'API telle que ce test la consomme. Les charges utiles varient
 * beaucoup d'une route à l'autre (liste, objet, objet imbriqué) et un typage
 * exhaustif n'apporterait rien ici : ce qui compte est la présence de la ligne
 * en base, pas la forme exacte de la réponse. Les accès restent explicites et
 * échouent bruyamment si la forme change.
 */
type Json = null | string | number | boolean | Json[] | { [key: string]: Json }

interface Reply {
  status: number
  json: Json
}

async function api(pathname: string, options: { method?: string; body?: unknown } = {}): Promise<Reply> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (cookie) headers.Cookie = cookie
  // Toute écriture exige une clé d'idempotence, comme le fait le client : sans
  // elle, les routes protégées contre le double envoi répondent 400 et le test
  // mesurerait autre chose que ce qu'il croit mesurer.
  if ((options.method ?? "GET") !== "GET") headers["Idempotency-Key"] = crypto.randomUUID()
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const setCookie = response.headers.getSetCookie?.().join("; ") ?? response.headers.get("set-cookie") ?? ""
  const session = /(washpilot_session=[^;]+)/.exec(setCookie)
  if (session) cookie = session[1]
  const text = await response.text()
  let json: Json
  try {
    json = text ? (JSON.parse(text) as Json) : null
  } catch {
    // Une réponse non JSON (page d'erreur d'un intermédiaire) est conservée
    // telle quelle : le message d'échec doit la montrer, pas la masquer.
    json = text
  }
  return { status: response.status, json }
}

/**
 * Nombre de lignes d'une table pour la station créée par ce test.
 *
 * Trois tables n'ont pas de `organization_id` : `organizations` est la station
 * elle-même, `auth_sessions` et `password_reset_tokens` se rattachent par
 * l'utilisateur. Les compter autrement que par un `WHERE` naïf évite un test
 * qui passerait pour la mauvaise raison.
 */
async function rows(table: string): Promise<number> {
  const scopes: Record<string, { sql: string; params: unknown[] }> = {
    organizations: { sql: "SELECT 1 FROM organizations WHERE id = $1::uuid", params: [organizationId] },
    auth_sessions: {
      sql: `SELECT 1 FROM auth_sessions s
              JOIN organization_members m ON m.user_id = s.user_id
             WHERE m.organization_id = $1::uuid`,
      params: [organizationId],
    },
    wash_items: {
      sql: `SELECT 1 FROM wash_items i JOIN washes w ON w.id = i.wash_id WHERE w.organization_id = $1::uuid`,
      params: [organizationId],
    },
    wash_assignments: {
      sql: `SELECT 1 FROM wash_assignments a JOIN washes w ON w.id = a.wash_id WHERE w.organization_id = $1::uuid`,
      params: [organizationId],
    },
    support_messages: {
      sql: `SELECT 1 FROM support_messages m
              JOIN support_requests r ON r.id = m.request_id
             WHERE r.organization_id = $1::uuid`,
      params: [organizationId],
    },
    users: {
      sql: `SELECT 1 FROM users u
             WHERE u.organization_id = $1::uuid
                OR u.id IN (SELECT user_id FROM organization_members WHERE organization_id = $1::uuid)`,
      params: [organizationId],
    },
  }
  const scope = scopes[table] ?? { sql: `SELECT 1 FROM ${table} WHERE organization_id = $1::uuid`, params: [organizationId] }
  const q = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM (${scope.sql}) AS scoped`,
    scope.params,
  )
  return Number(q.rows[0].count)
}

/** Vérifie qu'une table a reçu au moins une ligne — et dit laquelle sinon. */
async function expectRows(table: string, expected = 1) {
  const count = await rows(table)
  assert.ok(
    count >= expected,
    `${table} : ${count} ligne(s) pour cette station, ${expected} attendue(s) au moins — la fonctionnalité n'écrit pas dans la base`,
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
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// ---------------------------------------------------------------------------
// 1. Inscription — le compte, la station, l'essai et la configuration
// ---------------------------------------------------------------------------

test("l'inscription écrit le compte, la station, l'abonnement et la progression", async () => {
  const email = `wiring-${Date.now()}@example.ci`
  const password = "MotDePasseTest1!"

  const registered = await api("/api/v1/auth/register", {
    method: "POST",
    body: { firstName: "Awa", lastName: "Câblage", email, password, organizationName: "Station Câblage" },
  })
  assert.equal(registered.status, 201, JSON.stringify(registered.json))
  organizationId = registered.json.organization.id

  await expectRows("users")
  await expectRows("organizations")
  await expectRows("onboarding_progress")
  await expectRows("organization_members")

  const login = await api("/api/v1/auth/login", { method: "POST", body: { email, password } })
  assert.equal(login.status, 200, "connexion après inscription")
  assert.ok(cookie, "cookie de session capturé")

  // La session elle-même est persistée : c'est ce qui permet de la révoquer.
  await expectRows("auth_sessions")
})

// ---------------------------------------------------------------------------
// 2. Configuration de la station — chaque étape écrit dans sa table
// ---------------------------------------------------------------------------

test("la configuration de la station remplit les référentiels métier", async () => {
  const finalPlan = (await api("/api/v1/plans")).json.at(-1)?.code
  assert.ok(finalPlan, "catalogue de forfaits lisible")

  const station = await api("/api/v1/onboarding/progress", {
    method: "PUT",
    body: { stage: "station", data: { name: "Station Câblage", city: "Abidjan", phone: "+225 07 00 00 00 01" } },
  })
  assert.equal(station.status, 200, JSON.stringify(station.json))

  const template = (await api("/api/v1/service-catalog")).json?.[0]
  assert.ok(template, "catalogue de prestations disponible")
  const services = await api("/api/v1/onboarding/progress", {
    method: "PUT",
    body: {
      stage: "services",
      data: {
        selected: [{ template_id: template.id, name: template.name, price_cents: template.price_cents }],
        custom: [],
      },
    },
  })
  assert.equal(services.status, 200, JSON.stringify(services.json))

  const workers = await api("/api/v1/onboarding/progress", {
    method: "PUT",
    body: { stage: "workers", data: { workers: [{ first_name: "Awa", last_name: "Koné", role: "car_washer" }] } },
  })
  assert.equal(workers.status, 200, JSON.stringify(workers.json))

  const plan = await api("/api/v1/onboarding/progress", {
    method: "PUT",
    body: { stage: "plan", data: { plan: finalPlan }, plan_code: finalPlan },
  })
  assert.equal(plan.status, 200, JSON.stringify(plan.json))

  const confirmed = await api("/api/v1/onboarding/confirm", { method: "POST" })
  assert.ok([200, 201].includes(confirmed.status), `confirmation — ${confirmed.status} ${JSON.stringify(confirmed.json)}`)

  // Ce que la configuration a réellement créé.
  await expectRows("sites")
  await expectRows("services")
  await expectRows("workers")
  await expectRows("vehicle_categories")
  // Les catégories de prestations aussi : sans elles, la colonne « Catégorie »
  // du catalogue resterait vide pour tout nouveau client.
  await expectRows("service_categories")
  // L'essai gratuit est un abonnement daté, créé à la confirmation : c'est lui
  // qui porte l'échéance, donc la bascule en lecture seule.
  await expectRows("subscriptions")

  const site = (await api("/api/v1/sites")).json?.[0]
  const service = (await api("/api/v1/services")).json?.[0]
  const category = (await api("/api/v1/vehicle-categories")).json?.[0]
  const worker = (await api("/api/v1/workers")).json?.[0]
  assert.ok(site?.id && service?.id && category?.id && worker?.id, "référentiels interrogeables après confirmation")

  // Chaque prestation est classée dès sa création, et chaque catégorie de
  // véhicule appartient à une famille : c'est la famille qui portera le tarif.
  assert.ok(service.category_id, "la prestation créée n'a pas reçu de catégorie")
  // La durée et la description voyagent avec le modèle : sans durée, tous les
  // lavages recevraient la même heure de fin estimée.
  assert.ok(service.duration_minutes, "la prestation créée n'a pas reçu de durée")
  assert.ok(service.description, "la prestation créée n'a pas reçu de description")
  assert.ok(category.family, "la catégorie de véhicule n'a pas reçu de famille")
  const families = new Set(
    ((await api("/api/v1/vehicle-categories")).json ?? []).map((row: { family: string | null }) => row.family),
  )
  assert.ok(families.size >= 6, "les catégories par défaut doivent couvrir plusieurs familles")
  siteId = site.id
  serviceId = service.id
  vehicleCategoryId = category.id
  workerId = worker.id
})

// ---------------------------------------------------------------------------
// 3. Caisse, lavage, encaissement, reçu — le chemin de l'argent
// ---------------------------------------------------------------------------

test("la caisse, le lavage, l'encaissement et le reçu laissent chacun leur trace", async () => {
  const open = await api("/api/v1/cash-sessions/open", {
    method: "POST",
    body: { site_id: siteId, opening_amount_cents: 5_000_000 },
  })
  assert.ok([200, 201].includes(open.status), `ouverture de caisse — ${open.status} ${JSON.stringify(open.json)}`)
  cashSessionId = open.json.id
  await expectRows("cash_sessions")

  const wash = await api("/api/v1/washes", {
    method: "POST",
    body: {
      site_id: siteId,
      vehicle_category_id: vehicleCategoryId,
      items: [{ service_id: serviceId, quantity: 1 }],
      payment_method: "cash",
      amount_received_cents: 0,
      plate: "4821 CI 01",
      customer_name: "Client Câblage",
      worker_ids: [workerId],
      cash_session_id: cashSessionId,
    },
  })
  assert.ok([200, 201].includes(wash.status), `création de lavage — ${wash.status} ${JSON.stringify(wash.json)}`)
  washId = wash.json.id
  const total = Number(wash.json.total_cents)

  // Une ligne de lavage, ses prestations et ses affectations : trois tables,
  // trois usages distincts. Si l'une manque, l'écran s'affiche mais ment.
  await expectRows("washes")
  await expectRows("wash_items")
  await expectRows("wash_assignments")

  const payment = await api(`/api/v1/washes/${washId}/payments`, {
    method: "POST",
    body: { method: "cash", amount_cents: total, cash_session_id: cashSessionId },
  })
  assert.ok([200, 201].includes(payment.status), `encaissement — ${payment.status} ${JSON.stringify(payment.json)}`)
  await expectRows("payments")
  await expectRows("cash_movements")

  const receipt = await api(`/api/v1/washes/${washId}/receipt`, { method: "POST" })
  assert.equal(receipt.status, 201, `reçu — ${receipt.status} ${JSON.stringify(receipt.json)}`)
  assert.ok(receipt.json?.text, "reçu imprimable non vide")
  // Chaque impression consomme un numéro de copie : c'est cette trace qui
  // empêche un duplicata de passer pour l'original.
  await expectRows("receipt_issues")

  const receiptHistory = await api(`/api/v1/washes/${washId}/receipt/history`)
  assert.equal(receiptHistory.status, 200)
  assert.ok(receiptHistory.json?.issues?.length >= 1, "l'historique des reçus relit la table")

  // Le journal d'audit est écrit par les opérations elles-mêmes.
  await expectRows("audit_logs")
})

test("terminer un lavage produit une notification persistée, lisible par l'équipe", async () => {
  const status = await api(`/api/v1/washes/${washId}/status`, {
    method: "PATCH",
    body: { status: "completed" },
  })
  assert.equal(status.status, 200, `statut du lavage — ${status.status} ${JSON.stringify(status.json)}`)

  // La table recevait déjà cette ligne ; aucune route ne la lisait. C'est
  // exactement ce que ce test empêche de reproduire.
  await expectRows("notifications")

  const feed = await api("/api/v1/notifications?limit=10")
  assert.equal(feed.status, 200, JSON.stringify(feed.json))
  assert.ok(feed.json.notifications.length >= 1, "la notification écrite est relue par l'API")
  const notification = feed.json.notifications[0]
  assert.equal(notification.type, "WASH_COMPLETED")
  assert.equal(notification.entity_id, washId)

  // La lecture est persistée, et une seconde lecture ne la déplace pas.
  const first = await api(`/api/v1/notifications/${notification.id}/read`, { method: "POST" })
  assert.equal(first.status, 200, JSON.stringify(first.json))
  const second = await api(`/api/v1/notifications/${notification.id}/read`, { method: "POST" })
  assert.equal(second.json.read_at, first.json.read_at, "la date de lecture ne bouge pas")

  const unread = await api("/api/v1/notifications?unread_only=true")
  assert.equal(unread.json.notifications.length, 0, "plus rien à lire une fois acquitté")

  // Isolation : l'identifiant d'une notification d'une autre station ne donne
  // rien, même en le devinant.
  const foreign = await api(`/api/v1/notifications/00000000-0000-0000-0000-000000000000/read`, {
    method: "POST",
  })
  assert.equal(foreign.status, 404)
})

// ---------------------------------------------------------------------------
// 4. Dépenses, stock, achats
// ---------------------------------------------------------------------------

test("les dépenses, le stock et les achats alimentent leurs tables", async () => {
  const expense = await api("/api/v1/expenses", {
    method: "POST",
    body: {
      site_id: siteId,
      category: "salary",
      amount_cents: 250_000,
      payment_method: "cash",
      description: "Salaire du jour",
      cash_session_id: cashSessionId,
    },
  })
  assert.ok([200, 201].includes(expense.status), `dépense — ${expense.status} ${JSON.stringify(expense.json)}`)
  await expectRows("expenses")

  const product = await api("/api/v1/products", {
    method: "POST",
    body: { name: "Shampoing 5L", unit: "litre", unit_cost_cents: 150_000, low_stock_threshold_milli: 2_000 },
  })
  assert.ok([200, 201].includes(product.status), `produit — ${product.status} ${JSON.stringify(product.json)}`)
  await expectRows("products")

  const movement = await api("/api/v1/stock-movements", {
    method: "POST",
    body: { product_id: product.json.id, kind: "entry", quantity_milli: 10_000, reason: "Livraison de test" },
  })
  assert.ok([200, 201].includes(movement.status), `mouvement de stock — ${movement.status} ${JSON.stringify(movement.json)}`)
  await expectRows("stock_movements")

  // Le stock d'un produit est la somme de ses mouvements, jamais une colonne :
  // la lecture doit retrouver l'entrée qui vient d'être écrite.
  const products = await api("/api/v1/products")
  const listed = products.json.find((item: { id: string }) => item.id === product.json.id)
  assert.ok(Number(listed?.stock_milli ?? listed?.quantity_milli ?? 0) > 0, "le stock relu vient des mouvements")

  const consumable = await api(`/api/v1/services/${serviceId}/consumables`, {
    method: "PUT",
    body: { items: [{ product_id: product.json.id, quantity_milli: 500 }] },
  })
  assert.equal(consumable.status, 200, `consommables — ${consumable.status} ${JSON.stringify(consumable.json)}`)
  await expectRows("service_consumables")

  const supplier = await api("/api/v1/suppliers", { method: "POST", body: { name: "Fournisseur Câblage" } })
  assert.ok([200, 201].includes(supplier.status), `fournisseur — ${supplier.status} ${JSON.stringify(supplier.json)}`)
  await expectRows("suppliers")

  const purchase = await api("/api/v1/purchases", {
    method: "POST",
    body: {
      supplier_id: supplier.json.id,
      site_id: siteId,
      payment_method: "cash",
      cash_session_id: cashSessionId,
      items: [{ product_id: product.json.id, received_milli: 5_000, unit_cost_cents: 150_000 }],
    },
  })
  assert.ok([200, 201].includes(purchase.status), `achat — ${purchase.status} ${JSON.stringify(purchase.json)}`)
  await expectRows("purchases")
  await expectRows("purchase_items")
  // Un achat reçu engage une dépense et un mouvement de stock : sans ces deux
  // écritures, la marge affichée serait fausse.
  await expectRows("expenses", 2)
  await expectRows("stock_movements", 2)
})

// ---------------------------------------------------------------------------
// 5. Équipe, présence, planning, droits
// ---------------------------------------------------------------------------

test("l'équipe, les présences et les plannings sont persistés", async () => {
  const member = await api("/api/v1/access/members", {
    method: "POST",
    body: {
      email: `membre-${Date.now()}@example.ci`,
      first_name: "Koffi",
      last_name: "Test",
      role: "cashier",
      password: "MotDePasseTest1!",
    },
  })
  assert.ok([200, 201].includes(member.status), `membre — ${member.status} ${JSON.stringify(member.json)}`)
  await expectRows("organization_members", 2)
  await expectRows("users", 2)

  const memberId = member.json?.user_id ?? member.json?.id
  assert.ok(memberId, "identifiant du membre renvoyé")

  const permission = await api(`/api/v1/access/members/${memberId}/permissions/expense:read`, {
    method: "PUT",
    body: { granted: true },
  })
  assert.equal(permission.status, 200, `permission — ${permission.status} ${JSON.stringify(permission.json)}`)
  await expectRows("member_permissions")

  const checkIn = await api("/api/v1/attendance/check-in", { method: "POST", body: { worker_id: workerId } })
  assert.ok([200, 201].includes(checkIn.status), `pointage — ${checkIn.status} ${JSON.stringify(checkIn.json)}`)
  await expectRows("attendance_records")

  const checkOut = await api("/api/v1/attendance/check-out", {
    method: "POST",
    body: { worker_id: workerId, break_minutes: 30 },
  })
  assert.ok([200, 201].includes(checkOut.status), `départ — ${checkOut.status} ${JSON.stringify(checkOut.json)}`)

  const schedule = await api("/api/v1/work-schedules", {
    method: "POST",
    body: { site_id: siteId, worker_id: workerId, day_of_week: 2, start_minute: 480, end_minute: 1080 },
  })
  assert.ok([200, 201].includes(schedule.status), `planning — ${schedule.status} ${JSON.stringify(schedule.json)}`)
  await expectRows("work_schedules")

  // Relire ce qui vient d'être écrit : une table alimentée mais jamais
  // interrogée serait une donnée morte.
  const history = await api("/api/v1/attendance/history")
  assert.equal(history.status, 200)
  assert.ok((history.json?.records ?? history.json ?? []).length >= 1, "l'historique de présence relit la table")
})

// ---------------------------------------------------------------------------
// 6. Support, abonnement, export
// ---------------------------------------------------------------------------

test("le support, l'abonnement et l'export passent par la base", async () => {
  const request = await api("/api/v1/support/requests", {
    method: "POST",
    body: {
      subject: "Problème de caisse",
      category: "technique",
      body: "La caisse ne s'ouvre plus depuis ce matin, que dois-je faire ?",
    },
  })
  assert.ok([200, 201].includes(request.status), `support — ${request.status} ${JSON.stringify(request.json)}`)
  await expectRows("support_requests")

  const requestId = request.json?.request?.id ?? request.json?.id
  const message = await api(`/api/v1/support/requests/${requestId}/messages`, {
    method: "POST",
    body: { body: "Précision ajoutée depuis le test de câblage." },
  })
  assert.ok([200, 201].includes(message.status), `message — ${message.status} ${JSON.stringify(message.json)}`)
  await expectRows("support_messages")

  // Payer un abonnement en mode manuel crée une intention de paiement que
  // l'éditeur validera : c'est elle qui porte les coordonnées de l'encaissement.
  const checkout = await api("/api/v1/subscription/checkout", {
    method: "POST",
    body: { plan_code: (await api("/api/v1/plans")).json.at(-1).code, months: 1 },
  })
  assert.ok([200, 201].includes(checkout.status), `checkout — ${checkout.status} ${JSON.stringify(checkout.json)}`)
  await expectRows("payment_intents")

  const declared = await api(`/api/v1/subscription/checkout/${checkout.json.reference}/declare`, {
    method: "POST",
    body: { transaction_reference: "OM-20261022-0001", paid_with: "orange_money" },
  })
  assert.equal(declared.status, 200, `déclaration — ${declared.status} ${JSON.stringify(declared.json)}`)
  const intent = await pool.query(
    "SELECT declared_reference FROM payment_intents WHERE organization_id=$1::uuid ORDER BY created_at DESC LIMIT 1",
    [organizationId],
  )
  assert.equal(intent.rows[0].declared_reference, "OM-20261022-0001", "la déclaration est persistée")

  // L'export lit toutes les tables : il sert de vérification de lecture.
  const backup = await api("/api/v1/backup/export")
  assert.equal(backup.status, 200, `export — ${backup.status}`)
  const exported = backup.json?.data ?? backup.json?.tables ?? {}
  for (const key of ["washes", "payments", "expenses", "products", "workers", "notifications", "customers"]) {
    assert.ok(key in exported, `l'export contient « ${key} »`)
  }
})

// ---------------------------------------------------------------------------
// 7. Schéma — aucune table morte, aucune table fantôme
// ---------------------------------------------------------------------------

test("toute table du schéma est utilisée, toute table utilisée existe", async () => {
  const schema = readFileSync(path.join(root, "server", "db.ts"), "utf8")
  const created = new Set(
    [...schema.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase()),
  )
  assert.ok(created.size > 40, `schéma lu (${created.size} tables)`)

  const sources = new Map<string, string>()
  for (const file of readdirSync(path.join(root, "server"))) {
    if (!file.endsWith(".ts") || file.endsWith(".d.ts") || file === "db.ts") continue
    sources.set(file, readFileSync(path.join(root, "server", file), "utf8"))
  }

  const referenced = new Set<string>()
  for (const text of sources.values()) {
    for (const m of text.matchAll(
      /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/gi,
    )) {
      referenced.add(m[1].toLowerCase())
    }
  }

  /**
   * Tables mortes **assumées**, avec leur raison. Les lister ici plutôt que de
   * les laisser passer inaperçues : une exception documentée se relit, un
   * silence non.
   */
  const documented = new Map([
    ["customers", "Décision du 21 octobre : on suit le véhicule (plaque), pas la personne. Table conservée pour un usage futur."],
    ["clerk_webhook_events", "Héritage d'une architecture d'authentification abandonnée ; suppression à planifier."],
  ])

  const orphans = [...created].filter((table) => !referenced.has(table) && !documented.has(table))
  assert.deepEqual(
    orphans,
    [],
    `tables créées mais jamais utilisées : ${orphans.join(", ")} — brancher la fonctionnalité ou documenter la décision`,
  )

  // L'inverse compte autant : une requête sur une table absente du schéma ne
  // casse qu'à l'exécution, sur la fonctionnalité concernée.
  // Mots qui suivent `FROM`/`UPDATE` dans une phrase SQL ou un commentaire sans
  // être des tables : `FROM the …` apparaît dans des commentaires anglais,
  // `LATERAL` et `ONLY` sont des mots-clés. Sans cette liste, le contrôle
  // signalerait des tables fantômes qui n'existent pas.
  const sqlWords = new Set([
    "select", "where", "set", "values", "on", "as", "and", "or", "not", "null",
    "only", "lateral", "the", "of", "a", "an", "this", "that", "it", "excluded",
    "generate_series", "unnest", "jsonb_array_elements", "pg_catalog",
  ])
  // Les catalogues PostgreSQL (`pg_*`, `information_schema`) ne sont jamais
  // des tables de l'application : la sonde RLS lit `pg_roles`, le schéma y
  // crée le rôle applicatif. Les exclure par préfixe plutôt qu'à la main —
  // la prochaine lecture de catalogue ne relèvera pas du bruit non plus.
  const isSystemCatalog = (table: string) =>
    table.startsWith("pg_") || table.startsWith("information_schema")
  const ghosts = [...referenced].filter(
    (table) => !created.has(table) && !sqlWords.has(table) && !isSystemCatalog(table),
  )
  assert.deepEqual(ghosts, [], `tables utilisées mais absentes du schéma : ${ghosts.join(", ")}`)
})

test("le catalogue des prestations est semé sans doublon, dans l'ordre annoncé", async () => {
  // Rejoué deux fois : c'est ce qui arrive à chaque redémarrage. Un semis non
  // idempotent empêcherait l'ancien nettoyage de faire son travail et
  // l'assistant afficherait la même prestation plusieurs fois.
  const before = await pool.query("SELECT count(*)::int AS n FROM service_catalog")
  await seedServiceCatalog(pool.query.bind(pool))
  await seedServiceCatalog(pool.query.bind(pool))
  const after = await pool.query("SELECT count(*)::int AS n FROM service_catalog")
  assert.equal(Number(after.rows[0].n), Number(before.rows[0].n), "le semis a dupliqué le catalogue")

  const rows = await pool.query(
    "SELECT name, category, price_cents, duration_minutes, description FROM service_catalog WHERE is_active ORDER BY sort_order",
  )
  assert.deepEqual(
    rows.rows.map((row) => row.name),
    [...SERVICE_CATALOG_NAMES],
    "le catalogue exposé ne correspond pas à la liste attendue",
  )
  for (const row of rows.rows) {
    assert.ok(Number(row.price_cents) > 0, `prix absent : ${row.name}`)
    assert.ok(Number(row.duration_minutes) >= 1, `durée absente : ${row.name}`)
    assert.ok(String(row.description ?? "").length > 0, `description absente : ${row.name}`)
  }

  // Ce que voit l'assistant : la même liste, lue par la route publique.
  const catalog = (await api("/api/v1/service-catalog")).json as { name: string; duration_minutes: number }[]
  assert.deepEqual(catalog.map((row) => row.name), [...SERVICE_CATALOG_NAMES])
})

test("les lignes écrites sont relues par les écrans qui les affichent", async () => {
  // Chaque écran de consultation lit une table que ce test a alimentée. Un
  // écran qui répond 200 avec un tableau vide alors que la base contient des
  // lignes signale une jointure cassée ou un filtre trop strict.
  const checks: [string, () => Promise<number>][] = [
    ["/api/v1/washes", async () => (await api("/api/v1/washes")).json.length],
    ["/api/v1/payments", async () => (await api("/api/v1/payments")).json.payments.length],
    ["/api/v1/expenses", async () => (await api("/api/v1/expenses")).json.length],
    ["/api/v1/products", async () => (await api("/api/v1/products")).json.length],
    ["/api/v1/purchases", async () => (await api("/api/v1/purchases")).json.length],
    ["/api/v1/suppliers", async () => (await api("/api/v1/suppliers")).json.length],
    ["/api/v1/workers", async () => (await api("/api/v1/workers")).json.length],
    ["/api/v1/work-schedules", async () => (await api("/api/v1/work-schedules")).json.length],
    ["/api/v1/access/members", async () => (await api("/api/v1/access/members")).json.members.length],
    ["/api/v1/audit-logs", async () => (await api("/api/v1/audit-logs?limit=50")).json.entries.length],
    ["/api/v1/support/requests", async () => (await api("/api/v1/support/requests")).json.requests.length],
    ["/api/v1/notifications", async () => (await api("/api/v1/notifications")).json.notifications.length],
  ]

  for (const [endpoint, count] of checks) {
    assert.ok((await count()) >= 1, `${endpoint} ne relit rien alors que la base contient des lignes`)
  }

  const metrics = await api("/api/v1/dashboard/metrics")
  assert.equal(metrics.status, 200)
  assert.ok(Number(metrics.json.washes ?? metrics.json.total_washes ?? 0) >= 1, "le tableau de bord compte les lavages")
})
