import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { randomUUID } from "node:crypto"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"

// ---------------------------------------------------------------------------
// Relier un mouvement de stock au lavage qui l'a provoqué (lot L4.1)
//
// Deux sens, et une porte.
//
//   1. Du stock vers le lavage : un mouvement de consommation dit de quel
//      lavage il vient, et le dit par sa **référence**, pas par un
//      identifiant technique.
//   2. Du lavage vers le stock : la fiche d'un lavage dit ce qu'il a sorti.
//
// La porte est le point sensible : la fiche de lavage est ouverte à tout
// caissier, alors que le stock ne l'est pas. Sans contrôle, elle
// contournerait d'un coup le rôle **et** le forfait.
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

async function creerProduit(nom: string, sachets: number) {
  const response = await api("/api/v1/products", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: nom, unit: "sachet", unit_cost_cents: 10_000, initial_quantity_milli: sachets * 1000 },
  })
  assert.equal(response.status, 201, `création du produit ${nom}`)
  return String((await response.json()).id)
}

async function creerPrestation(nom: string) {
  const response = await api("/api/v1/services", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: nom, duration_minutes: 30, vehicle_pricing: [{ vehicle_category_id: vehicleCategoryId, price_cents: 200_000 }] },
  })
  assert.equal(response.status, 201, `création de la prestation ${nom}`)
  return String((await response.json()).id)
}

async function definirRecette(serviceId: string, productId: string, sachets: number) {
  const response = await api(`/api/v1/services/${serviceId}/consumables`, {
    as: "demo@washpilot.ci",
    method: "PUT",
    body: { items: [{ product_id: productId, quantity_milli: sachets * 1000 }] },
  })
  assert.equal(response.status, 200, "enregistrement de la recette")
}

async function enregistrerLavage(serviceId: string, as = "demo@washpilot.ci") {
  const response = await api("/api/v1/washes", {
    as,
    method: "POST",
    key: randomUUID(),
    body: {
      site_id: siteId,
      vehicle_category_id: vehicleCategoryId,
      cash_session_id: cashSessionId,
      items: [{ service_id: serviceId, quantity: 1 }],
      payment_method: "cash",
      amount_received_cents: 200_000,
    },
  })
  assert.equal(response.status, 201, "enregistrement du lavage")
  return (await response.json()) as { id: string; reference: string }
}

interface Mouvement {
  id: string
  kind: string
  quantity_milli: number
  wash_id: string | null
  wash_reference: string | null
  product_name: string
}

async function mouvements(): Promise<Mouvement[]> {
  const response = await api("/api/v1/stock-movements", { as: "demo@washpilot.ci" })
  assert.equal(response.status, 200)
  return (await response.json()) as Mouvement[]
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
  await api("/api/v1/cash-sessions/open", {
    as: "demo@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: { site_id: siteId, opening_amount_cents: 0 },
  })
  cashSessionId = (
    await pool.query("SELECT id FROM cash_sessions WHERE organization_id=$1::uuid AND status='open'", [orgId])
  ).rows[0].id
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// --- Sens 1 : du stock vers le lavage --------------------------------------

test("une consommation désigne son lavage par sa référence", async () => {
  const produit = await creerProduit(`Omo référence ${randomUUID().slice(0, 6)}`, 20)
  const service = await creerPrestation(`Lavage référence ${randomUUID().slice(0, 6)}`)
  await definirRecette(service, produit, 2)
  const lavage = await enregistrerLavage(service)

  const ligne = (await mouvements()).find((m) => m.kind === "consumption" && m.wash_id === lavage.id)
  assert.ok(ligne, "la consommation est bien listée")
  assert.equal(ligne.wash_id, lavage.id)
  assert.equal(ligne.wash_reference, lavage.reference, "la référence évite au client d'aller la chercher")
  assert.match(String(ligne.wash_reference), /^LAV-/)
})

test("un mouvement saisi à la main n'affiche aucun lavage", async () => {
  // Le piège serait d'afficher un lien mort, ou pire, le lavage d'à côté.
  const produit = await creerProduit(`Omo manuel ${randomUUID().slice(0, 6)}`, 20)
  const response = await api("/api/v1/stock-movements", {
    as: "demo@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: { product_id: produit, kind: "exit", quantity_milli: 3000, reason: "Casse" },
  })
  assert.equal(response.status, 201)
  const id = (await response.json()).id

  const ligne = (await mouvements()).find((m) => m.id === id)
  assert.ok(ligne)
  assert.equal(ligne.wash_id, null)
  assert.equal(ligne.wash_reference, null)
})

test("la contrepassation d'une annulation pointe vers le même lavage", async () => {
  const produit = await creerProduit(`Omo annulé ${randomUUID().slice(0, 6)}`, 20)
  const service = await creerPrestation(`Lavage annulé ${randomUUID().slice(0, 6)}`)
  await definirRecette(service, produit, 2)
  const lavage = await enregistrerLavage(service)

  const annulation = await api(`/api/v1/washes/${lavage.id}/cancel`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Client reparti" },
  })
  assert.equal(annulation.status, 200)

  const lies = (await mouvements()).filter((m) => m.wash_id === lavage.id)
  assert.equal(lies.length, 2, "la consommation et sa contrepassation")
  for (const m of lies) {
    assert.equal(m.wash_reference, lavage.reference, `${m.kind} doit porter la même référence`)
  }
  assert.deepEqual(lies.map((m) => m.kind).sort(), ["consumption", "reversal"])
})

test("un mouvement n'expose jamais le lavage d'une autre station", async () => {
  // La jointure est bornée par l'organisation. Si elle ne l'était pas, un
  // identifiant de lavage suffirait à faire fuiter une référence voisine.
  const autre = await pool.query("INSERT INTO organizations(name) VALUES('Station voisine L41') RETURNING id")
  const autreOrg = autre.rows[0].id
  const autreSite = await pool.query(
    "INSERT INTO sites(organization_id, name, city) VALUES($1::uuid,'Site voisin','Abidjan') RETURNING id",
    [autreOrg],
  )
  const autreCat = await pool.query(
    "INSERT INTO vehicle_categories(organization_id, name) VALUES($1::uuid,'Berline voisine') RETURNING id",
    [autreOrg],
  )
  const autreLavage = await pool.query(
    `INSERT INTO washes(organization_id, site_id, vehicle_category_id, reference, status, total_cents, payment_method)
     VALUES($1::uuid,$2::uuid,$3::uuid,'LAV-VOISIN-0001','completed',100000,'cash') RETURNING id`,
    [autreOrg, autreSite.rows[0].id, autreCat.rows[0].id],
  )

  // Un mouvement de NOTRE organisation qui pointerait vers le lavage du voisin.
  const produit = await creerProduit(`Omo cloison ${randomUUID().slice(0, 6)}`, 20)
  const intrus = await pool.query(
    `INSERT INTO stock_movements(organization_id, product_id, wash_id, kind, quantity_milli, created_at)
     VALUES($1::uuid,$2::uuid,$3::uuid,'consumption',-1000, now()) RETURNING id`,
    [orgId, produit, autreLavage.rows[0].id],
  )

  const ligne = (await mouvements()).find((m) => m.id === intrus.rows[0].id)
  assert.ok(ligne, "le mouvement appartient bien à notre organisation")
  assert.equal(ligne.wash_reference, null, "la référence du voisin ne doit pas remonter")
})

// --- Sens 2 : du lavage vers le stock ---------------------------------------

test("la fiche d'un lavage dit ce qu'il a sorti du stock", async () => {
  const produit = await creerProduit(`Omo fiche ${randomUUID().slice(0, 6)}`, 20)
  const service = await creerPrestation(`Lavage fiche ${randomUUID().slice(0, 6)}`)
  await definirRecette(service, produit, 3)
  const lavage = await enregistrerLavage(service)

  const response = await api(`/api/v1/washes/${lavage.id}`, { as: "demo@washpilot.ci" })
  assert.equal(response.status, 200)
  const detail = (await response.json()) as {
    consumables?: Array<{ product_name: string; quantity_milli: number; kind: string }>
  }
  assert.ok(detail.consumables, "le bloc est présent pour un propriétaire sur Pro")
  assert.equal(detail.consumables.length, 1)
  assert.equal(detail.consumables[0].quantity_milli, -3000)
  assert.equal(detail.consumables[0].kind, "consumption")
})

test("un lavage sans recette renvoie une liste vide, pas une erreur", async () => {
  const service = await creerPrestation(`Lavage sans recette ${randomUUID().slice(0, 6)}`)
  const lavage = await enregistrerLavage(service)

  const response = await api(`/api/v1/washes/${lavage.id}`, { as: "demo@washpilot.ci" })
  assert.equal(response.status, 200)
  const detail = (await response.json()) as { consumables?: unknown[] }
  assert.deepEqual(detail.consumables, [])
})

test("un caissier ouvre la fiche du lavage mais n'y voit pas le stock", async () => {
  // Le caissier a « wash:read » et aucun droit sur le stock. La fiche doit
  // s'ouvrir — c'est son métier — sans livrer les quantités ni les coûts.
  const produit = await creerProduit(`Omo caissier ${randomUUID().slice(0, 6)}`, 20)
  const service = await creerPrestation(`Lavage caissier ${randomUUID().slice(0, 6)}`)
  await definirRecette(service, produit, 2)
  const lavage = await enregistrerLavage(service)

  const refus = await api("/api/v1/products", { as: "caisse@washpilot.ci" })
  assert.equal(refus.status, 403, "le caissier n'a pas accès au stock")

  const response = await api(`/api/v1/washes/${lavage.id}`, { as: "caisse@washpilot.ci" })
  assert.equal(response.status, 200, "la fiche reste ouverte")
  const detail = (await response.json()) as Record<string, unknown>
  assert.ok(detail.wash, "il voit bien le lavage")
  assert.equal("consumables" in detail, false, "mais pas ce qu'il a consommé")
})

test("sur Starter, la fiche de lavage n'expose pas le stock non plus", async () => {
  // Même refus, pour une raison différente : ce n'est plus le rôle, c'est le
  // forfait. Sans ce contrôle, la fiche de lavage serait une porte dérobée
  // vers un module vendu en Pro.
  const produit = await creerProduit(`Omo forfait ${randomUUID().slice(0, 6)}`, 20)
  const service = await creerPrestation(`Lavage forfait ${randomUUID().slice(0, 6)}`)
  await definirRecette(service, produit, 2)
  const lavage = await enregistrerLavage(service)

  const surPro = await api(`/api/v1/washes/${lavage.id}`, { as: "demo@washpilot.ci" })
  assert.ok("consumables" in ((await surPro.json()) as object), "présent sur Pro")

  await setPlan("starter")
  const surStarter = await api(`/api/v1/washes/${lavage.id}`, { as: "demo@washpilot.ci" })
  assert.equal(surStarter.status, 200, "la fiche reste consultable")
  const detail = (await surStarter.json()) as Record<string, unknown>
  assert.equal("consumables" in detail, false, "le bloc disparaît avec le forfait")
  await setPlan("pro")
})

test("la clé est absente, pas vide : les deux cas ne disent pas la même chose", async () => {
  // Un tableau vide signifie « ce lavage n'a rien consommé ». L'absence de
  // clé signifie « cette information ne vous est pas destinée ». Les
  // confondre ferait afficher « aucun consommable » à un caissier, ce qui
  // serait un mensonge.
  const produit = await creerProduit(`Omo nuance ${randomUUID().slice(0, 6)}`, 20)
  const service = await creerPrestation(`Lavage nuance ${randomUUID().slice(0, 6)}`)
  await definirRecette(service, produit, 1)
  const lavage = await enregistrerLavage(service)

  const vu = (await (await api(`/api/v1/washes/${lavage.id}`, { as: "demo@washpilot.ci" })).json()) as Record<
    string,
    unknown
  >
  const cache = (await (
    await api(`/api/v1/washes/${lavage.id}`, { as: "caisse@washpilot.ci" })
  ).json()) as Record<string, unknown>

  assert.ok(Array.isArray(vu.consumables) && vu.consumables.length === 1)
  assert.equal("consumables" in cache, false)
})
