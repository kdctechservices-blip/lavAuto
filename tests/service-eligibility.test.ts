/**
 * Éligibilité d'une prestation : le scénario métier de référence.
 *
 * « Lustrage carrosserie » est autorisé pour une berline (5 000 F) et un SUV
 * (8 000 F), interdit pour une moto. Cette suite prouve, du formulaire de
 * caisse jusqu'à la base :
 *
 *   • la berline et le SUV paient **leur** tarif configuré ;
 *   • la moto ne peut pas recevoir la prestation — même par une requête API
 *     écrite à la main, qui contournerait l'interface ;
 *   • une modification de tarif ne réécrit jamais un lavage déjà enregistré ;
 *   • la synchronisation du catalogue global ne touche pas aux tarifs d'une
 *     station ;
 *   • la migration de compatibilité transcrit l'ancien modèle sans inventer
 *     d'autorisation, et ne réactive jamais une catégorie décochée.
 */
import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import {
  initDatabaseSchema,
  getPool,
  closeDatabase,
  seedServiceCatalog,
  SERVICE_ELIGIBILITY_TRANSCRIPTION_SQL,
} from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"

let server: Server
let baseUrl: string
let pool: Pool
let orgId: string
let siteId: string
let berlineId: string
let suvId: string
let motoId: string
let lustrageId: string
let berlineWashId: string

const PASSWORD = "WashPilot2026!"
let cookie = ""

async function api(path: string, options: { method?: string; body?: unknown; key?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (cookie) headers.Cookie = cookie
  if (options.key) headers["Idempotency-Key"] = options.key
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function createCategory(name: string, family: string): Promise<string> {
  const response = await api("/api/v1/vehicle-categories", {
    method: "POST",
    body: { name, family },
  })
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
  return (await response.json()).id as string
}

async function washWithLustrage(
  categoryId: string,
  options: { key?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; washId: string | null }> {
  const response = await api("/api/v1/washes", {
    method: "POST",
    key: options.key ?? `elig-${categoryId}-${Math.random().toString(36).slice(2)}`,
    body: {
      site_id: siteId,
      vehicle_category_id: categoryId,
      plate: "4444 ELIG 01",
      customer_name: "Scénario référence",
      payment_method: "cash",
      amount_received_cents: 0,
      worker_ids: [],
      items: [{ service_id: lustrageId, quantity: 1 }],
    },
  })
  const body = await response.json()
  return {
    status: response.status,
    body,
    washId: body.id != null ? String(body.id) : null,
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

  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo@washpilot.ci", password: PASSWORD }),
  })
  assert.equal(login.status, 200)
  cookie = login.headers.getSetCookie?.().join("; ") ?? login.headers.get("set-cookie") ?? ""

  const org = await pool.query(
    "SELECT m.organization_id FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email='demo@washpilot.ci'",
  )
  orgId = org.rows[0].organization_id
  siteId = (await pool.query("SELECT id FROM sites WHERE organization_id=$1::uuid LIMIT 1", [orgId])).rows[0].id
  await pool.query(
    `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code='pro'),
       status='active', plan_changed_at=now(), updated_at=now() WHERE organization_id=$1::uuid`,
    [orgId],
  )
  invalidateSubscriptionCache(orgId)

  berlineId = await createCategory("Berline scénario", "berlines")
  suvId = await createCategory("SUV scénario", "suv")
  motoId = await createCategory("Moto scénario", "deux_roues")

  const created = await api("/api/v1/services", {
    method: "POST",
    body: {
      name: "Lustrage carrosserie",
      duration_minutes: 45,
      vehicle_pricing: [
        { vehicle_category_id: berlineId, price_cents: 500000 },
        { vehicle_category_id: suvId, price_cents: 800000 },
      ],
    },
  })
  assert.equal(created.status, 201, JSON.stringify(await created.clone().json()))
  lustrageId = (await created.json()).id
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// ---------------------------------------------------------------------------
// Le scénario de référence
// ---------------------------------------------------------------------------

test("la berline paie 5 000 F, le SUV paie 8 000 F", async () => {
  const berline = await washWithLustrage(berlineId)
  assert.equal(berline.status, 201, JSON.stringify(berline.body))
  assert.equal(Number(berline.body.total_cents), 500000)
  berlineWashId = berline.washId

  const suv = await washWithLustrage(suvId)
  assert.equal(suv.status, 201, JSON.stringify(suv.body))
  assert.equal(Number(suv.body.total_cents), 800000)
})

test("la moto ne peut pas recevoir le lustrage, même par requête manipulée", async () => {
  const moto = await washWithLustrage(motoId)
  assert.equal(moto.status, 400, "le lustrage a été accepté sur une moto")
  assert.equal((moto.body as { error?: { code?: string } }).error?.code, "service_not_available_for_vehicle")
})

test("changer le tarif de la berline ne réécrit pas le lavage historique", async () => {
  const updated = await api(`/api/v1/services/${lustrageId}`, {
    method: "PATCH",
    body: {
      vehicle_pricing: [
        { vehicle_category_id: berlineId, price_cents: 600000 },
        { vehicle_category_id: suvId, price_cents: 800000 },
      ],
    },
  })
  assert.equal(updated.status, 200, JSON.stringify(await updated.clone().json()))

  const next = await washWithLustrage(berlineId)
  assert.equal(Number(next.body.total_cents), 600000, "le nouveau tarif ne s'applique pas au lavage suivant")

  const items = await pool.query(
    "SELECT unit_price_cents, service_name FROM wash_items WHERE wash_id=$1::uuid",
    [berlineWashId],
  )
  assert.equal(items.rowCount, 1)
  assert.equal(Number(items.rows[0].unit_price_cents), 500000, "le lavage historique a été réécrit")
  assert.equal(String(items.rows[0].service_name), "Lustrage carrosserie")

  const receipts = await pool.query(
    "SELECT total_cents FROM washes WHERE id=$1::uuid",
    [berlineWashId],
  )
  assert.equal(Number(receipts.rows[0].total_cents), 500000, "le total historique a bougé")
})

// ---------------------------------------------------------------------------
// Catalogue global et configuration par station
// ---------------------------------------------------------------------------

test("la synchronisation du catalogue ne touche pas aux tarifs de la station", async () => {
  const before = await pool.query(
    "SELECT price_cents FROM service_vehicle_prices WHERE service_id=$1::uuid AND vehicle_category_id=$2::uuid",
    [lustrageId, berlineId],
  )
  assert.equal(Number(before.rows[0].price_cents), 600000)

  await seedServiceCatalog(pool.query.bind(pool))

  const afterSync = await pool.query(
    "SELECT price_cents FROM service_vehicle_prices WHERE service_id=$1::uuid AND vehicle_category_id=$2::uuid",
    [lustrageId, berlineId],
  )
  assert.equal(Number(afterSync.rows[0].price_cents), 600000, "le tarif de la station a été écrasé")
  const service = await pool.query("SELECT name, is_active FROM services WHERE id=$1::uuid", [lustrageId])
  assert.equal(String(service.rows[0].name), "Lustrage carrosserie")
  assert.equal(Boolean(service.rows[0].is_active), true)
})

// ---------------------------------------------------------------------------
// Catégories désactivées : état explicite, jamais de suppression silencieuse
// ---------------------------------------------------------------------------

test("une catégorie désactivée reste conservée, mais ne reçoit plus de lavage", async () => {
  await pool.query("UPDATE vehicle_categories SET is_active=false WHERE id=$1::uuid", [suvId])

  // Ré-enregistrer la prestation avec la même configuration : l'association à
  // la catégorie désactivée est conservée, pas effacée silencieusement.
  const updated = await api(`/api/v1/services/${lustrageId}`, {
    method: "PATCH",
    body: {
      vehicle_pricing: [
        { vehicle_category_id: berlineId, price_cents: 600000 },
        { vehicle_category_id: suvId, price_cents: 800000 },
      ],
    },
  })
  assert.equal(updated.status, 200, JSON.stringify(await updated.clone().json()))
  const pricing = (await updated.json()).vehicle_prices
  assert.equal(pricing[suvId], 800000, "l'association à la catégorie désactivée a été effacée")

  // En revanche, on ne peut pas AJOUTER une association à une catégorie
  // désactivée — seul un reliquat historique se conserve.
  const fresh = await api("/api/v1/services", {
    method: "POST",
    body: {
      name: "Nouvelle prestation",
      vehicle_pricing: [{ vehicle_category_id: suvId, price_cents: 100000 }],
    },
  })
  assert.equal(fresh.status, 400)
  assert.equal((await fresh.json()).error?.code, "inactive_vehicle_category")

  // Un lavage sur la catégorie désactivée est déjà impossible au choix du
  // véhicule (la caisse ne propose que les catégories actives).
  const wash = await washWithLustrage(suvId)
  assert.equal(wash.status, 400)

  await pool.query("UPDATE vehicle_categories SET is_active=true WHERE id=$1::uuid", [suvId])
})

// ---------------------------------------------------------------------------
// Migration de compatibilité : transcrire, jamais inventer
// ---------------------------------------------------------------------------

test("la migration transcrit l'ancien modèle (catégorie → famille → prix de base)", async () => {
  // Ancien modèle : clé de catégorie exacte, clé de famille, prix de base.
  const legacy = await pool.query(
    `INSERT INTO services(organization_id, name, price_cents, price_by_vehicle_type)
     VALUES($1::uuid,'Service ancien modèle', 400000, $2::jsonb) RETURNING id`,
    [orgId, JSON.stringify({ [berlineId]: 700000, suv: 550000 })],
  )
  const legacyId = String(legacy.rows[0].id)

  await pool.query(SERVICE_ELIGIBILITY_TRANSCRIPTION_SQL)

  const rows = await pool.query(
    "SELECT vehicle_category_id, price_cents FROM service_vehicle_prices WHERE service_id=$1::uuid",
    [legacyId],
  )
  const byCategory = new Map(rows.rows.map((row) => [String(row.vehicle_category_id), Number(row.price_cents)]))
  assert.equal(byCategory.get(berlineId), 700000, "la clé de catégorie exacte est respectée")
  assert.equal(byCategory.get(suvId), 550000, "la clé de famille s'applique à ses catégories")
  assert.equal(byCategory.get(motoId), 400000, "le prix de base transcrit l'ancienne règle")
  assert.ok(rows.rowCount >= 3, "toutes les catégories connues sont transcrites")

  // Une prestation déjà configurée n'est jamais re-transcrite : décocher une
  // catégorie survit à un redémarrage.
  await pool.query(
    "DELETE FROM service_vehicle_prices WHERE service_id=$1::uuid AND vehicle_category_id=$2::uuid",
    [legacyId, motoId],
  )
  await pool.query(SERVICE_ELIGIBILITY_TRANSCRIPTION_SQL)
  const again = await pool.query(
    "SELECT 1 FROM service_vehicle_prices WHERE service_id=$1::uuid AND vehicle_category_id=$2::uuid",
    [legacyId, motoId],
  )
  assert.equal(again.rowCount, 0, "la migration a réactivé une catégorie décochée")
})
