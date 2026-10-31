/**
 * CRUD d'une prestation : type de service, catégories de véhicules autorisées,
 * tarif par catégorie.
 *
 * Contrat depuis la refonte : l'**éligibilité** (catégorie autorisée) et le
 * **tarif** sont inséparables — une entrée de `vehicle_pricing` = « cette
 * catégorie peut bénéficier de la prestation, à ce prix ». Aucun repli vers
 * un prix de base ou de famille ne peut contourner une interdiction, même
 * dans une requête HTTP construite à la main. Ce fichier vérifie la chaîne
 * complète, dans l'ordre où elle casse :
 *
 *   1. la prestation se crée avec ses catégories autorisées et leurs prix ;
 *   2. c'est **le prix configuré pour la catégorie** qui part dans le lavage ;
 *   3. une modification de tarif s'applique au lavage suivant, jamais aux
 *      lavages déjà enregistrés (instantanés) ;
 *   4. les refus métier : sans catégorie, prix manquant ou invalide, catégorie
 *      inconnue ou d'une autre station ;
 *   5. la suppression est propre : refusée si un lavage la référence, les
 *      consommables partent avec elle, et rien ne traverse les organisations.
 */
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"

let server: Server
let baseUrl: string
let pool: Pool
let orgId: string
let siteId: string
let vehicleCategoryId: string
let siblingCategoryId: string
let serviceId: string
let firstWashId: string

const PASSWORD = "WashPilot2026!"
let cookie = ""

async function api(
  path: string,
  options: { method?: string; body?: unknown; key?: string } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (cookie) headers.Cookie = cookie
  if (options.key) headers["Idempotency-Key"] = options.key
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
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

  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo@washpilot.ci", password: PASSWORD }),
  })
  assert.equal(login.status, 200, "connexion de la démonstration")
  cookie = login.headers.getSetCookie?.().join("; ") ?? login.headers.get("set-cookie") ?? ""

  const org = await pool.query(
    "SELECT m.organization_id FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email='demo@washpilot.ci'",
  )
  orgId = org.rows[0].organization_id
  siteId = (await pool.query("SELECT id FROM sites WHERE organization_id=$1::uuid LIMIT 1", [orgId])).rows[0].id
  // Le plan Pro ouvre la caisse et le stock : sans lui, les routes répondent
  // 402 et le test mesurerait l'abonnement, pas le CRUD.
  await pool.query(
    `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code='pro'),
       status='active', plan_changed_at=now(), updated_at=now() WHERE organization_id=$1::uuid`,
    [orgId],
  )
  invalidateSubscriptionCache(orgId)
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// ---------------------------------------------------------------------------
// 1. Création : catégories autorisées + tarifs
// ---------------------------------------------------------------------------

test("créer une prestation avec ses catégories autorisées et leurs prix", async () => {
  const first = await api("/api/v1/vehicle-categories", {
    method: "POST",
    body: { name: "SUV clientèle pro", family: "suv" },
  })
  assert.equal(first.status, 201, JSON.stringify(await first.clone().json()))
  const category = await first.json()
  vehicleCategoryId = category.id
  assert.equal(category.family, "suv")

  // Une seconde catégorie de la même famille, avec son propre tarif : dans le
  // nouveau modèle, la famille ne partage plus rien d'implicite — deux
  // catégories, deux autorisations, deux prix.
  const sibling = await api("/api/v1/vehicle-categories", {
    method: "POST",
    body: { name: "SUV familial test", family: "suv" },
  })
  siblingCategoryId = (await sibling.json()).id

  const response = await api("/api/v1/services", {
    method: "POST",
    body: {
      name: "Lavage intérieur simple",
      description: "Aspiration, tableau de bord et plastiques.",
      duration_minutes: 20,
      vehicle_pricing: [
        { vehicle_category_id: vehicleCategoryId, price_cents: 300000 },
        { vehicle_category_id: siblingCategoryId, price_cents: 200000 },
      ],
    },
  })
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
  const service = await response.json()
  serviceId = service.id
  assert.equal(service.name, "Lavage intérieur simple")
  assert.equal(service.duration_minutes, 20)
  assert.equal(service.vehicle_prices[vehicleCategoryId], 300000)
  assert.equal(service.vehicle_prices[siblingCategoryId], 200000)
  assert.equal(service.vehicle_pricing.length, 2, "les deux associations sont enregistrées")
})

// ---------------------------------------------------------------------------
// 2. Facturation : le tarif configuré pour la catégorie, uniquement
// ---------------------------------------------------------------------------

async function washTotal(categoryId: string): Promise<{ id: string; total: number }> {
  const response = await api("/api/v1/washes", {
    method: "POST",
    key: `crud-${categoryId}-${Math.random().toString(36).slice(2)}`,
    body: {
      site_id: siteId,
      vehicle_category_id: categoryId,
      plate: "7777 CRUD 01",
      customer_name: "Client CRUD",
      payment_method: "cash",
      amount_received_cents: 0,
      worker_ids: [],
      items: [{ service_id: serviceId, quantity: 1 }],
    },
  })
  assert.ok([200, 201].includes(response.status), JSON.stringify(await response.clone().json()))
  const wash = await response.json()
  return { id: String(wash.id), total: Number(wash.total_cents) }
}

test("le lavage facture le prix configuré pour la catégorie du véhicule", async () => {
  const first = await washTotal(vehicleCategoryId)
  assert.equal(first.total, 300000)
  firstWashId = first.id
  // Catégorie sœur de la même famille, tarif différent : elle paie LE SIEN.
  // Sous l'ancien modèle, une clé de famille aurait couvert les deux.
  const sibling = await washTotal(siblingCategoryId)
  assert.equal(sibling.total, 200000)
})

test("modifier un tarif s'applique au lavage suivant, jamais aux lavages enregistrés", async () => {
  const response = await api(`/api/v1/services/${serviceId}`, {
    method: "PATCH",
    body: {
      vehicle_pricing: [
        { vehicle_category_id: vehicleCategoryId, price_cents: 350000 },
        { vehicle_category_id: siblingCategoryId, price_cents: 200000 },
      ],
    },
  })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  assert.equal((await response.json()).vehicle_prices[vehicleCategoryId], 350000)
  const next = await washTotal(vehicleCategoryId)
  assert.equal(next.total, 350000, "le nouveau tarif s'applique au lavage suivant")

  // L'historique est figé : le lavage créé avant la modification garde son
  // prix et son libellé du jour, gravés dans `wash_items`.
  const items = await pool.query(
    "SELECT service_name, unit_price_cents, line_total_cents FROM wash_items WHERE wash_id=$1::uuid",
    [firstWashId],
  )
  assert.equal(items.rowCount, 1)
  assert.equal(Number(items.rows[0].unit_price_cents), 300000, "l'ancien lavage a été réécrit")
  assert.equal(String(items.rows[0].service_name), "Lavage intérieur simple")

  // Le changement est journalisé : un tarif qui bouge sans trace est un
  // litige de caisse qui ne se tranche pas.
  const audit = await pool.query(
    "SELECT action FROM audit_logs WHERE organization_id=$1::uuid AND entity_id=$2::text AND action='service.updated' LIMIT 1",
    [orgId, serviceId],
  )
  assert.ok(audit.rowCount, "aucune trace d'audit pour la modification de prix")
})

// ---------------------------------------------------------------------------
// 3. Les refus métier — jamais de contournement par la requête
// ---------------------------------------------------------------------------

test("une prestation sans catégorie autorisée est refusée", async () => {
  const response = await api("/api/v1/services", {
    method: "POST",
    body: { name: "Sans catégorie", vehicle_pricing: [] },
  })
  assert.equal(response.status, 400)
})

test("un tarif manquant est refusé, jamais remplacé par zéro", async () => {
  const response = await api("/api/v1/services", {
    method: "POST",
    body: {
      name: "Prix manquant",
      vehicle_pricing: [{ vehicle_category_id: vehicleCategoryId, price_cents: undefined }],
    },
  })
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.match(String(body.error?.message ?? ""), /Renseignez le prix/i)
})

test("un tarif invalide est refusé", async () => {
  const response = await api("/api/v1/services", {
    method: "POST",
    body: {
      name: "Prix invalide",
      vehicle_pricing: [{ vehicle_category_id: vehicleCategoryId, price_cents: -500 }],
    },
  })
  assert.equal(response.status, 400)
})

test("une catégorie dupliquée est refusée", async () => {
  const response = await api("/api/v1/services", {
    method: "POST",
    body: {
      name: "Doublon",
      vehicle_pricing: [
        { vehicle_category_id: vehicleCategoryId, price_cents: 100000 },
        { vehicle_category_id: vehicleCategoryId, price_cents: 200000 },
      ],
    },
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error?.code, "duplicate_vehicle_category")
})

test("une catégorie inexistante ou d'une autre station est refusée", async () => {
  const unknown = await api("/api/v1/services", {
    method: "POST",
    body: {
      name: "Catégorie inconnue",
      vehicle_pricing: [{ vehicle_category_id: "11111111-1111-4111-8111-111111111111", price_cents: 100000 }],
    },
  })
  assert.equal(unknown.status, 400)
  assert.equal((await unknown.json()).error?.code, "invalid_vehicle_category")

  const otherOrg = await pool.query("INSERT INTO organizations(name) VALUES('Station voisine CRUD') RETURNING id")
  const foreign = await pool.query(
    "INSERT INTO vehicle_categories(organization_id, name, family) VALUES($1::uuid,'Catégorie voisine','suv') RETURNING id",
    [otherOrg.rows[0].id],
  )
  const response = await api(`/api/v1/services/${serviceId}`, {
    method: "PATCH",
    body: {
      vehicle_pricing: [
        { vehicle_category_id: vehicleCategoryId, price_cents: 350000 },
        { vehicle_category_id: foreign.rows[0].id, price_cents: 900000 },
      ],
    },
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error?.code, "invalid_vehicle_category")
})

test("décocher une catégorie retire son autorisation, sans la rendre gratuite", async () => {
  // La catégorie sœur est ôtée de la configuration : un lavage qui la
  // réclamerait — même avec une requête écrite à la main — est refusé.
  const response = await api(`/api/v1/services/${serviceId}`, {
    method: "PATCH",
    body: {
      vehicle_pricing: [{ vehicle_category_id: vehicleCategoryId, price_cents: 350000 }],
    },
  })
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  const service = await response.json()
  assert.equal(service.vehicle_prices[siblingCategoryId], undefined, "l'association décochée survit")

  const bypass = await api("/api/v1/washes", {
    method: "POST",
    key: `bypass-${Math.random().toString(36).slice(2)}`,
    body: {
      site_id: siteId,
      vehicle_category_id: siblingCategoryId,
      plate: "7777 BYPASS 01",
      customer_name: "Contournement",
      payment_method: "cash",
      amount_received_cents: 0,
      worker_ids: [],
      items: [{ service_id: serviceId, quantity: 1 }],
    },
  })
  assert.equal(bypass.status, 400, "le contournement par requête manuelle a fonctionné")
  assert.equal((await bypass.json()).error?.code, "service_not_available_for_vehicle")

  // La catégorie ré-autorisée repart sur son tarif, jamais gratuite.
  const back = await api(`/api/v1/services/${serviceId}`, {
    method: "PATCH",
    body: {
      vehicle_pricing: [
        { vehicle_category_id: vehicleCategoryId, price_cents: 350000 },
        { vehicle_category_id: siblingCategoryId, price_cents: 200000 },
      ],
    },
  })
  assert.equal(back.status, 200)
})

// ---------------------------------------------------------------------------
// 4. Suppression
// ---------------------------------------------------------------------------

test("une prestation déjà vendue ne se supprime pas, elle se désactive", async () => {
  const response = await api(`/api/v1/services/${serviceId}`, { method: "DELETE" })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error?.code, "service_in_use")
  const still = await pool.query("SELECT is_active FROM services WHERE id=$1::uuid", [serviceId])
  assert.equal(still.rowCount, 1, "la prestation a disparu malgré le refus")
})

test("supprimer une prestation jamais vendue, associations et consommables compris", async () => {
  const created = await api("/api/v1/services", {
    method: "POST",
    body: {
      name: "Lustrage de la carrosserie",
      duration_minutes: 60,
      vehicle_pricing: [{ vehicle_category_id: vehicleCategoryId, price_cents: 500000 }],
    },
  })
  assert.equal(created.status, 201)
  const service = await created.json()

  // Un consommable rattaché : sa clé étrangère bloquerait la suppression si
  // elle n'était pas traitée, et le gérant lirait une erreur 500.
  const product = await pool.query(
    `INSERT INTO products(organization_id, name, unit, unit_cost_cents, low_stock_threshold_milli)
     VALUES($1::uuid,'Cire de lustrage','litre',0,0) RETURNING id`,
    [orgId],
  )
  await pool.query(
    "INSERT INTO service_consumables(organization_id, service_id, product_id, quantity_milli) VALUES($1::uuid,$2::uuid,$3::uuid,250)",
    [orgId, service.id, product.rows[0].id],
  )

  const response = await api(`/api/v1/services/${service.id}`, { method: "DELETE" })
  assert.equal(response.status, 204)

  const gone = await pool.query("SELECT 1 FROM services WHERE id=$1::uuid", [service.id])
  assert.equal(gone.rowCount, 0, "la prestation est toujours là")
  const consumables = await pool.query("SELECT 1 FROM service_consumables WHERE service_id=$1::uuid", [service.id])
  assert.equal(consumables.rowCount, 0, "le consommable survit à sa prestation")
  const pricing = await pool.query("SELECT 1 FROM service_vehicle_prices WHERE service_id=$1::uuid", [service.id])
  assert.equal(pricing.rowCount, 0, "les associations survivent à la prestation")

  const audit = await pool.query(
    "SELECT 1 FROM audit_logs WHERE organization_id=$1::uuid AND entity_id=$2::text AND action='service.deleted'",
    [orgId, service.id],
  )
  assert.ok(audit.rowCount, "aucune trace d'audit pour la suppression")

  // Deuxième suppression : la prestation n'existe plus.
  const again = await api(`/api/v1/services/${service.id}`, { method: "DELETE" })
  assert.equal(again.status, 404)
})

test("on ne supprime pas la prestation d'une autre station", async () => {
  const otherOrg = await pool.query("INSERT INTO organizations(name) VALUES('Station lointaine CRUD') RETURNING id")
  const foreign = await pool.query(
    "INSERT INTO services(organization_id, name, price_cents) VALUES($1::uuid,'Prestation voisine',100000) RETURNING id",
    [otherOrg.rows[0].id],
  )
  const response = await api(`/api/v1/services/${foreign.rows[0].id}`, { method: "DELETE" })
  assert.equal(response.status, 404)
  const still = await pool.query("SELECT 1 FROM services WHERE id=$1::uuid", [foreign.rows[0].id])
  assert.equal(still.rowCount, 1, "une autre station a pu supprimer la prestation")
})
