import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { hashPassword } from "../server/auth.ts"
import {
  SYSCOHADA_ACCOUNTS,
  deferredRevenue,
  detailedCsv,
  journalCsv,
  listRevenue,
  monthlyRevenue,
  spreadOverMonths,
  type RevenueRow,
} from "../server/revenue.ts"
import { purgeOrganization } from "../server/organization-deletion.ts"

// ---------------------------------------------------------------------------
// Revenus de l'éditeur
//
// Deux familles de risques, très différentes :
//
//   - le **calcul** peut être faux sans que rien ne plante : un étalement
//     décalé d'une quinzaine, un centime perdu par ligne, un journal
//     déséquilibré. Testé sur les fonctions pures, au centime près ;
//   - le **registre** peut être incomplet : une activation qui n'y écrit
//     pas, un montant repris du tarif courant au lieu de celui payé, une
//     écriture emportée par la suppression du client. Testé de bout en bout.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool

const OPERATOR_EMAIL = "ops-revenu@washpilot.ci"
const OPERATOR_PASSWORD = "ConsoleSecret2026!"
let operatorCookie = ""

async function console_(path: string, options: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (operatorCookie) headers.Cookie = operatorCookie
  return fetch(`${baseUrl}/api/v1/console${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function createStation(suffix: string): Promise<string> {
  const org = await pool.query(
    "INSERT INTO organizations(name, slug, onboarding_completed) VALUES($1,$2,true) RETURNING id",
    [`Station Revenu ${suffix}`, `revenu-${suffix}`],
  )
  const orgId = org.rows[0].id as string
  const user = await pool.query(
    `INSERT INTO users(email, password_hash, first_name, last_name, status)
     VALUES($1,$2,'Koffi','Yao','active') RETURNING id`,
    [`revenu-${suffix}@exemple.ci`, await hashPassword("WashPilot2026!")],
  )
  await pool.query(
    "INSERT INTO organization_members(organization_id, user_id, role, status) VALUES($1,$2,'owner','active')",
    [orgId, user.rows[0].id],
  )
  await pool.query(
    `INSERT INTO subscriptions(organization_id, plan_id, status, current_period_end)
     VALUES($1,(SELECT id FROM plans WHERE code='starter'),'trialing', now() + interval '14 days')`,
    [orgId],
  )
  return orgId
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

  await pool.query(
    `INSERT INTO platform_operators(email, password_hash, full_name, status)
     VALUES($1,$2,'Operateur revenu','active')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'`,
    [OPERATOR_EMAIL, await hashPassword(OPERATOR_PASSWORD)],
  )
  const login = await fetch(`${baseUrl}/api/v1/console/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD }),
  })
  assert.equal(login.status, 200)
  operatorCookie = login.headers.getSetCookie?.().join("; ") ?? login.headers.get("set-cookie") ?? ""
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// ---------------------------------------------------------------------------
// 1. L'étalement, au centime près
// ---------------------------------------------------------------------------

test("un mois civil entier tombe dans un seul seau", () => {
  const spread = spreadOverMonths(
    1_000_000,
    new Date("2026-03-01T00:00:00Z"),
    new Date("2026-04-01T00:00:00Z"),
  )
  assert.deepEqual([...spread.entries()], [["2026-03", 1_000_000]])
})

test("une période du 15 au 15 se répartit sur les deux mois, au prorata des jours", () => {
  // 15 mars → 15 avril : 17 jours en mars (15→31 inclus au sens des bornes),
  // 14 jours en avril. Un découpage « par mois entier » mettrait tout en
  // mars et décalerait la courbe d'une quinzaine.
  const spread = spreadOverMonths(
    3_100_000,
    new Date("2026-03-15T00:00:00Z"),
    new Date("2026-04-15T00:00:00Z"),
  )
  assert.deepEqual([...spread.keys()], ["2026-03", "2026-04"])
  const mars = spread.get("2026-03")!
  const avril = spread.get("2026-04")!
  assert.ok(mars > avril, "mars porte plus de jours qu'avril")
  assert.equal(mars + avril, 3_100_000, "rien ne se perd")
})

test("la somme des parts égale toujours le montant, sur toute une plage", () => {
  // Propriété, et non quelques cas choisis : une poignée de montants pris à
  // la main passe même avec un arrondi naïf — sur cette période, plus d'un
  // tiers des valeurs dérivent, mais il faut tomber dessus. Le dernier mois
  // absorbe le reste ; sans cela, un centime perdu par ligne creuserait un
  // écart avec le total encaissé.
  const start = new Date("2026-01-10T00:00:00Z")
  const end = new Date("2026-04-10T00:00:00Z")
  for (let amount = 1; amount <= 2000; amount++) {
    const total = [...spreadOverMonths(amount, start, end).values()].reduce((a, b) => a + b, 0)
    assert.equal(total, amount, `montant ${amount} reconstitué`)
  }
  for (const amount of [999_999, 1_000_001, 2_000_000, 12_345_678]) {
    const total = [...spreadOverMonths(amount, start, end).values()].reduce((a, b) => a + b, 0)
    assert.equal(total, amount, `montant ${amount} reconstitué`)
  }
})

test("une période vide ou inversée ne fait pas disparaître l'argent", () => {
  const same = new Date("2026-05-01T00:00:00Z")
  const spread = spreadOverMonths(500_000, same, same)
  assert.equal([...spread.values()].reduce((a, b) => a + b, 0), 500_000)
})

// ---------------------------------------------------------------------------
// 2. Toute activation écrit au registre
// ---------------------------------------------------------------------------

test("activer depuis la console inscrit un encaissement complet", async () => {
  const orgId = await createStation("activation")
  const response = await console_(`/organizations/${orgId}/activate`, {
    method: "POST",
    body: {
      plan_code: "pro",
      months: 3,
      channel: "wave",
      payment_reference: "WAVE-887766",
      note: "Réglé par le gérant",
    },
  })
  assert.equal(response.status, 200)

  const rows = await listRevenue(pool, { organizationId: orgId })
  assert.equal(rows.length, 1, "exactement une ligne")
  const row = rows[0]
  assert.equal(row.plan_code, "pro")
  assert.equal(row.months, 3)
  // 20 000 F × 3 mois, en centimes.
  assert.equal(row.amount_cents, 2_000_000 * 3)
  assert.equal(row.channel, "wave")
  assert.equal(row.payment_reference, "WAVE-887766")
  assert.equal(row.operator_email, OPERATOR_EMAIL)
  assert.equal(row.organization_name, "Station Revenu activation")
  assert.ok(
    new Date(row.period_end) > new Date(row.period_start),
    "la période couverte est renseignée",
  )
})

test("un montant négocié prime sur le tarif affiché", async () => {
  // Le registre doit refléter la banque, pas le catalogue : une remise
  // accordée au téléphone ne doit pas gonfler le chiffre d'affaires.
  const orgId = await createStation("remise")
  const response = await console_(`/organizations/${orgId}/activate`, {
    method: "POST",
    body: { plan_code: "business", months: 1, amount: 25_000, channel: "cash" },
  })
  assert.equal(response.status, 200)
  const rows = await listRevenue(pool, { organizationId: orgId })
  assert.equal(rows[0].amount_cents, 2_500_000, "25 000 F et non les 35 000 F du tarif")
})

test("confirmer un paiement retient le montant du devis, pas le tarif du jour", async () => {
  // Scénario réel : le client reçoit un devis, le tarif change pendant
  // qu'il va payer. Il a réglé l'ancien prix ; recalculer ferait diverger le
  // registre du relevé bancaire.
  const orgId = await createStation("devis")
  await pool.query(
    `INSERT INTO payment_intents(organization_id, reference, plan_code, months, amount_cents, status)
     VALUES($1,'WP-TESTDEV2','pro',2,3_000_000,'pending')`,
    [orgId],
  )
  await pool.query(
    "UPDATE payment_intents SET declared_at = now(), declared_reference = 'OM-123' WHERE reference = 'WP-TESTDEV2'",
  )

  const response = await console_("/payment-intents/WP-TESTDEV2/confirm", {
    method: "POST",
    body: { channel: "orange_money" },
  })
  assert.equal(response.status, 200)

  const rows = await listRevenue(pool, { organizationId: orgId })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].amount_cents, 3_000_000, "le montant figé au devis")
  assert.notEqual(rows[0].amount_cents, 2_000_000 * 2, "et surtout pas le tarif × mois")
  assert.equal(rows[0].channel, "orange_money")
})

// ---------------------------------------------------------------------------
// 3. Contrepassation
// ---------------------------------------------------------------------------

test("contrepasser écrit l'inverse au lieu d'effacer", async () => {
  const orgId = await createStation("contrepassation")
  await console_(`/organizations/${orgId}/activate`, {
    method: "POST",
    body: { plan_code: "starter", months: 1, channel: "cash" },
  })
  const [original] = await listRevenue(pool, { organizationId: orgId })

  const response = await console_(`/revenue/${original.id}/reverse`, {
    method: "POST",
    body: { reason: "Encaissement saisi deux fois par erreur" },
  })
  assert.equal(response.status, 200)

  const rows = await listRevenue(pool, { organizationId: orgId })
  assert.equal(rows.length, 2, "la ligne d'origine demeure")
  const reversal = rows.find((r) => r.reverses_id === original.id)
  assert.ok(reversal, "la contrepassation pointe l'originale")
  assert.equal(reversal!.amount_cents, -original.amount_cents)
  assert.equal(
    rows.reduce((sum, r) => sum + r.amount_cents, 0),
    0,
    "le net est nul",
  )
})

test("on ne contrepasse pas deux fois, ni une contrepassation", async () => {
  const orgId = await createStation("double-annulation")
  await console_(`/organizations/${orgId}/activate`, {
    method: "POST",
    body: { plan_code: "starter", months: 1 },
  })
  const [original] = await listRevenue(pool, { organizationId: orgId })

  const first = await console_(`/revenue/${original.id}/reverse`, {
    method: "POST",
    body: { reason: "Premiere annulation justifiee" },
  })
  assert.equal(first.status, 200)
  const reversalId = (await first.json()).reversal_id as string

  const second = await console_(`/revenue/${original.id}/reverse`, {
    method: "POST",
    body: { reason: "Deuxieme tentative sur la meme ligne" },
  })
  assert.equal(second.status, 409)
  assert.equal((await second.json()).error.code, "already_reversed")

  const onReversal = await console_(`/revenue/${reversalId}/reverse`, {
    method: "POST",
    body: { reason: "Annuler une annulation na pas de sens" },
  })
  assert.equal(onReversal.status, 409)
  assert.equal((await onReversal.json()).error.code, "already_a_reversal")
})

test("une contrepassation ne rend pas l'accès au client", async () => {
  // Elle corrige l'argent, pas le droit. Confondre les deux couperait un
  // client à qui l'on voulait seulement rembourser une ligne en double.
  const orgId = await createStation("acces-apres-annulation")
  await console_(`/organizations/${orgId}/activate`, {
    method: "POST",
    body: { plan_code: "pro", months: 1 },
  })
  const [row] = await listRevenue(pool, { organizationId: orgId })
  await console_(`/revenue/${row.id}/reverse`, {
    method: "POST",
    body: { reason: "Erreur de saisie sur le montant" },
  })
  const sub = await pool.query(
    "SELECT status FROM subscriptions WHERE organization_id = $1::uuid",
    [orgId],
  )
  assert.equal(sub.rows[0].status, "active", "l'abonnement reste actif")
})

// ---------------------------------------------------------------------------
// 4. Les deux lectures de l'argent
// ---------------------------------------------------------------------------

test("un prépaiement fait une pointe de trésorerie et une courbe de revenu plate", async () => {
  const orgId = await createStation("prepaiement")
  const start = new Date("2026-01-10T00:00:00Z")
  await pool.query(
    `INSERT INTO subscription_payments(
       organization_id, organization_name, plan_code, plan_name, amount_cents, months,
       period_start, period_end, channel, source, occurred_at)
     VALUES($1,'Station Prepaiement','pro','Pro',12_000_000,6,
            $2::timestamptz, $3::timestamptz, 'bank_transfer', 'console', $2::timestamptz)`,
    [orgId, start.toISOString(), new Date("2026-07-10T00:00:00Z").toISOString()],
  )

  const series = await monthlyRevenue(
    pool,
    new Date("2026-01-01T00:00:00Z"),
    new Date("2026-07-01T00:00:00Z"),
  )
  const janvier = series.find((m) => m.month === "2026-01")!
  const avril = series.find((m) => m.month === "2026-04")!

  assert.equal(janvier.collected_cents, 12_000_000, "tout l'argent arrive en janvier")
  assert.equal(avril.collected_cents, 0, "et rien en avril")
  assert.ok(avril.recognized_cents > 0, "mais avril porte sa part de revenu")
  assert.ok(
    janvier.recognized_cents < janvier.collected_cents / 2,
    "janvier ne reconnaît qu'une fraction de ce qu'il encaisse",
  )
})

test("l'argent encaissé d'avance est une dette, pas un bénéfice", async () => {
  const orgId = await createStation("constate-avance")
  const now = new Date("2026-02-01T00:00:00Z")
  const before = await deferredRevenue(pool, now)
  await pool.query(
    `INSERT INTO subscription_payments(
       organization_id, organization_name, plan_code, plan_name, amount_cents, months,
       period_start, period_end, channel, source, occurred_at)
     VALUES($1,'Station Avance','pro','Pro',6_000_000,3,
            '2026-01-01T00:00:00Z'::timestamptz,'2026-04-01T00:00:00Z'::timestamptz,
            'cash','console','2026-01-01T00:00:00Z'::timestamptz)`,
    [orgId],
  )
  const after = await deferredRevenue(pool, now)
  // Mesure par écart : le produit constaté d'avance est une grandeur du
  // parc entier, et les autres tests y ont déjà versé des périodes en
  // cours. Seule la variation imputable à cette ligne est vérifiable.
  const delta = after - before
  // Deux mois sur trois restent à courir au 1er février.
  assert.ok(delta >= 3_900_000 && delta <= 4_100_000, `attendu ~4 000 000, obtenu ${delta}`)
})

// ---------------------------------------------------------------------------
// 5. Exports
// ---------------------------------------------------------------------------

const sampleRow = (over: Partial<RevenueRow> = {}): RevenueRow => ({
  id: "11111111-2222-3333-4444-555555555555",
  organization_id: null,
  organization_name: "Station Cocody",
  plan_code: "pro",
  plan_name: "Pro",
  amount_cents: 2_000_000,
  months: 1,
  period_start: "2026-03-01T00:00:00.000Z",
  period_end: "2026-04-01T00:00:00.000Z",
  channel: "wave",
  payment_reference: "WAVE-1",
  source: "console",
  operator_email: OPERATOR_EMAIL,
  note: null,
  reverses_id: null,
  occurred_at: "2026-03-01T00:00:00.000Z",
  ...over,
})

test("le CSV porte le BOM et le point-virgule, faute de quoi Excel le massacre", () => {
  const csv = detailedCsv([sampleRow()])
  assert.ok(csv.startsWith("\uFEFF"), "BOM présent")
  assert.ok(csv.split("\r\n")[0].includes(";"), "séparateur point-virgule")
  assert.ok(csv.includes("20000"), "montant en francs entiers, pas en centimes")
})

test("une cellule contenant un point-virgule est protégée", () => {
  const csv = detailedCsv([sampleRow({ note: "Remise ; geste commercial" })])
  assert.ok(csv.includes('"Remise ; geste commercial"'), "guillemets autour de la cellule")
})

test("le journal est équilibré : autant au débit qu'au crédit", () => {
  const csv = journalCsv([
    sampleRow(),
    sampleRow({ id: "22222222-2222-3333-4444-555555555555", amount_cents: 3_500_000, channel: "cash" }),
  ])
  const lines = csv.replace("\uFEFF", "").trim().split("\r\n").slice(1)
  let debit = 0
  let credit = 0
  for (const line of lines) {
    const cells = line.split(";")
    debit += Number(cells[6] || 0)
    credit += Number(cells[7] || 0)
  }
  assert.equal(debit, credit, "débits et crédits s'équilibrent")
  assert.equal(debit, 20_000 + 35_000)
})

test("le mobile money ne part pas en caisse", () => {
  // Le SYSCOHADA révisé a créé la classe 55 pour cela : un encaissement Wave
  // n'est ni de l'espèce, ni de la banque. Le ranger en 571 rendrait le
  // rapprochement du portefeuille impossible.
  const wave = journalCsv([sampleRow({ channel: "wave" })])
  assert.ok(wave.includes(";552;"), "Wave débite la monnaie électronique")
  assert.ok(!wave.includes(";571;"), "et surtout pas la caisse")

  const especes = journalCsv([sampleRow({ channel: "cash" })])
  assert.ok(especes.includes(";571;"), "les espèces vont bien en caisse")

  const virement = journalCsv([sampleRow({ channel: "bank_transfer" })])
  assert.ok(virement.includes(";521;"), "le virement va en banque")

  assert.ok(wave.includes(SYSCOHADA_ACCOUNTS.revenue.code), "produit en 7065")
})

test("une contrepassation s'écrit en sens inverse, pas en négatif", () => {
  // Un journal ne contient pas de nombres négatifs : il contient des
  // écritures inversées. Un montant négatif ferait sauter tout import.
  const csv = journalCsv([
    sampleRow({ amount_cents: -2_000_000, reverses_id: "aaaa", channel: "cash" }),
  ])
  assert.ok(!csv.includes("-20000"), "aucun montant négatif")
  const lines = csv.replace("\uFEFF", "").trim().split("\r\n").slice(1)
  const treasury = lines.find((l) => l.includes(";571;"))!.split(";")
  assert.equal(treasury[6], "", "la trésorerie n'est pas débitée")
  assert.equal(treasury[7], "20000", "elle est créditée")
})

test("l'export passe par la route et se télécharge", async () => {
  const response = await console_("/revenue/export?format=journal")
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type") ?? "", /text\/csv/)
  assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename=.*journal/)
  // `response.text()` décode en UTF-8 et **retire** le BOM au passage : le
  // chercher dans la chaîne échouerait alors qu'il est bien transmis. Il
  // faut regarder les octets.
  const bytes = new Uint8Array(await response.arrayBuffer())
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "BOM UTF-8 en tête du fichier")
})

test("exporter laisse une trace : c'est une sortie de données", async () => {
  await console_("/revenue/export?format=detail")
  const q = await pool.query(
    "SELECT action FROM platform_audit_logs WHERE action = 'revenue.export.detail' ORDER BY created_at DESC LIMIT 1",
  )
  assert.equal(q.rowCount, 1)
})

// ---------------------------------------------------------------------------
// 6. Le registre survit à la suppression du client
// ---------------------------------------------------------------------------

test("purger une station efface ses données mais pas son chiffre d'affaires", async () => {
  const orgId = await createStation("purge-registre")
  await console_(`/organizations/${orgId}/activate`, {
    method: "POST",
    body: { plan_code: "pro", months: 2, channel: "bank_transfer", payment_reference: "VIR-99" },
  })
  const before = await listRevenue(pool, { organizationId: orgId })
  assert.equal(before.length, 1)

  await pool.query(
    "UPDATE organizations SET deletion_requested_at = now(), deletion_scheduled_for = now() WHERE id = $1::uuid",
    [orgId],
  )
  await purgeOrganization(pool, orgId)

  const gone = await pool.query("SELECT 1 FROM organizations WHERE id = $1::uuid", [orgId])
  assert.equal(gone.rowCount, 0, "la station a bien disparu")

  const kept = await pool.query(
    "SELECT organization_id, organization_name, amount_cents FROM subscription_payments WHERE payment_reference = 'VIR-99'",
  )
  assert.equal(kept.rowCount, 1, "l'écriture comptable demeure")
  assert.equal(kept.rows[0].organization_id, null, "elle ne pointe plus une station inexistante")
  assert.equal(
    kept.rows[0].organization_name,
    "Station Revenu purge-registre",
    "mais le nom la garde lisible dans un export",
  )
})

// ---------------------------------------------------------------------------
// 7. Impayés
// ---------------------------------------------------------------------------

test("une station à échéance dépassée apparaît en revenu à risque", async () => {
  const orgId = await createStation("impaye")
  await pool.query(
    `UPDATE subscriptions SET status = 'active', current_period_end = now() - interval '12 days'
      WHERE organization_id = $1::uuid`,
    [orgId],
  )
  const response = await console_("/revenue")
  assert.equal(response.status, 200)
  const payload = (await response.json()) as {
    at_risk: Array<{ organization_id: string; days_overdue: number }>
    totals: { at_risk_cents: number }
  }
  const found = payload.at_risk.find((o) => o.organization_id === orgId)
  assert.ok(found, "la station figure parmi les impayés")
  assert.ok(found!.days_overdue >= 11, `${found!.days_overdue} jours de retard`)
  assert.ok(payload.totals.at_risk_cents > 0)
})

test("une station programmée pour suppression n'est plus comptée comme impayée", async () => {
  // Elle ne doit plus rien : on l'a coupée. La laisser gonflerait le revenu
  // à risque d'un argent qu'on ne réclamera jamais.
  const orgId = await createStation("impaye-supprime")
  await pool.query(
    `UPDATE subscriptions SET status = 'active', current_period_end = now() - interval '20 days'
      WHERE organization_id = $1::uuid`,
    [orgId],
  )
  await pool.query(
    `UPDATE organizations SET deletion_requested_at = now(),
            deletion_scheduled_for = now() + interval '30 days' WHERE id = $1::uuid`,
    [orgId],
  )
  const payload = (await (await console_("/revenue")).json()) as {
    at_risk: Array<{ organization_id: string }>
  }
  assert.ok(!payload.at_risk.some((o) => o.organization_id === orgId))
})

test("déclarer un paiement ne le fait pas entrer au registre", async () => {
  // Déclaration n'est pas encaissement. Tant que l'éditeur n'a pas vu
  // l'argent, il est « en attente » — pas du chiffre d'affaires.
  const orgId = await createStation("declare-non-confirme")
  await pool.query(
    `INSERT INTO payment_intents(organization_id, reference, plan_code, months, amount_cents, status, declared_at)
     VALUES($1,'WP-TESTDEC3','starter',1,1_000_000,'pending', now())`,
    [orgId],
  )
  const payload = (await (await console_("/revenue")).json()) as {
    pending: Array<{ reference: string; amount_cents: number }>
  }
  assert.ok(payload.pending.some((p) => p.reference === "WP-TESTDEC3"), "il figure en attente")

  const ledger = await listRevenue(pool, { organizationId: orgId })
  assert.equal(ledger.length, 0, "et pas au registre")
})
