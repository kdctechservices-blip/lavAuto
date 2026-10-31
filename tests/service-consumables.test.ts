import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { randomUUID } from "node:crypto"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"
import { reverseWashConsumption } from "../server/stock.ts"

// ---------------------------------------------------------------------------
// Consommables par prestation (lot L4)
//
// La règle du lot, dictée par l'usage réel en station : déclarer qu'un lavage
// consomme deux sachets d'Omo ne change **rien** au prix facturé. Cela ne
// touche que le niveau de stock.
//
// Et une seconde règle, qui prime sur la justesse du stock : **enregistrer un
// lavage n'est jamais bloqué**. Un lavage rendu est de l'argent qui rentre.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool

const PASSWORD = "WashPilot2026!"
const sessions = new Map<string, string>()
let orgId: string
let siteId: string
let vehicleCategoryId: string

async function api(
  path: string,
  options: { as?: string; method?: string; body?: unknown; idempotencyKey?: string } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (options.as) {
    const cookie = sessions.get(options.as)
    if (cookie) headers.Cookie = cookie
  }
  if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey
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

/** Produit compté en sachets, comme en station. */
async function creerProduit(nom: string, stockSachets: number) {
  const response = await api("/api/v1/products", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: {
      name: nom,
      unit: "sachet",
      unit_cost_cents: 10_000,
      initial_quantity_milli: stockSachets * 1000,
    },
  })
  assert.equal(response.status, 201, `création du produit ${nom}`)
  return String((await response.json()).id)
}

async function creerPrestation(nom: string, prixCents: number) {
  const response = await api("/api/v1/services", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: nom, duration_minutes: 30, vehicle_pricing: [{ vehicle_category_id: vehicleCategoryId, price_cents: prixCents }] },
  })
  assert.equal(response.status, 201, `création de la prestation ${nom}`)
  return String((await response.json()).id)
}

/** Déclare la recette d'une prestation : quantités exprimées en sachets. */
async function definirRecette(serviceId: string, items: { product_id: string; sachets: number }[]) {
  const response = await api(`/api/v1/services/${serviceId}/consumables`, {
    as: "demo@washpilot.ci",
    method: "PUT",
    body: { items: items.map((i) => ({ product_id: i.product_id, quantity_milli: i.sachets * 1000 })) },
  })
  assert.equal(response.status, 200, "enregistrement de la recette")
  return response
}

async function enregistrerLavage(
  items: { service_id: string; quantity: number }[],
  options: { as?: string } = {},
) {
  return api("/api/v1/washes", {
    as: options.as ?? "demo@washpilot.ci",
    method: "POST",
    idempotencyKey: randomUUID(),
    body: {
      site_id: siteId,
      vehicle_category_id: vehicleCategoryId,
      items,
      payment_method: "cash",
      amount_received_cents: 0,
    },
  })
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
  await pool.query(
    `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code='pro'),
       status='active', plan_changed_at=now(), updated_at=now() WHERE organization_id=$1::uuid`,
    [orgId],
  )
  invalidateSubscriptionCache(orgId)

  siteId = (await pool.query("SELECT id FROM sites WHERE organization_id=$1::uuid LIMIT 1", [orgId])).rows[0].id
  vehicleCategoryId = (
    await pool.query("SELECT id FROM vehicle_categories WHERE organization_id=$1::uuid LIMIT 1", [orgId])
  ).rows[0].id
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// --- Le prix ne bouge pas ---------------------------------------------------

test("déclarer des consommables ne change pas le prix de la prestation", async () => {
  const produit = await creerProduit("Omo prix", 50)
  const service = await creerPrestation("Lavage prix inchangé", 500_000)

  const avant = await pool.query("SELECT price_cents FROM services WHERE id=$1::uuid", [service])
  await definirRecette(service, [{ product_id: produit, sachets: 2 }])
  const apres = await pool.query("SELECT price_cents FROM services WHERE id=$1::uuid", [service])

  assert.equal(apres.rows[0].price_cents, avant.rows[0].price_cents)
  assert.equal(apres.rows[0].price_cents, 500_000)
})

test("le total d'un lavage reste le prix de la prestation, consommables ou non", async () => {
  const produit = await creerProduit("Omo total", 50)
  const service = await creerPrestation("Lavage total", 300_000)
  await definirRecette(service, [{ product_id: produit, sachets: 3 }])

  const response = await enregistrerLavage([{ service_id: service, quantity: 1 }])
  assert.equal(response.status, 201)
  assert.equal((await response.json()).total_cents, 300_000, "le coût des sachets n'entre pas dans le total")
})

// --- La déduction -----------------------------------------------------------

test("enregistrer un lavage sort les sachets du stock", async () => {
  const produit = await creerProduit("Omo déduction", 50)
  const service = await creerPrestation("Lavage déduction", 200_000)
  await definirRecette(service, [{ product_id: produit, sachets: 2 }])

  assert.equal(await stockDe(produit), 50_000)
  const response = await enregistrerLavage([{ service_id: service, quantity: 1 }])
  assert.equal(response.status, 201)
  assert.equal(await stockDe(produit), 48_000, "2 sachets sortis")
})

test("la quantité de prestations multiplie la consommation", async () => {
  const produit = await creerProduit("Omo multiple", 50)
  const service = await creerPrestation("Lavage multiple", 200_000)
  await definirRecette(service, [{ product_id: produit, sachets: 2 }])

  await enregistrerLavage([{ service_id: service, quantity: 3 }])
  assert.equal(await stockDe(produit), 44_000, "3 lavages × 2 sachets = 6 sachets")
})

test("une prestation sans recette ne consomme rien", async () => {
  const produit = await creerProduit("Omo intact", 50)
  const service = await creerPrestation("Lavage sans recette", 200_000)

  await enregistrerLavage([{ service_id: service, quantity: 1 }])
  assert.equal(await stockDe(produit), 50_000)
})

test("un produit utilisé par deux prestations du même lavage donne un seul mouvement cumulé", async () => {
  const produit = await creerProduit("Omo partagé", 50)
  const lavage = await creerPrestation("Lavage extérieur partagé", 200_000)
  const interieur = await creerPrestation("Nettoyage intérieur partagé", 150_000)
  await definirRecette(lavage, [{ product_id: produit, sachets: 2 }])
  await definirRecette(interieur, [{ product_id: produit, sachets: 1 }])

  const response = await enregistrerLavage([
    { service_id: lavage, quantity: 1 },
    { service_id: interieur, quantity: 1 },
  ])
  assert.equal(response.status, 201)
  const washId = (await response.json()).id

  const mouvements = await pool.query(
    "SELECT quantity_milli FROM stock_movements WHERE wash_id=$1::uuid AND product_id=$2::uuid",
    [washId, produit],
  )
  assert.equal(mouvements.rowCount, 1, "une seule ligne, pas une par prestation")
  assert.equal(mouvements.rows[0].quantity_milli, -3_000)
})

// --- Jamais bloquant --------------------------------------------------------

test("un stock à zéro n'empêche pas d'enregistrer un lavage", async () => {
  const produit = await creerProduit("Omo épuisé", 0)
  const service = await creerPrestation("Lavage sur stock vide", 200_000)
  await definirRecette(service, [{ product_id: produit, sachets: 2 }])

  const response = await enregistrerLavage([{ service_id: service, quantity: 1 }])
  assert.equal(response.status, 201, "le client est encaissé quoi qu'il arrive")
  assert.equal(await stockDe(produit), -2_000, "le stock passe en négatif et le signale")
})

test("une sortie manuelle reste refusée là où la consommation automatique passe", async () => {
  // La différence est volontaire : l'auteur d'une sortie manuelle peut
  // corriger sa saisie, celui qui encaisse un lavage ne le peut pas.
  const produit = await creerProduit("Omo comparaison", 1)
  const service = await creerPrestation("Lavage comparaison", 200_000)
  await definirRecette(service, [{ product_id: produit, sachets: 5 }])

  const manuelle = await api("/api/v1/stock-movements", {
    as: "demo@washpilot.ci",
    method: "POST",
    idempotencyKey: randomUUID(),
    body: { product_id: produit, kind: "exit", quantity_milli: 5_000 },
  })
  assert.equal(manuelle.status, 409)

  const lavage = await enregistrerLavage([{ service_id: service, quantity: 1 }])
  assert.equal(lavage.status, 201)
  assert.equal(await stockDe(produit), -4_000)
})

// --- Annulation -------------------------------------------------------------

test("annuler un lavage rend les sachets au stock", async () => {
  const produit = await creerProduit("Omo annulation", 50)
  const service = await creerPrestation("Lavage annulable", 200_000)
  await definirRecette(service, [{ product_id: produit, sachets: 4 }])

  const creation = await enregistrerLavage([{ service_id: service, quantity: 1 }])
  const washId = (await creation.json()).id
  assert.equal(await stockDe(produit), 46_000)

  const annulation = await api(`/api/v1/washes/${washId}/cancel`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Client reparti sans le lavage" },
  })
  assert.equal(annulation.status, 200)
  assert.equal(await stockDe(produit), 50_000, "le stock est revenu à son niveau d'avant")
})

test("l'annulation contrepasse sans effacer le mouvement d'origine", async () => {
  const produit = await creerProduit("Omo trace", 50)
  const service = await creerPrestation("Lavage traçable", 200_000)
  await definirRecette(service, [{ product_id: produit, sachets: 2 }])

  const creation = await enregistrerLavage([{ service_id: service, quantity: 1 }])
  const washId = (await creation.json()).id
  await api(`/api/v1/washes/${washId}/cancel`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Erreur de saisie" },
  })

  const mouvements = await pool.query(
    "SELECT kind, quantity_milli FROM stock_movements WHERE wash_id=$1::uuid ORDER BY created_at",
    [washId],
  )
  assert.equal(mouvements.rowCount, 2, "la consommation et sa contrepassation")
  assert.equal(mouvements.rows[0].kind, "consumption")
  assert.equal(mouvements.rows[0].quantity_milli, -2_000)
  assert.equal(mouvements.rows[1].kind, "reversal")
  assert.equal(mouvements.rows[1].quantity_milli, 2_000)
})

test("annuler deux fois ne rend pas les sachets deux fois", async () => {
  const produit = await creerProduit("Omo double annulation", 50)
  const service = await creerPrestation("Lavage double annulation", 200_000)
  await definirRecette(service, [{ product_id: produit, sachets: 3 }])

  const creation = await enregistrerLavage([{ service_id: service, quantity: 1 }])
  const washId = (await creation.json()).id
  await api(`/api/v1/washes/${washId}/cancel`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Première annulation" },
  })
  await api(`/api/v1/washes/${washId}/cancel`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Seconde tentative" },
  })

  assert.equal(await stockDe(produit), 50_000, "le stock n'a pas été crédité deux fois")
})

test("la contrepassation est idempotente même appelée directement deux fois", async () => {
  // La route d'annulation refuse déjà un lavage annulé : ce garde-fou-là
  // protège donc le cas où il ne serait pas atteint. Il doit être éprouvé
  // séparément, sinon on croit tester une défense alors qu'on en teste une
  // autre — c'est ce qu'a révélé une mutation survivante.
  const produit = await creerProduit("Omo idempotence directe", 50)
  const service = await creerPrestation("Lavage idempotence directe", 200_000)
  await definirRecette(service, [{ product_id: produit, sachets: 3 }])

  const creation = await enregistrerLavage([{ service_id: service, quantity: 1 }])
  const washId = String((await creation.json()).id)
  assert.equal(await stockDe(produit), 47_000)

  await reverseWashConsumption(pool, orgId, washId, null)
  assert.equal(await stockDe(produit), 50_000, "première contrepassation")

  await reverseWashConsumption(pool, orgId, washId, null)
  assert.equal(await stockDe(produit), 50_000, "la seconde ne crédite pas à nouveau")
})

// --- La recette -------------------------------------------------------------

test("enregistrer une recette remplace la précédente", async () => {
  const omo = await creerProduit("Omo remplacé", 50)
  const cire = await creerProduit("Cire remplacée", 50)
  const service = await creerPrestation("Lavage recette évolutive", 200_000)

  await definirRecette(service, [{ product_id: omo, sachets: 2 }])
  const seconde = await definirRecette(service, [{ product_id: cire, sachets: 1 }])
  const recette = (await seconde.json()) as Array<Record<string, unknown>>

  assert.equal(recette.length, 1)
  assert.equal(recette[0].product_id, cire, "l'ancien produit a disparu de la recette")
})

test("une recette vide est acceptée et supprime la consommation", async () => {
  const produit = await creerProduit("Omo retiré", 50)
  const service = await creerPrestation("Lavage recette vidée", 200_000)
  await definirRecette(service, [{ product_id: produit, sachets: 2 }])
  await definirRecette(service, [])

  await enregistrerLavage([{ service_id: service, quantity: 1 }])
  assert.equal(await stockDe(produit), 50_000)
})

test("un même produit ne peut pas figurer deux fois dans une recette", async () => {
  const produit = await creerProduit("Omo doublon", 50)
  const service = await creerPrestation("Lavage doublon", 200_000)

  const response = await api(`/api/v1/services/${service}/consumables`, {
    as: "demo@washpilot.ci",
    method: "PUT",
    body: {
      items: [
        { product_id: produit, quantity_milli: 1000 },
        { product_id: produit, quantity_milli: 2000 },
      ],
    },
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, "duplicate_product")
})

test("une recette ne peut pas référencer le produit d'une autre station", async () => {
  const autre = await pool.query("INSERT INTO organizations(name) VALUES('Station voisine L4') RETURNING id")
  const produitVoisin = await pool.query(
    "INSERT INTO products(organization_id, name, unit) VALUES($1::uuid,'Omo du voisin','sachet') RETURNING id",
    [autre.rows[0].id],
  )
  const service = await creerPrestation("Lavage cloisonné", 200_000)

  const response = await api(`/api/v1/services/${service}/consumables`, {
    as: "demo@washpilot.ci",
    method: "PUT",
    body: { items: [{ product_id: produitVoisin.rows[0].id, quantity_milli: 1000 }] },
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, "invalid_product")
})

// --- Permissions ------------------------------------------------------------

test("un caissier déclenche la déduction sans détenir aucun droit sur le stock", async () => {
  // C'est le système qui mouvemente le stock, pas le caissier : lui n'a fait
  // qu'enregistrer un lavage.
  const produit = await creerProduit("Omo caissier", 50)
  const service = await creerPrestation("Lavage par le caissier", 200_000)
  await definirRecette(service, [{ product_id: produit, sachets: 2 }])

  const refus = await api("/api/v1/products", { as: "caisse@washpilot.ci" })
  assert.equal(refus.status, 403, "le caissier n'a toujours pas accès au stock")

  const lavage = await enregistrerLavage([{ service_id: service, quantity: 1 }], { as: "caisse@washpilot.ci" })
  assert.equal(lavage.status, 201)
  assert.equal(await stockDe(produit), 48_000, "la déduction a bien eu lieu")
})

test("définir une recette relève du catalogue, pas du stock", async () => {
  const produit = await creerProduit("Omo catalogue", 50)
  const service = await creerPrestation("Lavage catalogue", 200_000)

  // Le gérant détient `service:read` mais pas `service:manage`.
  const response = await api(`/api/v1/services/${service}/consumables`, {
    as: "gerant@washpilot.ci",
    method: "PUT",
    body: { items: [{ product_id: produit, quantity_milli: 1000 }] },
  })
  assert.equal(response.status, 403)

  const lecture = await api(`/api/v1/services/${service}/consumables`, { as: "gerant@washpilot.ci" })
  assert.equal(lecture.status, 200, "il peut en revanche la consulter")
})

// --- Traçabilité ------------------------------------------------------------

test("le mouvement de consommation désigne le lavage qui l'a provoqué", async () => {
  const produit = await creerProduit("Omo rattaché", 50)
  const service = await creerPrestation("Lavage rattaché", 200_000)
  await definirRecette(service, [{ product_id: produit, sachets: 2 }])

  const creation = await enregistrerLavage([{ service_id: service, quantity: 1 }])
  const washId = (await creation.json()).id

  const q = await pool.query(
    "SELECT kind, wash_id, reason FROM stock_movements WHERE product_id=$1::uuid AND kind='consumption'",
    [produit],
  )
  assert.equal(q.rows[0].wash_id, washId)
  assert.match(String(q.rows[0].reason), /automatique/i)
})

test("un produit archivé n'est plus consommé", async () => {
  const produit = await creerProduit("Omo archivé", 50)
  const service = await creerPrestation("Lavage produit archivé", 200_000)
  await definirRecette(service, [{ product_id: produit, sachets: 2 }])

  await api(`/api/v1/products/${produit}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { is_active: false },
  })

  const response = await enregistrerLavage([{ service_id: service, quantity: 1 }])
  assert.equal(response.status, 201, "le lavage passe quand même")
  assert.equal(await stockDe(produit), 50_000, "mais rien n'est déduit d'un produit retiré du stock")
})
