import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { randomUUID } from "node:crypto"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache, CAPABILITIES } from "../server/entitlements.ts"
import { PRICING_PLANS } from "../src/config/pricing.ts"

// ---------------------------------------------------------------------------
// Le stock appartient au forfait Pro
//
// Décision commerciale du 21 octobre 2026. Trois exigences :
//
//   1. le verrou est posé **côté serveur**, sur chacune des onze routes —
//      masquer un bouton n'est jamais une sécurité ;
//   2. le rôle est évalué avant le forfait : un caissier reçoit un refus de
//      droit, jamais une invitation à payer ;
//   3. une station rétrogradée ne perd rien et n'écrit plus rien : son stock
//      se fige là où il était, et enregistrer un lavage reste possible.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool
let orgId: string
let siteId: string
let vehicleCategoryId: string
let cashSessionId: string

const PASSWORD = "WashPilot2026!"
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

async function setPlan(code: string) {
  await pool.query(
    `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code=$2),
       status='active', plan_changed_at=now(), updated_at=now() WHERE organization_id=$1::uuid`,
    [orgId, code],
  )
  invalidateSubscriptionCache(orgId)
}

/** Rend l'espace en lecture seule (essai échu), sans changer de forfait. */
async function expireTrial() {
  await pool.query(
    `UPDATE subscriptions SET status='trialing',
       current_period_end=now() - interval '1 day', updated_at=now() WHERE organization_id=$1::uuid`,
    [orgId],
  )
  invalidateSubscriptionCache(orgId)
}

async function stockDe(productId: string): Promise<number> {
  const q = await pool.query(
    "SELECT COALESCE(SUM(quantity_milli),0)::int AS total FROM stock_movements WHERE product_id=$1::uuid",
    [productId],
  )
  return Number(q.rows[0].total)
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

  for (const email of ["demo@washpilot.ci", "gerant@washpilot.ci", "caisse@washpilot.ci"]) {
    await login(email)
  }

  const org = await pool.query(
    "SELECT m.organization_id FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email='demo@washpilot.ci'",
  )
  orgId = org.rows[0].organization_id
  siteId = (await pool.query("SELECT id FROM sites WHERE organization_id=$1::uuid LIMIT 1", [orgId])).rows[0].id
  vehicleCategoryId = (
    await pool.query("SELECT id FROM vehicle_categories WHERE organization_id=$1::uuid LIMIT 1", [orgId])
  ).rows[0].id

  await setPlan("pro")
  const session = await api("/api/v1/cash-sessions/open", {
    as: "demo@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: { site_id: siteId, opening_amount_cents: 0 },
  })
  const payload = (await session.json()) as { id?: string }
  cashSessionId = String(
    payload.id ??
      (await pool.query("SELECT id FROM cash_sessions WHERE organization_id=$1::uuid AND status='open'", [orgId]))
        .rows[0].id,
  )
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// --- La grille publique et le catalogue disent la même chose ----------------

test("le stock est annoncé sur la grille publique du forfait Pro", () => {
  const pro = PRICING_PLANS.find((p) => p.code === "pro")
  assert.ok(pro, "le forfait Pro existe sur la vitrine")
  assert.ok(
    pro.features.some((f) => /stock/i.test(f)),
    "le mot « stock » doit figurer dans les promesses du forfait Pro",
  )
  const starter = PRICING_PLANS.find((p) => p.code === "starter")
  assert.ok(starter)
  assert.ok(
    !starter.features.some((f) => /stock/i.test(f)),
    "Starter ne doit rien promettre sur le stock",
  )
})

test("les capacités de stock existent dans le catalogue applicatif", () => {
  assert.ok(CAPABILITIES.includes("stock.manage"))
})

test("le stock n'est pas une capacité accordée à tous les forfaits", async () => {
  // Piège rencontré pendant l'écriture de ce lot : la liste des capacités
  // d'écriture de `server/entitlements.ts` ne restreint pas, elle
  // **court-circuite** le forfait (`capabilities[c] = !readOnly`). Y inscrire
  // « stock.manage » revenait à l'offrir à Starter. Ce test ferme la porte.
  await setPlan("starter")
  const response = await api("/api/v1/products", { as: "demo@washpilot.ci" })
  assert.equal(response.status, 402, "Starter ne doit jamais obtenir la capacité de stock")
  await setPlan("pro")
})

test("les forfaits en base accordent le stock à partir de Pro", async () => {
  const q = await pool.query("SELECT code, features FROM plans ORDER BY sort_order")
  const parForfait = new Map(q.rows.map((r) => [r.code, r.features]))
  assert.equal(parForfait.get("starter")["stock.manage"], false)
  assert.equal(parForfait.get("pro")["stock.manage"], true)
  assert.equal(parForfait.get("business")["stock.manage"], true)
})

// --- Le verrou tient côté serveur -------------------------------------------

test("sur Starter, toutes les routes de stock répondent 402", async () => {
  await setPlan("starter")
  const routes: Array<[string, string, unknown]> = [
    ["GET", "/api/v1/products", undefined],
    ["GET", "/api/v1/product-categories", undefined],
    ["GET", "/api/v1/stock-movements", undefined],
    ["POST", "/api/v1/products", { name: "Interdit", unit: "sachet" }],
    ["POST", "/api/v1/product-categories", { name: "Interdite" }],
    ["POST", "/api/v1/stock-movements", { product_id: randomUUID(), kind: "entry", quantity_milli: 1000 }],
  ]
  for (const [method, path, payload] of routes) {
    const response = await api(path, { as: "demo@washpilot.ci", method, body: payload, key: randomUUID() })
    assert.equal(response.status, 402, `${method} ${path}`)
    assert.equal((await response.json()).error.code, "plan_upgrade_required", `${method} ${path}`)
  }
  await setPlan("pro")
})

test("sur Starter, la recette d'une prestation est fermée des deux côtés", async () => {
  await setPlan("pro")
  const service = await api("/api/v1/services", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: `Lavage forfait ${randomUUID().slice(0, 8)}`, duration_minutes: 30, vehicle_pricing: [{ vehicle_category_id: vehicleCategoryId, price_cents: 200_000 }] },
  })
  const serviceId = (await service.json()).id

  await setPlan("starter")
  const lecture = await api(`/api/v1/services/${serviceId}/consumables`, { as: "demo@washpilot.ci" })
  assert.equal(lecture.status, 402)
  const ecriture = await api(`/api/v1/services/${serviceId}/consumables`, {
    as: "demo@washpilot.ci",
    method: "PUT",
    body: { items: [] },
  })
  assert.equal(ecriture.status, 402)
  await setPlan("pro")
})

test("sur Pro, les mêmes routes s'ouvrent", async () => {
  await setPlan("pro")
  for (const path of ["/api/v1/products", "/api/v1/product-categories", "/api/v1/stock-movements"]) {
    const response = await api(path, { as: "demo@washpilot.ci" })
    assert.equal(response.status, 200, path)
  }
})

test("le rôle est évalué avant le forfait : le caissier n'est jamais invité à payer", async () => {
  // Sur Starter, le propriétaire reçoit 402 — c'est une question d'argent.
  // Le caissier, lui, reçoit 403 : le stock ne relève pas de son rôle, et lui
  // proposer un forfait n'aurait aucun sens.
  await setPlan("starter")
  const proprietaire = await api("/api/v1/products", { as: "demo@washpilot.ci" })
  assert.equal(proprietaire.status, 402)
  const caissier = await api("/api/v1/products", { as: "caisse@washpilot.ci" })
  assert.equal(caissier.status, 403)
  await setPlan("pro")
})

test("le gérant reçoit le même refus de forfait que le propriétaire", async () => {
  await setPlan("starter")
  const gerant = await api("/api/v1/products", { as: "gerant@washpilot.ci" })
  assert.equal(gerant.status, 402)
  assert.equal((await gerant.json()).error.code, "plan_upgrade_required")
  await setPlan("pro")
})

// --- Lecture seule : on consulte, on n'écrit plus ---------------------------

test("un essai échu ferme le stock, comme il ferme l'historique", async () => {
  // Le moteur d'abonnement coupe **toutes** les capacités en lecture seule
  // (`!readOnly && featureEnabled(...)`). Le stock suit donc exactement la
  // règle déjà appliquée à l'historique : un espace échu n'y accède plus, et
  // le refus parle d'essai terminé, pas de forfait insuffisant.
  await setPlan("pro")
  const ouvert = await api("/api/v1/products", { as: "demo@washpilot.ci" })
  assert.equal(ouvert.status, 200)

  await expireTrial()
  const ferme = await api("/api/v1/products", { as: "demo@washpilot.ci" })
  assert.equal(ferme.status, 402)
  assert.equal((await ferme.json()).error.code, "trial_expired")

  await setPlan("pro")
  const rouvert = await api("/api/v1/products", { as: "demo@washpilot.ci" })
  assert.equal(rouvert.status, 200, "reprendre un forfait rouvre l'accès")
})

// --- Rétrogradation : rien n'est perdu, rien n'est écrit en douce -----------

test("une station rétrogradée conserve ses produits et sa recette en base", async () => {
  await setPlan("pro")
  const suffix = randomUUID().slice(0, 8)
  const productId = (
    await (
      await api("/api/v1/products", {
        as: "demo@washpilot.ci",
        method: "POST",
        body: { name: `Omo conservé ${suffix}`, unit: "sachet", initial_quantity_milli: 10_000 },
      })
    ).json()
  ).id
  const serviceId = (
    await (
      await api("/api/v1/services", {
        as: "demo@washpilot.ci",
        method: "POST",
        body: { name: `Lavage conservé ${suffix}`, duration_minutes: 30, vehicle_pricing: [{ vehicle_category_id: vehicleCategoryId, price_cents: 200_000 }] },
      })
    ).json()
  ).id
  await api(`/api/v1/services/${serviceId}/consumables`, {
    as: "demo@washpilot.ci",
    method: "PUT",
    body: { items: [{ product_id: productId, quantity_milli: 2000 }] },
  })

  await setPlan("starter")
  const produits = await pool.query("SELECT 1 FROM products WHERE id=$1::uuid", [productId])
  const recette = await pool.query("SELECT 1 FROM service_consumables WHERE service_id=$1::uuid", [serviceId])
  assert.equal(produits.rowCount, 1, "le produit n'est pas supprimé")
  assert.equal(recette.rowCount, 1, "la recette n'est pas supprimée")
  await setPlan("pro")
})

test("sur Starter, enregistrer un lavage reste possible et ne touche plus au stock", async () => {
  // C'est le point le plus important du lot : le forfait Starter vend
  // justement l'enregistrement des lavages. Le gating du stock ne doit en
  // aucun cas l'empêcher.
  await setPlan("pro")
  const suffix = randomUUID().slice(0, 8)
  const productId = (
    await (
      await api("/api/v1/products", {
        as: "demo@washpilot.ci",
        method: "POST",
        body: { name: `Omo figé ${suffix}`, unit: "sachet", initial_quantity_milli: 10_000 },
      })
    ).json()
  ).id
  const serviceId = (
    await (
      await api("/api/v1/services", {
        as: "demo@washpilot.ci",
        method: "POST",
        body: { name: `Lavage figé ${suffix}`, duration_minutes: 30, vehicle_pricing: [{ vehicle_category_id: vehicleCategoryId, price_cents: 200_000 }] },
      })
    ).json()
  ).id
  await api(`/api/v1/services/${serviceId}/consumables`, {
    as: "demo@washpilot.ci",
    method: "PUT",
    body: { items: [{ product_id: productId, quantity_milli: 2000 }] },
  })

  const corps = {
    site_id: siteId,
    vehicle_category_id: vehicleCategoryId,
    cash_session_id: cashSessionId,
    items: [{ service_id: serviceId, quantity: 1 }],
    payment_method: "cash",
    amount_received_cents: 200_000,
  }

  // Sur Pro, la déduction a lieu.
  const surPro = await api("/api/v1/washes", {
    as: "demo@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: corps,
  })
  assert.equal(surPro.status, 201)
  assert.equal(await stockDe(productId), 8_000)

  // Après rétrogradation, le lavage passe toujours — mais le stock ne bouge
  // plus : écrire dans un stock que le client ne peut plus voir le fausserait
  // en silence.
  await setPlan("starter")
  const surStarter = await api("/api/v1/washes", {
    as: "demo@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: corps,
  })
  assert.equal(surStarter.status, 201, "enregistrer un lavage reste le métier de Starter")
  assert.equal(await stockDe(productId), 8_000, "le stock est figé, pas faussé")

  // Et l'annulation d'un lavage déduit avant la rétrogradation rend bien les
  // sachets : la contrepassation n'est pas soumise au forfait, sinon le stock
  // resterait faux sans recours.
  const washId = (await surPro.json()).id
  const annulation = await api(`/api/v1/washes/${washId}/cancel`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Rétrogradation" },
  })
  assert.equal(annulation.status, 200)
  assert.equal(await stockDe(productId), 10_000, "ce qui avait été déduit est rendu")
  await setPlan("pro")
})
