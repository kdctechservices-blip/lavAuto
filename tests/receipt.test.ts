import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { createSession, hashPassword } from "../server/auth.ts"
import {
  RECEIPT_WIDTH,
  centerLine,
  formatAmount,
  padLine,
  renderReceiptText,
  wrapText,
  type Receipt,
} from "../server/receipt.ts"

// ---------------------------------------------------------------------------
// Le reçu de lavage, 80 mm
//
// Trois choses sont réellement en jeu :
//
//   1. **Les colonnes doivent tomber juste.** Un reçu dont le montant déborde
//      ou se coupe en deux est pire qu'un reçu absent : le client doute du
//      chiffre. C'est vérifiable au caractère près, donc c'est vérifié.
//
//   2. **Un duplicata doit se voir.** Deux papiers indiscernables pour un seul
//      versement permettent de justifier deux fois la même somme.
//
//   3. **Rien ne doit imiter une mention fiscale.** Ce reçu n'est pas un RNE
//      au sens de la DGI ivoirienne, et un document qui en aurait l'air
//      exposerait la station à l'amende qu'elle croit éviter.
// ---------------------------------------------------------------------------

let pool: Pool
let server: Server
let baseUrl: string

const PASSWORD = "WashPilot2026!"
let seq = 0

interface Station {
  organizationId: string
  siteId: string
  ownerToken: string
  washerToken: string
}

let station: Station

async function req(token: string, path: string, options: { method?: string; body?: unknown } = {}) {
  return fetch(`${baseUrl}/api/v1${path}`, {
    method: options.method ?? "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function makeStation(name = "Station Test"): Promise<Station> {
  seq += 1
  const orgQ = await pool.query(
    "INSERT INTO organizations(name, slug, onboarding_completed) VALUES($1,$2,true) RETURNING id",
    [name, `recu-${seq}`],
  )
  const organizationId = orgQ.rows[0].id as string
  await pool.query(
    `INSERT INTO subscriptions(organization_id, plan_id, status, current_period_end)
     VALUES($1,(SELECT id FROM plans WHERE code='pro'),'active', now() + interval '60 days')`,
    [organizationId],
  )
  const siteQ = await pool.query(
    `INSERT INTO sites(organization_id, name, city, address, phone)
     VALUES($1,'Site Riviera','Abidjan','Riviera 3, Boulevard Mitterrand','07 07 07 07 07') RETURNING id`,
    [organizationId],
  )
  const siteId = siteQ.rows[0].id as string

  async function member(role: string, first: string) {
    seq += 1
    const u = await pool.query(
      `INSERT INTO users(email, password_hash, first_name, last_name, status)
       VALUES($1,$2,$3,'Konan','active') RETURNING id`,
      [`recu-${role}-${seq}@exemple.ci`, await hashPassword(PASSWORD), first],
    )
    const userId = u.rows[0].id as string
    await pool.query(
      "INSERT INTO organization_members(organization_id, user_id, role, status) VALUES($1,$2,$3,'active')",
      [organizationId, userId, role],
    )
    return { userId, token: await createSession(pool, userId) }
  }

  const owner = await member("owner", "Yao")
  const washer = await member("washer", "Koffi")
  return { organizationId, siteId, ownerToken: owner.token, washerToken: washer.token }
}

/** Un lavage complet : prestations, laveurs, règlements. */
async function makeWash(
  st: Station,
  options: {
    reference?: string
    items?: Array<[string, number, number]>
    payments?: Array<[string, number]>
    status?: string
  } = {},
) {
  seq += 1
  const items = options.items ?? [["Lavage complet", 1, 250000]]
  const total = items.reduce((sum, [, q, p]) => sum + q * p, 0)
  const ownerQ = await pool.query(
    "SELECT user_id FROM organization_members WHERE organization_id=$1::uuid AND role='owner' LIMIT 1",
    [st.organizationId],
  )
  const createdBy = ownerQ.rows[0].user_id as string

  const washQ = await pool.query(
    `INSERT INTO washes(organization_id, site_id, reference, status, total_cents, payment_status, payment_method, created_by)
     VALUES($1,$2,$3,$4,$5,'pending','cash',$6) RETURNING id`,
    [st.organizationId, st.siteId, options.reference ?? `LAV-20261021-${String(seq).padStart(6, "0")}`, options.status ?? "completed", total, createdBy],
  )
  const washId = washQ.rows[0].id as string

  for (const [name, quantity, unit] of items) {
    await pool.query(
      `INSERT INTO wash_items(wash_id, service_name, quantity, unit_price_cents, line_total_cents)
       VALUES($1,$2,$3,$4,$5)`,
      [washId, name, quantity, unit, quantity * unit],
    )
  }
  for (const [method, amount] of options.payments ?? []) {
    await pool.query(
      `INSERT INTO payments(organization_id, wash_id, method, amount_cents, status)
       VALUES($1,$2,$3,$4,'verified')`,
      [st.organizationId, washId, method, amount],
    )
  }
  return { washId, total }
}

before(async () => {
  assert.ok(await initDatabaseSchema(), "base de test initialisée")
  pool = getPool() as Pool
  const app = createApiApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
  station = await makeStation("Lavage Cocody Riviera")
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// ---------------------------------------------------------------------------
// 1. Les colonnes tombent juste
// ---------------------------------------------------------------------------

test("une ligne montant occupe exactement la largeur du rouleau", () => {
  const line = padLine("Lavage complet", "2 500")
  assert.equal(line.length, RECEIPT_WIDTH)
  assert.ok(line.endsWith("2 500"))
  assert.ok(line.startsWith("Lavage complet"))
})

test("un libellé trop long est tronqué sans jamais pousser le montant hors du papier", () => {
  const long = "Lavage complet avec traitement céramique et rénovation des plastiques"
  const line = padLine(long, "125 000 FCFA")
  assert.equal(line.length, RECEIPT_WIDTH, `largeur ${line.length} au lieu de ${RECEIPT_WIDTH}`)
  assert.ok(line.endsWith("125 000 FCFA"), "le montant a été poussé hors du papier")
  assert.ok(line.includes("…"), "la troncature n'est pas signalée")
})

test("le centrage ne déborde jamais", () => {
  for (const text of ["RECU", "LAVAGE COCODY RIVIERA", "x".repeat(60)]) {
    assert.ok(centerLine(text).length <= RECEIPT_WIDTH)
  }
})

test("le retour à la ligne coupe aux espaces et respecte la largeur", () => {
  const lines = wrapText("Riviera 3, Boulevard Mitterrand, derrière la pharmacie du carrefour")
  for (const line of lines) assert.ok(line.length <= RECEIPT_WIDTH, `ligne trop longue : « ${line} »`)
  assert.equal(lines.join(" "), "Riviera 3, Boulevard Mitterrand, derrière la pharmacie du carrefour")
})

test("les montants sont en francs entiers, sans décimale", () => {
  // Le franc CFA n'a pas de subdivision en circulation : « 2 500,00 » ferait
  // douter du montant au lieu de le préciser.
  assert.equal(formatAmount(250000), "2 500")
  assert.equal(formatAmount(0), "0")
  assert.equal(formatAmount(100), "1")
  assert.equal(formatAmount(123456789), "1 234 568")
  assert.ok(!formatAmount(250000).includes(","))
})

// ---------------------------------------------------------------------------
// 2. Le contenu du reçu
// ---------------------------------------------------------------------------

test("le reçu couvre le lavage entier : toutes les prestations, tous les règlements", async () => {
  const { washId } = await makeWash(station, {
    items: [
      ["Lavage complet", 1, 250000],
      ["Aspiration", 2, 50000],
    ],
    payments: [
      ["cash", 200000],
      ["wave", 150000],
    ],
  })

  const response = await req(station.ownerToken, `/washes/${washId}/receipt`, { method: "POST" })
  assert.equal(response.status, 201)
  const { receipt, text } = (await response.json()) as { receipt: Receipt; text: string }

  assert.equal(receipt.total_cents, 350000)
  assert.equal(receipt.paid_cents, 350000)
  assert.equal(receipt.remaining_cents, 0)
  assert.equal(receipt.items.length, 2)
  assert.equal(receipt.payments.length, 2)

  assert.match(text, /LAVAGE COCODY RIVIERA/)
  assert.match(text, /Lavage complet/)
  assert.match(text, /Aspiration/)
  assert.match(text, /TOTAL/)
  assert.match(text, /3 500 FCFA/)
  assert.match(text, /Espèces/)
  assert.match(text, /Wave/)
  // Chaque ligne du reçu tient sur le rouleau.
  for (const line of text.split("\n")) {
    assert.ok(line.length <= RECEIPT_WIDTH, `ligne de ${line.length} caractères : « ${line} »`)
  }
})

test("un lavage partiellement réglé affiche le solde restant", async () => {
  const { washId } = await makeWash(station, {
    items: [["Lavage complet", 1, 500000]],
    payments: [["cash", 200000]],
  })
  const response = await req(station.ownerToken, `/washes/${washId}/receipt`, { method: "POST" })
  const { receipt, text } = (await response.json()) as { receipt: Receipt; text: string }

  assert.equal(receipt.paid_cents, 200000)
  assert.equal(receipt.remaining_cents, 300000)
  assert.match(text, /RESTE A PAYER\s+3 000 FCFA/)
})

test("un lavage soldé n'affiche pas de ligne de solde restant", async () => {
  const { washId } = await makeWash(station, {
    items: [["Lavage complet", 1, 200000]],
    payments: [["cash", 200000]],
  })
  const response = await req(station.ownerToken, `/washes/${washId}/receipt`, { method: "POST" })
  const { text } = (await response.json()) as { text: string }
  assert.ok(!text.includes("RESTE A PAYER"), "un lavage soldé annonce un reste à payer")
})

test("un paiement remboursé ne compte pas dans ce qui a été payé", async () => {
  const { washId } = await makeWash(station, { items: [["Lavage complet", 1, 300000]] })
  await pool.query(
    `INSERT INTO payments(organization_id, wash_id, method, amount_cents, status)
     VALUES($1,$2,'cash',300000,'refunded')`,
    [station.organizationId, washId],
  )
  const response = await req(station.ownerToken, `/washes/${washId}/receipt`, { method: "POST" })
  const { receipt } = (await response.json()) as { receipt: Receipt }
  assert.equal(receipt.paid_cents, 0)
  assert.equal(receipt.remaining_cents, 300000)
})

// ---------------------------------------------------------------------------
// 3. Les duplicata
// ---------------------------------------------------------------------------

test("la première impression est un original, la seconde un duplicata numéroté", async () => {
  const { washId } = await makeWash(station, { payments: [["cash", 250000]] })

  const first = await req(station.ownerToken, `/washes/${washId}/receipt`, { method: "POST" })
  const one = (await first.json()) as { receipt: Receipt; text: string }
  assert.equal(one.receipt.copy_number, 1)
  assert.equal(one.receipt.duplicate, false)
  assert.ok(!one.text.includes("DUPLICATA"), "l'original porte la mention DUPLICATA")

  const second = await req(station.ownerToken, `/washes/${washId}/receipt`, { method: "POST" })
  const two = (await second.json()) as { receipt: Receipt; text: string }
  assert.equal(two.receipt.copy_number, 2)
  assert.equal(two.receipt.duplicate, true)
  assert.match(two.text, /\*\*\* DUPLICATA \*\*\*/)
  assert.match(two.text, /Copie n2/)
})

test("deux impressions simultanées ne produisent jamais deux fois la copie n°1", async () => {
  const { washId } = await makeWash(station, { payments: [["cash", 250000]] })
  const responses = await Promise.all([
    req(station.ownerToken, `/washes/${washId}/receipt`, { method: "POST" }),
    req(station.ownerToken, `/washes/${washId}/receipt`, { method: "POST" }),
    req(station.ownerToken, `/washes/${washId}/receipt`, { method: "POST" }),
  ])
  const copies: number[] = []
  for (const response of responses) {
    // Le corps ne se lit qu'une fois : le message d'assertion ne doit pas le
    // consommer avant `json()`.
    const payload = (await response.json()) as { receipt?: Receipt }
    assert.equal(response.status, 201, JSON.stringify(payload))
    copies.push(payload.receipt!.copy_number)
  }
  copies.sort()
  assert.deepEqual(copies, [1, 2, 3], `copies attribuées : ${copies.join(", ")}`)
})

test("l'historique dit combien de papiers circulent, et qui les a imprimés", async () => {
  const { washId } = await makeWash(station, { payments: [["cash", 250000]] })
  await req(station.ownerToken, `/washes/${washId}/receipt`, { method: "POST" })
  await req(station.ownerToken, `/washes/${washId}/receipt`, { method: "POST" })

  const response = await req(station.ownerToken, `/washes/${washId}/receipt/history`)
  assert.equal(response.status, 200)
  const { issues } = (await response.json()) as {
    issues: Array<{ copy_number: number; issued_by: string | null }>
  }
  assert.equal(issues.length, 2)
  assert.deepEqual(
    issues.map((i) => i.copy_number),
    [1, 2],
  )
  assert.equal(issues[0].issued_by, "Yao Konan")
})

test("l'original et la réimpression sont deux actions distinctes au journal", async () => {
  const { washId } = await makeWash(station, { payments: [["cash", 250000]] })
  await req(station.ownerToken, `/washes/${washId}/receipt`, { method: "POST" })
  await req(station.ownerToken, `/washes/${washId}/receipt`, { method: "POST" })

  const logs = await pool.query(
    "SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY created_at ASC",
    [washId],
  )
  assert.deepEqual(
    logs.rows.map((r) => r.action),
    ["receipt.issued", "receipt.reprinted"],
  )
})

// ---------------------------------------------------------------------------
// 4. Les refus
// ---------------------------------------------------------------------------

test("un lavage annulé ne donne aucun reçu", async () => {
  const { washId } = await makeWash(station, { status: "cancelled", payments: [["cash", 250000]] })
  const response = await req(station.ownerToken, `/washes/${washId}/receipt`, { method: "POST" })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, "wash_cancelled")

  // Et rien n'a été enregistré : un refus ne consomme pas de numéro de copie.
  const issues = await pool.query("SELECT count(*)::int AS n FROM receipt_issues WHERE wash_id=$1::uuid", [washId])
  assert.equal(issues.rows[0].n, 0)
})

test("un agent de lavage ne peut pas imprimer de reçu", async () => {
  const { washId } = await makeWash(station, { payments: [["cash", 250000]] })
  const response = await req(station.washerToken, `/washes/${washId}/receipt`, { method: "POST" })
  // Il ne voit pas les encaissements : il n'a pas à remettre la preuve de
  // ce qui a été payé.
  assert.equal(response.status, 403)
})

test("le lavage d'une autre station est introuvable, pas interdit", async () => {
  const other = await makeStation("Lavage Yopougon")
  const { washId } = await makeWash(other, { payments: [["cash", 250000]] })
  const response = await req(station.ownerToken, `/washes/${washId}/receipt`, { method: "POST" })
  assert.equal(response.status, 404)
})

// ---------------------------------------------------------------------------
// 5. Aucune mention fiscale
// ---------------------------------------------------------------------------

test("le reçu n'imite aucune mention fiscale", () => {
  // Ce document n'est pas un Reçu Normalisé Électronique : un RNE valide porte
  // un QR code de certification, le visuel officiel FNE et un numéro fiscal
  // délivré par la DGI en temps réel. Aucune de ces marques ne peut être
  // fabriquée ici, et un reçu qui en aurait l'air exposerait la station à
  // l'amende qu'elle croit éviter. Ce test échoue si quelqu'un ajoute une
  // mention qui le ferait passer pour officiel.
  const receipt: Receipt = {
    number: "LAV-20261021-ABC123",
    issued_at: "2026-10-21T14:32:00.000Z",
    copy_number: 1,
    duplicate: false,
    station: { name: "Lavage Cocody", site: "Riviera", city: "Abidjan", address: null, phone: null },
    wash: { reference: "LAV-20261021-ABC123", created_at: "2026-10-21T14:30:00.000Z", vehicle: "Berline", plate: "AA-123-BB", customer: null },
    cashier: "Yao Konan",
    workers: [],
    items: [{ service_name: "Lavage complet", quantity: 1, unit_price_cents: 250000, line_total_cents: 250000 }],
    total_cents: 250000,
    payments: [{ method: "cash", amount_cents: 250000, status: "verified", created_at: "2026-10-21T14:32:00.000Z" }],
    paid_cents: 250000,
    remaining_cents: 0,
  }
  const text = renderReceiptText(receipt).toLowerCase()
  for (const forbidden of ["tva", "fne", "normalis", "dgi", "qr", "facture", "cachet fiscal", "ht)", "ttc"]) {
    assert.ok(!text.includes(forbidden), `le reçu contient « ${forbidden} », ce qui le ferait passer pour un RNE`)
  }
})

test("le mot « reçu » est employé, jamais « facture »", () => {
  // Un reçu constate un paiement, une facture constitue une créance. Les
  // confondre sur le papier remis au client est une erreur de nature.
  const source = renderReceiptText({
    number: "LAV-1",
    issued_at: "2026-10-21T14:32:00.000Z",
    copy_number: 1,
    duplicate: false,
    station: { name: "S", site: "S", city: "Abidjan", address: null, phone: null },
    wash: { reference: "LAV-1", created_at: "2026-10-21T14:30:00.000Z", vehicle: null, plate: null, customer: null },
    cashier: null,
    workers: [],
    items: [],
    total_cents: 0,
    payments: [],
    paid_cents: 0,
    remaining_cents: 0,
  })
  assert.match(source, /RECU/)
})

test("le reçu porte la plaque du véhicule", () => {
  // Le client reconnaît sa voiture à sa plaque, pas à « Berline ». Et comme
  // la station ne tient aucun fichier client, c'est la seule mention qui
  // rattache ce papier à un véhicule précis.
  const receipt: Receipt = {
    number: "LAV-20261021-ABC123",
    issued_at: "2026-10-21T14:32:00.000Z",
    copy_number: 1,
    duplicate: false,
    station: { name: "Lavage Cocody", site: "Riviera", city: "Abidjan", address: null, phone: null },
    wash: {
      reference: "LAV-20261021-ABC123",
      created_at: "2026-10-21T14:30:00.000Z",
      vehicle: "Berline",
      plate: "AA-123-BB",
      customer: null,
    },
    cashier: "Yao Konan",
    workers: ["Fatou Cissé"],
    items: [{ service_name: "Lavage complet", quantity: 1, unit_price_cents: 250000, line_total_cents: 250000 }],
    total_cents: 250000,
    payments: [{ method: "cash", amount_cents: 250000, status: "verified", created_at: "2026-10-21T14:32:00.000Z" }],
    paid_cents: 250000,
    remaining_cents: 0,
  }
  const lines = renderReceiptText(receipt).split("\n")
  const plateLine = lines.find((line) => line.startsWith("Plaque"))
  assert.ok(plateLine, "la plaque ne figure pas sur le reçu")
  assert.match(plateLine, /AA-123-BB$/)
  // Le papier fait 48 colonnes : une mention qui déborde casse l'alignement
  // de toute l'impression, pas seulement de sa propre ligne.
  for (const line of lines) {
    assert.ok(line.length <= 48, `ligne trop large (${line.length}) : ${line}`)
  }
})

test("sans plaque relevée, le reçu n'affiche pas de ligne vide", () => {
  // Une moto de passage peut repartir sans que personne n'ait noté la plaque.
  // Le reçu ne doit pas pour autant porter un intitulé sans valeur.
  const receipt: Receipt = {
    number: "LAV-2",
    issued_at: "2026-10-21T14:32:00.000Z",
    copy_number: 1,
    duplicate: false,
    station: { name: "Lavage Cocody", site: "Riviera", city: "Abidjan", address: null, phone: null },
    wash: {
      reference: "LAV-2",
      created_at: "2026-10-21T14:30:00.000Z",
      vehicle: "Berline",
      plate: null,
      customer: null,
    },
    cashier: null,
    workers: [],
    items: [{ service_name: "Lavage simple", quantity: 1, unit_price_cents: 100000, line_total_cents: 100000 }],
    total_cents: 100000,
    payments: [],
    paid_cents: 0,
    remaining_cents: 100000,
  }
  assert.ok(!renderReceiptText(receipt).includes("Plaque"))
})
