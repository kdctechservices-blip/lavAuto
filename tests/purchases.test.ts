import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { randomUUID } from "node:crypto"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"
import { reversePurchaseEntries } from "../server/purchases.ts"

// ---------------------------------------------------------------------------
// Fournisseurs et achats (lot L5)
//
// Deux règles sont mises à l'épreuve ici, et elles valent toutes les autres.
//
//   1. **Seul ce qui est reçu augmente le stock.** La quantité saisie est
//      celle qu'on a comptée dans le sac.
//   2. **Un achat produit une dépense, et une seule.** L'argent n'est pas
//      ressaisi à côté de la marchandise ; c'est l'achat qui l'écrit. Un
//      index unique en base rend le doublon impossible.
//
// Le reste découle : un achat ne se supprime pas, il s'annule ; l'annulation
// reprend la marchandise et annule la dépense ; la caisse n'est recréditée
// que si la journée est encore ouverte.
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

async function setPlan(code: string) {
  await pool.query(
    `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code=$2),
       status='active', plan_changed_at=now(), updated_at=now() WHERE organization_id=$1::uuid`,
    [orgId, code],
  )
  invalidateSubscriptionCache(orgId)
}

async function creerProduit(nom: string, sachets = 0) {
  const response = await api("/api/v1/products", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: nom, unit: "sachet", unit_cost_cents: 10_000, initial_quantity_milli: sachets * 1000 },
  })
  assert.equal(response.status, 201, `création du produit ${nom}`)
  return String((await response.json()).id)
}

async function stockDe(productId: string): Promise<number> {
  const q = await pool.query(
    "SELECT COALESCE(SUM(quantity_milli),0) AS s FROM stock_movements WHERE organization_id=$1::uuid AND product_id=$2::uuid",
    [orgId, productId],
  )
  return Number(q.rows[0].s)
}

interface Achat {
  id: string
  reference: string
  total_cents: number
  status: string
  expense_id: string | null
}

async function acheter(
  lignes: { product_id: string; sachets: number; prix_unitaire_cents: number }[],
  options: { as?: string; paiement?: string; avecCaisse?: boolean; supplier_id?: string | null } = {},
): Promise<Response> {
  const paiement = options.paiement ?? "cash"
  return api("/api/v1/purchases", {
    as: options.as ?? "demo@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: {
      ...(options.supplier_id !== undefined ? { supplier_id: options.supplier_id } : {}),
      payment_method: paiement,
      ...(paiement === "cash" && options.avecCaisse !== false ? { cash_session_id: cashSessionId } : {}),
      items: lignes.map((l) => ({
        product_id: l.product_id,
        received_milli: l.sachets * 1000,
        unit_cost_cents: l.prix_unitaire_cents,
      })),
    },
  })
}

async function acheterOk(
  lignes: { product_id: string; sachets: number; prix_unitaire_cents: number }[],
  options: Parameters<typeof acheter>[1] = {},
): Promise<Achat> {
  const response = await acheter(lignes, options)
  assert.equal(response.status, 201, "enregistrement de l'achat")
  return (await response.json()) as Achat
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

  await setPlan("pro")
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

// ---------------------------------------------------------------------------
// La marchandise
// ---------------------------------------------------------------------------

test("la quantité reçue, et elle seule, fait monter le stock", async () => {
  const produit = await creerProduit(`Omo achat ${randomUUID().slice(0, 6)}`)
  assert.equal(await stockDe(produit), 0, "le produit part de zéro")

  await acheterOk([{ product_id: produit, sachets: 20, prix_unitaire_cents: 15_000 }])

  assert.equal(await stockDe(produit), 20_000, "20 sachets sont entrés")
})

test("le total de l'achat est calculé, pas déclaré par l'appelant", async () => {
  const produit = await creerProduit(`Bidon ${randomUUID().slice(0, 6)}`)
  // 20 sachets à 150 F : le serveur doit trouver 3 000 F sans qu'on les lui
  // donne. Un total envoyé par le client serait une invitation à mentir.
  const achat = await acheterOk([{ product_id: produit, sachets: 20, prix_unitaire_cents: 15_000 }])
  assert.equal(achat.total_cents, 300_000, "20 × 150 F = 3 000 F")
})

test("le coût payé ce jour-là est figé sur le mouvement d'entrée", async () => {
  const produit = await creerProduit(`Chiffon ${randomUUID().slice(0, 6)}`)
  await acheterOk([{ product_id: produit, sachets: 5, prix_unitaire_cents: 20_000 }])
  await acheterOk([{ product_id: produit, sachets: 5, prix_unitaire_cents: 35_000 }])

  const q = await pool.query(
    "SELECT unit_cost_cents FROM stock_movements WHERE product_id=$1::uuid AND kind='entry' ORDER BY created_at",
    [produit],
  )
  assert.deepEqual(
    q.rows.map((r) => Number(r.unit_cost_cents)),
    [20_000, 35_000],
    "le deuxième achat ne réécrit pas le prix du premier",
  )
})

test("l'entrée de stock dit de quel achat elle vient, par sa référence", async () => {
  const produit = await creerProduit(`Savon ${randomUUID().slice(0, 6)}`)
  const achat = await acheterOk([{ product_id: produit, sachets: 3, prix_unitaire_cents: 10_000 }])

  const response = await api("/api/v1/stock-movements", { as: "demo@washpilot.ci" })
  const mouvements = (await response.json()) as {
    product_id: string
    kind: string
    purchase_id: string | null
    purchase_reference: string | null
  }[]
  const entree = mouvements.find((m) => m.product_id === produit && m.kind === "entry")
  assert.ok(entree, "l'entrée existe")
  assert.equal(entree.purchase_id, achat.id)
  assert.equal(entree.purchase_reference, achat.reference, "la référence est jointe, pas à recharger ligne par ligne")
  assert.match(achat.reference, /^ACH-\d{8}-[A-Z0-9]{6}$/)
})

test("un mouvement saisi à la main ne se rattache à aucun achat", async () => {
  const produit = await creerProduit(`Manuel ${randomUUID().slice(0, 6)}`, 10)
  const response = await api("/api/v1/stock-movements", { as: "demo@washpilot.ci", query: "" } as never)
  const mouvements = (await response.json()) as { product_id: string; purchase_id: string | null }[]
  const initial = mouvements.find((m) => m.product_id === produit)
  assert.ok(initial)
  assert.equal(initial.purchase_id, null, "le stock initial n'est pas un achat")
})

// ---------------------------------------------------------------------------
// L'argent — le piège du double comptage
// ---------------------------------------------------------------------------

test("un achat écrit une dépense, et exactement une", async () => {
  const produit = await creerProduit(`Omo dépense ${randomUUID().slice(0, 6)}`)
  const achat = await acheterOk([{ product_id: produit, sachets: 10, prix_unitaire_cents: 15_000 }])

  const q = await pool.query("SELECT id, amount_cents, category, status FROM expenses WHERE purchase_id=$1::uuid", [
    achat.id,
  ])
  assert.equal(q.rowCount, 1, "une dépense, pas zéro, pas deux")
  assert.equal(Number(q.rows[0].amount_cents), achat.total_cents, "le montant est celui de l'achat")
  assert.equal(q.rows[0].category, "supply")
  assert.equal(achat.expense_id, String(q.rows[0].id), "l'achat renvoie la dépense qu'il a créée")
})

test("la base refuse qu'un achat porte deux dépenses", async () => {
  // Le non-doublon n'est pas une politesse applicative : il est verrouillé par
  // un index unique. Même une écriture directe, en contournant l'API, échoue.
  const produit = await creerProduit(`Verrou ${randomUUID().slice(0, 6)}`)
  const achat = await acheterOk([{ product_id: produit, sachets: 1, prix_unitaire_cents: 10_000 }])

  await assert.rejects(
    pool.query(
      `INSERT INTO expenses(organization_id, site_id, category, amount_cents, payment_method, purchase_id)
       VALUES($1::uuid,$2::uuid,'supply',1000,'cash',$3::uuid)`,
      [orgId, siteId, achat.id],
    ),
    "une seconde dépense sur le même achat doit être rejetée par la base",
  )
})

test("un achat en espèces sort l'argent du tiroir", async () => {
  const produit = await creerProduit(`Espèces ${randomUUID().slice(0, 6)}`)
  const achat = await acheterOk([{ product_id: produit, sachets: 4, prix_unitaire_cents: 25_000 }])

  const q = await pool.query(
    `SELECT cm.type, cm.amount_cents FROM cash_movements cm
     JOIN expenses e ON e.id = cm.expense_id WHERE e.purchase_id=$1::uuid`,
    [achat.id],
  )
  assert.equal(q.rowCount, 1)
  assert.equal(q.rows[0].type, "exit")
  assert.equal(Number(q.rows[0].amount_cents), 100_000, "4 × 250 F sont sortis de la caisse")
})

test("un achat en espèces sans caisse ouverte est refusé", async () => {
  const produit = await creerProduit(`Sans caisse ${randomUUID().slice(0, 6)}`)
  const response = await acheter([{ product_id: produit, sachets: 2, prix_unitaire_cents: 10_000 }], {
    avecCaisse: false,
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, "cash_session_required")
  assert.equal(await stockDe(produit), 0, "rien n'est entré en stock : la transaction entière a été annulée")
})

test("un achat en mobile money n'exige aucune caisse et ne touche pas au tiroir", async () => {
  const produit = await creerProduit(`Wave ${randomUUID().slice(0, 6)}`)
  const achat = await acheterOk([{ product_id: produit, sachets: 6, prix_unitaire_cents: 10_000 }], {
    paiement: "wave",
  })
  assert.equal(await stockDe(produit), 6_000)

  const q = await pool.query(
    `SELECT 1 FROM cash_movements cm JOIN expenses e ON e.id = cm.expense_id WHERE e.purchase_id=$1::uuid`,
    [achat.id],
  )
  assert.equal(q.rowCount, 0, "le mobile money ne passe pas par le tiroir")
})

// ---------------------------------------------------------------------------
// L'annulation
// ---------------------------------------------------------------------------

test("annuler un achat reprend la marchandise et annule la dépense", async () => {
  const produit = await creerProduit(`Erreur ${randomUUID().slice(0, 6)}`)
  const achat = await acheterOk([{ product_id: produit, sachets: 20, prix_unitaire_cents: 15_000 }])
  assert.equal(await stockDe(produit), 20_000)

  const response = await api(`/api/v1/purchases/${achat.id}/cancel`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Saisi deux fois par erreur" },
  })
  assert.equal(response.status, 200)

  assert.equal(await stockDe(produit), 0, "la marchandise est reprise")
  const depense = await pool.query("SELECT status FROM expenses WHERE purchase_id=$1::uuid", [achat.id])
  assert.equal(depense.rows[0].status, "cancelled", "la dépense ne compte plus")

  // Rien n'a été effacé : l'entrée d'origine reste lisible à côté de sa
  // contrepassation. C'est la différence entre corriger et réécrire.
  const trace = await pool.query(
    "SELECT kind FROM stock_movements WHERE purchase_id=$1::uuid ORDER BY created_at",
    [achat.id],
  )
  assert.deepEqual(
    trace.rows.map((r) => r.kind),
    ["entry", "reversal"],
  )
})

test("annuler deux fois ne reprend pas la marchandise deux fois", async () => {
  const produit = await creerProduit(`Double annul ${randomUUID().slice(0, 6)}`)
  const achat = await acheterOk([{ product_id: produit, sachets: 8, prix_unitaire_cents: 10_000 }])

  const premiere = await api(`/api/v1/purchases/${achat.id}/cancel`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Première annulation" },
  })
  assert.equal(premiere.status, 200)

  const seconde = await api(`/api/v1/purchases/${achat.id}/cancel`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Deuxième annulation" },
  })
  assert.equal(seconde.status, 409)
  assert.equal((await seconde.json()).error.code, "purchase_already_cancelled")
  assert.equal(await stockDe(produit), 0, "le stock n'est pas descendu en dessous de zéro")
})

test("annuler un achat réglé en espèces remet l'argent dans la caisse encore ouverte", async () => {
  const produit = await creerProduit(`Remboursé ${randomUUID().slice(0, 6)}`)
  const achat = await acheterOk([{ product_id: produit, sachets: 2, prix_unitaire_cents: 50_000 }])

  const response = await api(`/api/v1/purchases/${achat.id}/cancel`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Marchandise rendue au vendeur" },
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).cash_refunded, true)

  const q = await pool.query(
    `SELECT amount_cents FROM cash_movements
     WHERE cash_session_id=$1::uuid AND type='entry' AND source='adjustment' AND description LIKE $2`,
    [cashSessionId, `%${achat.reference}%`],
  )
  assert.equal(q.rowCount, 1)
  assert.equal(Number(q.rows[0].amount_cents), 100_000, "les 1 000 F sont revenus")
})

test("le stock peut passer en négatif après annulation sans jamais bloquer", async () => {
  // Les sachets ont été consommés entre l'achat et son annulation. Le négatif
  // est un signal qui appelle un inventaire, pas une erreur à refuser : la
  // correction d'une saisie fautive ne doit jamais être empêchée.
  const produit = await creerProduit(`Déjà utilisé ${randomUUID().slice(0, 6)}`)
  const achat = await acheterOk([{ product_id: produit, sachets: 10, prix_unitaire_cents: 10_000 }])

  const sortie = await api("/api/v1/stock-movements", {
    as: "demo@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: { product_id: produit, kind: "exit", quantity_milli: 10_000, reason: "Tout utilisé" },
  })
  assert.equal(sortie.status, 201)

  const response = await api(`/api/v1/purchases/${achat.id}/cancel`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Achat jamais livré en réalité" },
  })
  assert.equal(response.status, 200, "l'annulation reste possible")
  assert.equal(await stockDe(produit), -10_000, "le stock vire au rouge, et c'est le bon comportement")
})

// ---------------------------------------------------------------------------
// Les portes : rôle, forfait, cloisonnement
// ---------------------------------------------------------------------------

test("le caissier ne peut ni acheter ni voir les achats", async () => {
  const produit = await creerProduit(`Interdit ${randomUUID().slice(0, 6)}`)

  const ecriture = await acheter([{ product_id: produit, sachets: 1, prix_unitaire_cents: 10_000 }], {
    as: "caisse@washpilot.ci",
  })
  assert.equal(ecriture.status, 403)

  const lecture = await api("/api/v1/purchases", { as: "caisse@washpilot.ci" })
  assert.equal(lecture.status, 403, "le prix d'achat des produits ne regarde pas la caisse")
})

test("le gérant, lui, achète : c'est lui qui va au marché", async () => {
  const produit = await creerProduit(`Gérant ${randomUUID().slice(0, 6)}`)
  const response = await acheter([{ product_id: produit, sachets: 3, prix_unitaire_cents: 10_000 }], {
    as: "gerant@washpilot.ci",
    paiement: "orange_money",
  })
  assert.equal(response.status, 201)
})

test("sur Starter, les achats et les fournisseurs sont fermés", async () => {
  const produit = await creerProduit(`Starter ${randomUUID().slice(0, 6)}`)
  await setPlan("starter")
  try {
    for (const chemin of ["/api/v1/purchases", "/api/v1/suppliers"]) {
      const response = await api(chemin, { as: "demo@washpilot.ci" })
      assert.equal(response.status, 402, `${chemin} doit demander une montée en forfait`)
      assert.equal((await response.json()).error.code, "plan_upgrade_required")
    }
    const ecriture = await acheter([{ product_id: produit, sachets: 1, prix_unitaire_cents: 10_000 }])
    assert.equal(ecriture.status, 402)
  } finally {
    await setPlan("pro")
  }
})

test("le rôle prime sur le forfait : le caissier reste en 403, jamais en 402", async () => {
  await setPlan("starter")
  try {
    const response = await api("/api/v1/purchases", { as: "caisse@washpilot.ci" })
    assert.equal(response.status, 403, "on ne propose pas un abonnement à qui n'aura pas le droit ensuite")
  } finally {
    await setPlan("pro")
  }
})

test("un fournisseur d'une autre station est introuvable", async () => {
  const autreOrg = (
    await pool.query("INSERT INTO organizations(name, slug) VALUES('Voisin L5',$1) RETURNING id", [
      `voisin-l5-${randomUUID().slice(0, 8)}`,
    ])
  ).rows[0].id
  const autreFournisseur = (
    await pool.query("INSERT INTO suppliers(organization_id, name) VALUES($1::uuid,'Grossiste voisin') RETURNING id", [
      autreOrg,
    ])
  ).rows[0].id

  const produit = await creerProduit(`Cloison ${randomUUID().slice(0, 6)}`)
  const response = await acheter([{ product_id: produit, sachets: 1, prix_unitaire_cents: 10_000 }], {
    supplier_id: String(autreFournisseur),
  })
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, "supplier_not_found")
  assert.equal(await stockDe(produit), 0, "aucune entrée n'a été écrite")
})

// ---------------------------------------------------------------------------
// Les refus de saisie
// ---------------------------------------------------------------------------

test("un produit archivé ne peut pas être approvisionné", async () => {
  const produit = await creerProduit(`Archivé ${randomUUID().slice(0, 6)}`)
  const archive = await api(`/api/v1/products/${produit}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { is_active: false },
  })
  assert.equal(archive.status, 200)

  const response = await acheter([{ product_id: produit, sachets: 1, prix_unitaire_cents: 10_000 }])
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, "product_archived")
})

test("le même produit deux fois dans un achat est refusé, pas cumulé en silence", async () => {
  const produit = await creerProduit(`Doublon ${randomUUID().slice(0, 6)}`)
  const response = await acheter([
    { product_id: produit, sachets: 2, prix_unitaire_cents: 10_000 },
    { product_id: produit, sachets: 3, prix_unitaire_cents: 10_000 },
  ])
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, "duplicate_product")
})

test("deux fournisseurs ne peuvent pas porter le même nom", async () => {
  const nom = `Grossiste Adjamé ${randomUUID().slice(0, 6)}`
  const premier = await api("/api/v1/suppliers", { as: "demo@washpilot.ci", method: "POST", body: { name: nom } })
  assert.equal(premier.status, 201)

  const second = await api("/api/v1/suppliers", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: nom.toUpperCase() },
  })
  assert.equal(second.status, 409, "la casse ne doit pas suffire à créer un doublon")
})

test("un achat sans fournisseur nommé reste possible", async () => {
  // On n'oblige pas à créer une fiche fournisseur pour trois sachets pris à
  // la boutique du coin. Ne pas avoir enregistré le vendeur ne doit jamais
  // empêcher d'enregistrer la dépense et la marchandise.
  const produit = await creerProduit(`Boutique ${randomUUID().slice(0, 6)}`)
  const achat = await acheterOk([{ product_id: produit, sachets: 3, prix_unitaire_cents: 10_000 }], {
    supplier_id: null,
  })
  assert.equal(achat.status, "received")
  assert.equal(await stockDe(produit), 3_000)
})

test("la fiche d'un achat montre le détail reçu, nom du produit figé", async () => {
  const nom = `Figé ${randomUUID().slice(0, 6)}`
  const produit = await creerProduit(nom)
  const achat = await acheterOk([{ product_id: produit, sachets: 7, prix_unitaire_cents: 12_000 }])

  await pool.query("UPDATE products SET name='Renommé après coup' WHERE id=$1::uuid", [produit])

  const response = await api(`/api/v1/purchases/${achat.id}`, { as: "demo@washpilot.ci" })
  assert.equal(response.status, 200)
  const detail = (await response.json()) as {
    purchase: { reference: string; total_cents: number }
    items: { product_name_snapshot: string; received_milli: number; unit_cost_cents: number }[]
  }
  assert.equal(detail.items.length, 1)
  assert.equal(detail.items[0].product_name_snapshot, nom, "le nom du jour de l'achat est conservé")
  assert.equal(detail.items[0].received_milli, 7_000)
  assert.equal(detail.purchase.total_cents, 84_000)
})

test("la contrepassation ne rend jamais la marchandise deux fois, même appelée deux fois", async () => {
  // Le garde `NOT EXISTS` de la contrepassation est inatteignable par
  // l'API : la route refuse d'abord un achat déjà annulé, en 409. Un test
  // passant par HTTP ne prouverait donc rien de ce garde — il mesurerait le
  // statut. On appelle la fonction directement pour l'éprouver vraiment.
  const produit = await creerProduit(`Garde ${randomUUID().slice(0, 6)}`)
  const achat = await acheterOk([{ product_id: produit, sachets: 9, prix_unitaire_cents: 10_000 }])

  const client = await pool.connect()
  try {
    await reversePurchaseEntries(client, orgId, achat.id, null)
    const apresUne = await stockDe(produit)
    assert.equal(apresUne, 0, "la première reprise ramène à zéro")

    await reversePurchaseEntries(client, orgId, achat.id, null)
    assert.equal(await stockDe(produit), 0, "la seconde ne retire rien de plus")
  } finally {
    client.release()
  }
})

// ---------------------------------------------------------------------------
// Le verrou qui rend la garantie réelle
//
// Écrire une seule dépense ne suffirait pas si cette dépense restait
// modifiable à la main : on pourrait en changer le montant, et l'argent ne
// correspondrait plus à la marchandise sans que rien ne le signale.
// ---------------------------------------------------------------------------

test("la dépense d'un achat ne se modifie pas depuis l'écran des dépenses", async () => {
  const produit = await creerProduit(`Intouchable ${randomUUID().slice(0, 6)}`)
  const achat = await acheterOk([{ product_id: produit, sachets: 5, prix_unitaire_cents: 10_000 }], {
    paiement: "wave",
  })
  assert.ok(achat.expense_id)

  const response = await api(`/api/v1/expenses/${achat.expense_id}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { amount_cents: 1_000 },
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, "expense_from_purchase")

  const q = await pool.query("SELECT amount_cents FROM expenses WHERE id=$1::uuid", [achat.expense_id])
  assert.equal(Number(q.rows[0].amount_cents), achat.total_cents, "le montant n'a pas bougé")
})

test("la dépense d'un achat ne se supprime pas non plus", async () => {
  const produit = await creerProduit(`Non supprimable ${randomUUID().slice(0, 6)}`)
  const achat = await acheterOk([{ product_id: produit, sachets: 5, prix_unitaire_cents: 10_000 }], {
    paiement: "wave",
  })

  const response = await api(`/api/v1/expenses/${achat.expense_id}`, { as: "demo@washpilot.ci", method: "DELETE" })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, "expense_from_purchase")

  // Supprimer la dépense aurait fait disparaître l'argent tout en laissant la
  // marchandise en stock : l'achat aurait été gratuit.
  const q = await pool.query("SELECT 1 FROM expenses WHERE purchase_id=$1::uuid", [achat.id])
  assert.equal(q.rowCount, 1)
})

test("l'écran des dépenses sait dire qu'une ligne vient d'un achat", async () => {
  const produit = await creerProduit(`Traçable ${randomUUID().slice(0, 6)}`)
  const achat = await acheterOk([{ product_id: produit, sachets: 2, prix_unitaire_cents: 10_000 }], {
    paiement: "wave",
  })

  const response = await api("/api/v1/expenses", { as: "demo@washpilot.ci" })
  const depenses = (await response.json()) as { id: string; purchase_id: string | null }[]
  const ligne = depenses.find((d) => d.id === achat.expense_id)
  assert.ok(ligne, "la dépense figure bien dans la liste")
  assert.equal(ligne.purchase_id, achat.id, "sans ce lien, l'utilisateur la croirait ressaisissable")
})
