import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { randomUUID } from "node:crypto"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"

// ---------------------------------------------------------------------------
// Stock (lot L3)
//
// La promesse centrale de ce module tient en une phrase : **le stock n'est
// jamais écrit, il est toujours la somme des mouvements**. Ces tests
// l'éprouvent par tous les angles où elle pourrait céder — y compris en
// vérifiant qu'aucune colonne de quantité n'existe dans le schéma.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool

const PASSWORD = "WashPilot2026!"
const sessions = new Map<string, string>()
let orgId: string
let foreignProductId: string

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

/** Crée un produit et renvoie son identifiant. */
async function creerProduit(nom: string, extra: Record<string, unknown> = {}) {
  const response = await api("/api/v1/products", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: nom, unit: "litre", unit_cost_cents: 120_000, ...extra },
  })
  assert.equal(response.status, 201, `création du produit ${nom}`)
  return (await response.json()) as Record<string, unknown>
}

/** Stock courant lu depuis la liste des produits. */
async function stockDe(productId: string): Promise<number> {
  const response = await api("/api/v1/products", { as: "demo@washpilot.ci" })
  const rows = (await response.json()) as Array<Record<string, unknown>>
  const produit = rows.find((p) => p.id === productId)
  assert.ok(produit, "produit présent dans la liste")
  return Number(produit.stock_milli)
}

async function mouvement(
  productId: string,
  kind: "entry" | "exit",
  quantityMilli: number,
  options: { as?: string; idempotencyKey?: string } = {},
) {
  return api("/api/v1/stock-movements", {
    as: options.as ?? "demo@washpilot.ci",
    method: "POST",
    idempotencyKey: options.idempotencyKey ?? randomUUID(),
    body: { product_id: productId, kind, quantity_milli: quantityMilli },
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

  for (const email of [
    "demo@washpilot.ci",
    "gerant@washpilot.ci",
    "caisse@washpilot.ci",
    "laveur@washpilot.ci",
  ]) {
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

  // Un produit appartenant à une autre organisation, pour tester le cloisonnement.
  const autre = await pool.query("INSERT INTO organizations(name) VALUES('Lavage voisin') RETURNING id")
  const produitVoisin = await pool.query(
    `INSERT INTO products(organization_id, name, unit, unit_cost_cents)
     VALUES($1::uuid,'Shampooing du voisin','litre',100000) RETURNING id`,
    [autre.rows[0].id],
  )
  foreignProductId = produitVoisin.rows[0].id
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// --- La règle structurelle -------------------------------------------------

test("le schéma ne contient aucune colonne de quantité sur les produits", async () => {
  // C'est la garantie la plus forte du module : on ne peut pas écrire un stock
  // parce qu'il n'y a nulle part où l'écrire.
  const q = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name='products' AND column_name LIKE '%quantity%'`,
  )
  assert.equal(q.rowCount, 0, "aucune colonne de quantité ne doit exister sur products")
})

test("le stock affiché est exactement la somme des mouvements", async () => {
  const produit = await creerProduit("Shampooing carrosserie", { initial_quantity_milli: 10_000 })
  const id = String(produit.id)

  await mouvement(id, "entry", 5_000)
  await mouvement(id, "exit", 2_000)
  await mouvement(id, "exit", 1_500)

  const somme = await pool.query(
    "SELECT COALESCE(SUM(quantity_milli),0)::int AS total FROM stock_movements WHERE product_id=$1::uuid",
    [id],
  )
  const affiche = await stockDe(id)
  assert.equal(affiche, Number(somme.rows[0].total))
  assert.equal(affiche, 10_000 + 5_000 - 2_000 - 1_500)
})

test("le stock initial est enregistré comme un mouvement, pas comme une valeur", async () => {
  const produit = await creerProduit("Cire de finition", { initial_quantity_milli: 4_000 })
  const q = await pool.query(
    "SELECT kind, quantity_milli FROM stock_movements WHERE product_id=$1::uuid",
    [produit.id],
  )
  assert.equal(q.rowCount, 1)
  assert.equal(q.rows[0].kind, "initial")
  assert.equal(q.rows[0].quantity_milli, 4_000)
})

test("modifier la fiche produit ne peut pas modifier le stock", async () => {
  const produit = await creerProduit("Microfibre", { initial_quantity_milli: 3_000 })
  const id = String(produit.id)

  // Tentative d'injection d'une quantité par la route de modification.
  const response = await api(`/api/v1/products/${id}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { name: "Microfibre premium", stock_milli: 999_999, quantity_milli: 999_999 },
  })
  assert.equal(response.status, 200)
  assert.equal(await stockDe(id), 3_000, "le stock n'a pas bougé")
})

// --- Sorties et garde-fous -------------------------------------------------

test("on ne peut pas sortir plus que le stock disponible", async () => {
  const produit = await creerProduit("Dégraissant jantes", { initial_quantity_milli: 2_000 })
  const response = await mouvement(String(produit.id), "exit", 2_500)
  assert.equal(response.status, 409)
  const erreur = await response.json()
  assert.equal(erreur.error.code, "insufficient_stock")
  assert.match(erreur.error.message, /inventaire/i, "le message oriente vers la solution")
})

test("sortir exactement le stock restant est permis", async () => {
  const produit = await creerProduit("Lustrant plastique", { initial_quantity_milli: 2_000 })
  const response = await mouvement(String(produit.id), "exit", 2_000)
  assert.equal(response.status, 201)
  assert.equal(await stockDe(String(produit.id)), 0)
})

test("un produit archivé ne peut plus être mouvementé", async () => {
  const produit = await creerProduit("Produit retiré", { initial_quantity_milli: 1_000 })
  await api(`/api/v1/products/${produit.id}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { is_active: false },
  })
  const response = await mouvement(String(produit.id), "entry", 500)
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, "product_archived")
})

// --- Inventaire ------------------------------------------------------------

test("l'inventaire enregistre l'écart constaté, pas le stock compté", async () => {
  const produit = await creerProduit("Shampooing sol", { initial_quantity_milli: 10_000 })
  const id = String(produit.id)

  const response = await api(`/api/v1/products/${id}/inventory`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { counted_milli: 8_500, reason: "Comptage mensuel" },
  })
  assert.equal(response.status, 201)
  const corps = await response.json()
  assert.equal(corps.delta_milli, -1_500, "l'écart est la différence, pas le compté")
  assert.equal(corps.movement.quantity_milli, -1_500)
  assert.equal(corps.movement.kind, "inventory")
  assert.equal(await stockDe(id), 8_500, "le stock reflète désormais le comptage")
})

test("un inventaire conforme n'écrit aucun mouvement", async () => {
  const produit = await creerProduit("Éponge", { initial_quantity_milli: 5_000 })
  const id = String(produit.id)
  const avant = await pool.query("SELECT COUNT(*)::int AS n FROM stock_movements WHERE product_id=$1::uuid", [id])

  const response = await api(`/api/v1/products/${id}/inventory`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { counted_milli: 5_000 },
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).delta_milli, 0)

  const apres = await pool.query("SELECT COUNT(*)::int AS n FROM stock_movements WHERE product_id=$1::uuid", [id])
  assert.equal(apres.rows[0].n, avant.rows[0].n, "aucun mouvement nul créé")
})

test("l'inventaire est la façon de reconnaître un stock inférieur au théorique", async () => {
  // Le scénario que refuse `insufficient_stock` doit avoir une issue.
  const produit = await creerProduit("Produit mal suivi", { initial_quantity_milli: 1_000 })
  const id = String(produit.id)
  assert.equal((await mouvement(id, "exit", 3_000)).status, 409)

  const inventaire = await api(`/api/v1/products/${id}/inventory`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { counted_milli: 0, reason: "Bidon vide retrouvé" },
  })
  assert.equal(inventaire.status, 201)
  assert.equal(await stockDe(id), 0)
})

// --- Contrepassation -------------------------------------------------------

test("annuler un mouvement le contrepasse sans le supprimer", async () => {
  const produit = await creerProduit("Produit à corriger", { initial_quantity_milli: 1_000 })
  const id = String(produit.id)
  const creation = await mouvement(id, "entry", 5_000)
  const mouvementId = (await creation.json()).id

  const response = await api(`/api/v1/stock-movements/${mouvementId}/reverse`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Erreur de saisie : bidon jamais reçu" },
  })
  assert.equal(response.status, 201)

  const original = await pool.query("SELECT quantity_milli FROM stock_movements WHERE id=$1::uuid", [mouvementId])
  assert.equal(original.rowCount, 1, "l'original est toujours en base")
  assert.equal(original.rows[0].quantity_milli, 5_000, "l'original est intact")
  assert.equal(await stockDe(id), 1_000, "le stock est revenu à son état d'avant")
})

test("un mouvement ne peut être contrepassé qu'une seule fois", async () => {
  const produit = await creerProduit("Produit double annulation", { initial_quantity_milli: 1_000 })
  const creation = await mouvement(String(produit.id), "entry", 2_000)
  const mouvementId = (await creation.json()).id

  const premiere = await api(`/api/v1/stock-movements/${mouvementId}/reverse`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Première annulation" },
  })
  assert.equal(premiere.status, 201)

  const seconde = await api(`/api/v1/stock-movements/${mouvementId}/reverse`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Seconde tentative" },
  })
  assert.equal(seconde.status, 409)
  assert.equal((await seconde.json()).error.code, "already_reversed")
})

test("une contrepassation ne peut pas être contrepassée", async () => {
  const produit = await creerProduit("Produit annulation en chaîne", { initial_quantity_milli: 1_000 })
  const creation = await mouvement(String(produit.id), "entry", 2_000)
  const premiere = await api(`/api/v1/stock-movements/${(await creation.json()).id}/reverse`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Annulation" },
  })
  const contrepassationId = (await premiere.json()).id

  const response = await api(`/api/v1/stock-movements/${contrepassationId}/reverse`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Annulation de l'annulation" },
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, "already_reversal")
})

test("annuler une entrée déjà consommée est refusé plutôt que de rendre le stock négatif", async () => {
  const produit = await creerProduit("Produit consommé", { initial_quantity_milli: 0 })
  const id = String(produit.id)
  const entree = await mouvement(id, "entry", 5_000)
  const entreeId = (await entree.json()).id
  await mouvement(id, "exit", 4_000)

  const response = await api(`/api/v1/stock-movements/${entreeId}/reverse`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Tentative tardive" },
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, "insufficient_stock")
})

test("une annulation exige un motif", async () => {
  const produit = await creerProduit("Produit sans motif", { initial_quantity_milli: 1_000 })
  const creation = await mouvement(String(produit.id), "entry", 1_000)
  const response = await api(`/api/v1/stock-movements/${(await creation.json()).id}/reverse`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "" },
  })
  assert.equal(response.status, 400)
})

// --- Instantané du coût ----------------------------------------------------

test("changer le coût d'un produit ne réécrit pas la valeur des mouvements passés", async () => {
  const produit = await creerProduit("Produit qui renchérit", { initial_quantity_milli: 1_000 })
  const id = String(produit.id)
  const avant = await mouvement(id, "exit", 500)
  const coutAvant = (await avant.json()).unit_cost_cents
  assert.equal(coutAvant, 120_000)

  await api(`/api/v1/products/${id}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { unit_cost_cents: 200_000 },
  })

  const relu = await pool.query("SELECT unit_cost_cents FROM stock_movements WHERE kind='exit' AND product_id=$1::uuid", [id])
  assert.equal(relu.rows[0].unit_cost_cents, 120_000, "le mouvement passé garde son coût d'origine")

  const apres = await mouvement(id, "exit", 100)
  assert.equal((await apres.json()).unit_cost_cents, 200_000, "le nouveau mouvement prend le nouveau coût")
})

// --- Seuil d'alerte --------------------------------------------------------

test("le seuil d'alerte signale un produit à réapprovisionner", async () => {
  const produit = await creerProduit("Produit sous seuil", {
    initial_quantity_milli: 1_000,
    low_stock_threshold_milli: 2_000,
  })
  const response = await api("/api/v1/products", { as: "demo@washpilot.ci" })
  const rows = (await response.json()) as Array<Record<string, unknown>>
  const ligne = rows.find((p) => p.id === produit.id)
  assert.equal(ligne?.low_stock, true)
})

test("un produit sans seuil ne déclenche jamais d'alerte", async () => {
  const produit = await creerProduit("Produit sans seuil défini", { initial_quantity_milli: 0 })
  const response = await api("/api/v1/products", { as: "demo@washpilot.ci" })
  const rows = (await response.json()) as Array<Record<string, unknown>>
  const ligne = rows.find((p) => p.id === produit.id)
  assert.equal(ligne?.low_stock, false, "un stock nul sans seuil n'est pas une alerte")
})

// --- Idempotence -----------------------------------------------------------

test("rejouer un mouvement avec la même clé n'écrit qu'une fois", async () => {
  const produit = await creerProduit("Produit idempotent", { initial_quantity_milli: 10_000 })
  const id = String(produit.id)
  const cle = randomUUID()

  const premiere = await mouvement(id, "exit", 1_000, { idempotencyKey: cle })
  const seconde = await mouvement(id, "exit", 1_000, { idempotencyKey: cle })
  assert.equal(premiere.status, 201)
  assert.equal(seconde.status, 201)
  assert.equal((await premiere.json()).id, (await seconde.json()).id, "même mouvement renvoyé")
  assert.equal(await stockDe(id), 9_000, "une seule sortie appliquée")
})

// --- Cloisonnement ---------------------------------------------------------

test("le produit d'une autre organisation est introuvable", async () => {
  const response = await api("/api/v1/products", { as: "demo@washpilot.ci" })
  const rows = (await response.json()) as Array<Record<string, unknown>>
  assert.equal(rows.some((p) => p.id === foreignProductId), false)
})

test("on ne peut pas mouvementer le produit d'une autre organisation", async () => {
  const response = await mouvement(foreignProductId, "entry", 1_000)
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, "product_not_found")
})

test("on ne peut pas inventorier le produit d'une autre organisation", async () => {
  const response = await api(`/api/v1/products/${foreignProductId}/inventory`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { counted_milli: 0 },
  })
  assert.equal(response.status, 404)
})

// --- Permissions -----------------------------------------------------------

test("l'agent de lavage n'a aucun accès au stock", async () => {
  for (const chemin of ["/api/v1/products", "/api/v1/stock-movements", "/api/v1/product-categories"]) {
    const response = await api(chemin, { as: "laveur@washpilot.ci" })
    assert.equal(response.status, 403, `${chemin} doit être refusé au laveur`)
  }
})

test("le caissier n'a pas le stock par défaut", async () => {
  const response = await api("/api/v1/products", { as: "caisse@washpilot.ci" })
  assert.equal(response.status, 403)
})

test("le gérant peut consulter et mouvementer le stock", async () => {
  const lecture = await api("/api/v1/products", { as: "gerant@washpilot.ci" })
  assert.equal(lecture.status, 200)

  const produit = await creerProduit("Produit du gérant", { initial_quantity_milli: 5_000 })
  const ecriture = await mouvement(String(produit.id), "exit", 1_000, { as: "gerant@washpilot.ci" })
  assert.equal(ecriture.status, 201, "le gérant enregistre lui-même, sans passer par son caissier")
})

test("une sortie enregistrée par le gérant porte bien son nom dans l'historique", async () => {
  const produit = await creerProduit("Produit traçabilité", { initial_quantity_milli: 5_000 })
  const response = await mouvement(String(produit.id), "exit", 1_000, { as: "gerant@washpilot.ci" })
  const mouvementId = (await response.json()).id

  const q = await pool.query(
    `SELECT u.email FROM stock_movements m JOIN users u ON u.id = m.created_by WHERE m.id=$1::uuid`,
    [mouvementId],
  )
  assert.equal(q.rows[0].email, "gerant@washpilot.ci")
})

// --- Catégories ------------------------------------------------------------

test("deux catégories ne peuvent pas porter le même nom", async () => {
  const premiere = await api("/api/v1/product-categories", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: "Produits chimiques" },
  })
  assert.equal(premiere.status, 201)

  const seconde = await api("/api/v1/product-categories", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: "produits chimiques" },
  })
  assert.equal(seconde.status, 409, "la comparaison ignore la casse")
})

test("un produit ne peut pas être rattaché à la catégorie d'une autre organisation", async () => {
  const autre = await pool.query("SELECT id FROM organizations WHERE name='Lavage voisin'")
  const categorieVoisine = await pool.query(
    "INSERT INTO product_categories(organization_id, name) VALUES($1::uuid,'Catégorie voisine') RETURNING id",
    [autre.rows[0].id],
  )
  const response = await api("/api/v1/products", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: "Produit mal rattaché", category_id: categorieVoisine.rows[0].id },
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, "invalid_category")
})

// --- Traçabilité -----------------------------------------------------------

test("chaque mouvement laisse une trace dans l'historique", async () => {
  const produit = await creerProduit("Produit audité", { initial_quantity_milli: 2_000 })
  const response = await mouvement(String(produit.id), "exit", 500)
  const mouvementId = (await response.json()).id

  const q = await pool.query(
    "SELECT action, entity_type FROM audit_logs WHERE entity_id=$1 AND organization_id=$2::uuid",
    [mouvementId, orgId],
  )
  assert.equal(q.rowCount, 1)
  assert.equal(q.rows[0].action, "stock.moved")
  assert.equal(q.rows[0].entity_type, "stock_movement")
})

test("l'historique d'un produit se lit dans l'ordre antichronologique", async () => {
  const produit = await creerProduit("Produit historique", { initial_quantity_milli: 1_000 })
  const id = String(produit.id)
  await mouvement(id, "entry", 1_000)
  await mouvement(id, "exit", 500)

  const response = await api(`/api/v1/stock-movements?product_id=${id}`, { as: "demo@washpilot.ci" })
  assert.equal(response.status, 200)
  const rows = (await response.json()) as Array<Record<string, unknown>>
  assert.equal(rows.length, 3)
  assert.equal(rows[0].kind, "exit", "le plus récent en premier")
  assert.equal(rows[2].kind, "initial")
})
