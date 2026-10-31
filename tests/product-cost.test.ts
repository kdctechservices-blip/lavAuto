import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { randomUUID } from "node:crypto"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"

// ---------------------------------------------------------------------------
// Coût de référence d'un produit
//
// Jusqu'ici, acheter un produit ne touchait pas à sa fiche. Le gérant saisissait
// « 300 F le sachet » le premier jour, puis le prix montait à 350 au marché, et
// la fiche affichait toujours 300. Chaque lavage valorisait sa consommation à
// 300 : la marge affichée était fausse, et toujours dans le sens flatteur.
//
// La règle posée : **le dernier prix payé devient le coût de référence.**
// Pas une moyenne pondérée — le stock peut être négatif dans ce produit (une
// rupture n'a jamais le droit de bloquer un lavage) et une moyenne pondérée
// par une quantité négative ne veut plus rien dire. C'est aussi le chiffre que
// le gérant reconnaît : il a payé 350, sa fiche doit afficher 350.
//
// Deux garde-fous qui comptent autant que la règle :
//   - un prix nul n'écrase rien (un échantillon gratuit ne rend pas le produit
//     gratuit, ce qui rendrait toutes les marges parfaites) ;
//   - l'historique n'est jamais réécrit : les mouvements déjà enregistrés
//     gardent le coût qui était vrai ce jour-là.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool
let orgId: string
let siteId: string
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

async function creerProduit(nom: string, coutCents: number, sachets = 0) {
  const response = await api("/api/v1/products", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: nom, unit: "sachet", unit_cost_cents: coutCents, initial_quantity_milli: sachets * 1000 },
  })
  assert.equal(response.status, 201, `création du produit ${nom}`)
  return String((await response.json()).id)
}

async function acheter(lignes: { product_id: string; sachets: number; prix_unitaire_cents: number }[]) {
  return api("/api/v1/purchases", {
    as: "demo@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: {
      payment_method: "cash",
      cash_session_id: cashSessionId,
      items: lignes.map((l) => ({
        product_id: l.product_id,
        received_milli: l.sachets * 1000,
        unit_cost_cents: l.prix_unitaire_cents,
      })),
    },
  })
}

async function ficheProduit(productId: string): Promise<{ cout: number; realigneLe: string | null }> {
  const q = await pool.query(
    "SELECT unit_cost_cents, unit_cost_updated_at FROM products WHERE id=$1::uuid AND organization_id=$2::uuid",
    [productId, orgId],
  )
  assert.equal(q.rowCount, 1, "produit retrouvé")
  return {
    cout: Number(q.rows[0].unit_cost_cents),
    realigneLe: q.rows[0].unit_cost_updated_at ? String(q.rows[0].unit_cost_updated_at) : null,
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

  await login("demo@washpilot.ci")

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

  await api("/api/v1/cash-sessions/open", {
    as: "demo@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: { site_id: siteId, opening_amount_cents: 0 },
  })
  const session = await api("/api/v1/cash-sessions/current", { as: "demo@washpilot.ci" })
  cashSessionId = String((await session.json()).id)
  assert.ok(cashSessionId, "session de caisse ouverte")
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

test("le prix payé au marché devient le coût de référence du produit", async () => {
  const omo = await creerProduit(`Omo ${randomUUID().slice(0, 8)}`, 30_000, 10)
  assert.equal((await ficheProduit(omo)).cout, 30_000, "coût saisi au départ")

  const response = await acheter([{ product_id: omo, sachets: 10, prix_unitaire_cents: 35_000 }])
  assert.equal(response.status, 201, "achat enregistré")

  const fiche = await ficheProduit(omo)
  assert.equal(fiche.cout, 35_000, "la fiche suit le prix réellement payé")
  assert.ok(fiche.realigneLe, "la date de réalignement est posée")
})

test("un prix inchangé ne produit ni écriture ni fausse date", async () => {
  const produit = await creerProduit(`Chiffons ${randomUUID().slice(0, 8)}`, 20_000, 5)
  const response = await acheter([{ product_id: produit, sachets: 5, prix_unitaire_cents: 20_000 }])
  assert.equal(response.status, 201)

  const fiche = await ficheProduit(produit)
  assert.equal(fiche.cout, 20_000)
  assert.equal(fiche.realigneLe, null, "rien n'a changé : aucune date de réalignement")
})

test("un produit reçu gratuitement ne rend pas toutes les marges parfaites", async () => {
  // Le piège : un échantillon à 0 F écraserait le coût de référence, et chaque
  // lavage consommerait ensuite un produit « gratuit ».
  const produit = await creerProduit(`Échantillon ${randomUUID().slice(0, 8)}`, 25_000, 0)
  const response = await acheter([{ product_id: produit, sachets: 3, prix_unitaire_cents: 0 }])
  assert.equal(response.status, 201, "l'achat gratuit reste enregistrable")

  const fiche = await ficheProduit(produit)
  assert.equal(fiche.cout, 25_000, "le coût de référence tient bon")
  assert.equal(fiche.realigneLe, null)
})

test("le réalignement est tracé, avec l'ancien prix et l'achat qui l'a causé", async () => {
  const produit = await creerProduit(`Savon ${randomUUID().slice(0, 8)}`, 10_000, 2)
  const response = await acheter([{ product_id: produit, sachets: 4, prix_unitaire_cents: 12_500 }])
  assert.equal(response.status, 201)
  const achat = await response.json()

  const journal = await pool.query(
    `SELECT metadata FROM audit_logs
     WHERE organization_id=$1::uuid AND action='product.cost_changed' AND entity_id=$2::text`,
    [orgId, produit],
  )
  assert.equal(journal.rowCount, 1, "une seule entrée au journal")
  const meta = journal.rows[0].metadata as Record<string, unknown>
  assert.equal(Number(meta.from_cents), 10_000, "l'ancien prix est conservé")
  assert.equal(Number(meta.to_cents), 12_500)
  assert.equal(String(meta.purchase_reference), String(achat.reference), "on sait quel achat l'a causé")
})

test("l'historique garde le coût qui était vrai le jour du mouvement", async () => {
  const produit = await creerProduit(`Cire ${randomUUID().slice(0, 8)}`, 8_000, 0)

  const premier = await acheter([{ product_id: produit, sachets: 5, prix_unitaire_cents: 8_000 }])
  assert.equal(premier.status, 201)
  const second = await acheter([{ product_id: produit, sachets: 5, prix_unitaire_cents: 15_000 }])
  assert.equal(second.status, 201)

  assert.equal((await ficheProduit(produit)).cout, 15_000, "la fiche affiche le dernier prix")

  const mouvements = await pool.query(
    `SELECT unit_cost_cents FROM stock_movements
     WHERE organization_id=$1::uuid AND product_id=$2::uuid AND kind='entry'
     ORDER BY created_at`,
    [orgId, produit],
  )
  const couts = mouvements.rows.map((r) => Number(r.unit_cost_cents))
  assert.deepEqual(couts, [8_000, 15_000], "chaque entrée garde son propre prix, non réécrit")
})

test("corriger le coût à la main efface la mention « prix payé »", async () => {
  const produit = await creerProduit(`Brosse ${randomUUID().slice(0, 8)}`, 5_000, 0)
  await acheter([{ product_id: produit, sachets: 2, prix_unitaire_cents: 7_000 }])
  assert.ok((await ficheProduit(produit)).realigneLe, "l'achat a posé la date")

  const patch = await api(`/api/v1/products/${produit}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { unit_cost_cents: 9_000 },
  })
  assert.equal(patch.status, 200, "correction manuelle acceptée")

  const fiche = await ficheProduit(produit)
  assert.equal(fiche.cout, 9_000)
  assert.equal(fiche.realigneLe, null, "l'écran ne doit plus annoncer un prix payé")
})

test("une correction qui ne change pas le montant ne perd pas la date", async () => {
  const produit = await creerProduit(`Éponge ${randomUUID().slice(0, 8)}`, 4_000, 0)
  await acheter([{ product_id: produit, sachets: 2, prix_unitaire_cents: 6_000 }])
  const avant = await ficheProduit(produit)
  assert.ok(avant.realigneLe)

  const patch = await api(`/api/v1/products/${produit}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { name: `Éponge renommée ${randomUUID().slice(0, 6)}` },
  })
  assert.equal(patch.status, 200)

  const apres = await ficheProduit(produit)
  assert.equal(apres.cout, 6_000)
  assert.equal(apres.realigneLe, avant.realigneLe, "renommer ne touche pas à l'origine du prix")
})

test("plusieurs produits dans un même achat sont réalignés chacun de leur côté", async () => {
  const a = await creerProduit(`Produit A ${randomUUID().slice(0, 8)}`, 1_000, 0)
  const b = await creerProduit(`Produit B ${randomUUID().slice(0, 8)}`, 2_000, 0)

  const response = await acheter([
    { product_id: a, sachets: 1, prix_unitaire_cents: 1_500 },
    { product_id: b, sachets: 1, prix_unitaire_cents: 2_000 },
  ])
  assert.equal(response.status, 201)

  assert.equal((await ficheProduit(a)).cout, 1_500, "A suit son propre prix")
  assert.equal((await ficheProduit(b)).cout, 2_000, "B n'a pas bougé : même prix qu'avant")
  assert.equal((await ficheProduit(b)).realigneLe, null, "et n'a donc pas de date de réalignement")
})

test("le coût de référence est bien celui que le lavage utilise pour sa consommation", async () => {
  // C'est le bout de la chaîne : si ce test tombe, la marge est fausse.
  const produit = await creerProduit(`Shampooing ${randomUUID().slice(0, 8)}`, 10_000, 50)

  const serviceQ = await pool.query(
    "SELECT id FROM services WHERE organization_id=$1::uuid AND is_active LIMIT 1",
    [orgId],
  )
  assert.equal(serviceQ.rowCount, 1, "une prestation existe")
  const serviceId = String(serviceQ.rows[0].id)

  const recette = await api(`/api/v1/services/${serviceId}/consumables`, {
    as: "demo@washpilot.ci",
    method: "PUT",
    body: { items: [{ product_id: produit, quantity_milli: 1000 }] },
  })
  assert.ok([200, 201].includes(recette.status), `recette enregistrée (${recette.status})`)

  await acheter([{ product_id: produit, sachets: 10, prix_unitaire_cents: 17_000 }])
  assert.equal((await ficheProduit(produit)).cout, 17_000)

  const categorieQ = await pool.query(
    "SELECT id FROM vehicle_categories WHERE organization_id=$1::uuid LIMIT 1",
    [orgId],
  )
  const lavage = await api("/api/v1/washes", {
    as: "demo@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: {
      site_id: siteId,
      vehicle_category_id: String(categorieQ.rows[0].id),
      items: [{ service_id: serviceId, quantity: 1 }],
      worker_ids: [],
      payment_method: "orange_money",
      amount_received_cents: 0,
    },
  })
  assert.equal(lavage.status, 201, "lavage enregistré")
  const washId = String((await lavage.json()).id)

  const consommation = await pool.query(
    `SELECT unit_cost_cents FROM stock_movements
     WHERE organization_id=$1::uuid AND wash_id=$2::uuid AND kind='consumption'`,
    [orgId, washId],
  )
  assert.equal(consommation.rowCount, 1, "une consommation enregistrée")
  assert.equal(
    Number(consommation.rows[0].unit_cost_cents),
    17_000,
    "le lavage valorise sa consommation au prix réellement payé, pas au prix d'origine",
  )
})
