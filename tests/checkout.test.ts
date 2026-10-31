import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"
import { planRenewalReminder, runSubscriptionReminders } from "../server/reminders.ts"

// ---------------------------------------------------------------------------
// Parcours de souscription : intention → paiement → déclaration → validation
//
// Le scénario réel : l'essai expire, le client veut payer. Ce qui est testé
// ici est moins la mécanique que les refus — une déclaration n'est pas un
// paiement, et deux validations simultanées ne valent qu'un mois.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool
let organizationId: string

const PASSWORD = "WashPilot2026!"
const sessions = new Map<string, string>()

const OPERATOR_EMAIL = "ops@washpilot.ci"
const OPERATOR_PASSWORD = "ConsoleSecret2026!"
let operatorCookie = ""

/** Appel de la console, authentifié par le cookie d'opérateur. */
async function console_(path: string, options: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const cookie = options.cookie === undefined ? operatorCookie : options.cookie
  if (cookie) headers.Cookie = cookie
  return fetch(`${baseUrl}/api/v1/console${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function api(path: string, options: { as?: string; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (options.as) {
    const cookie = sessions.get(options.as)
    if (cookie) headers.Cookie = cookie
  }
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

async function resetSubscription(status: string, planCode: string, daysLeft: number) {
  await pool.query(
    `UPDATE subscriptions
        SET plan_id = (SELECT id FROM plans WHERE code = $2),
            status = $1,
            current_period_end = now() + ($3 || ' days')::interval
      WHERE organization_id = $4::uuid`,
    [status, planCode, String(daysLeft), organizationId],
  )
  invalidateSubscriptionCache(organizationId)
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

  organizationId = (await pool.query("SELECT id FROM organizations LIMIT 1")).rows[0].id
  // La validation passe par la console, dont les comptes sont disjoints de
  // ceux des stations (voir server/console-auth.ts).
  const { hashPassword } = await import("../server/auth.ts")
  await pool.query("UPDATE users SET platform_admin = false")
  await pool.query(
    `INSERT INTO platform_operators(email, password_hash, full_name, status)
     VALUES($1, $2, 'Operateur de test', 'active')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'`,
    [OPERATOR_EMAIL, await hashPassword(OPERATOR_PASSWORD)],
  )
  const loggedIn = await fetch(`${baseUrl}/api/v1/console/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD }),
  })
  assert.equal(loggedIn.status, 200, "connexion de l'opérateur")
  operatorCookie = loggedIn.headers.getSetCookie?.().join("; ") ?? loggedIn.headers.get("set-cookie") ?? ""

  for (const email of ["demo@washpilot.ci", "gerant@washpilot.ci", "caisse@washpilot.ci"]) {
    await login(email)
  }
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

test("un essai expiré peut encore ouvrir une intention de paiement", async () => {
  // Le point crucial : lecture seule ne doit pas vouloir dire « impossible de
  // payer ». Un client bloqué qui ne peut pas souscrire est un client perdu.
  await resetSubscription("trialing", "starter", -3)
  const state = await (await api("/api/v1/subscription", { as: "demo@washpilot.ci" })).json()
  assert.equal(state.read_only, true, "la station est bien en lecture seule")

  const response = await api("/api/v1/subscription/checkout", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { plan_code: "pro", months: 1 },
  })
  assert.equal(response.status, 201)
  const intent = await response.json()
  assert.match(intent.reference, /^WP-[A-Z2-9]{8}$/)
  assert.equal(intent.amount_cents, 2_000_000)
  assert.equal(intent.provider, "manual")
})

test("le montant suit la durée achetée", async () => {
  const response = await api("/api/v1/subscription/checkout", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { plan_code: "business", months: 3 },
  })
  assert.equal((await response.json()).amount_cents, 3_500_000 * 3)
})

test("cliquer deux fois ne crée pas deux références", async () => {
  // Sinon le client en paie une et personne ne sait laquelle.
  const first = await (
    await api("/api/v1/subscription/checkout", {
      as: "demo@washpilot.ci",
      method: "POST",
      body: { plan_code: "pro", months: 1 },
    })
  ).json()
  const second = await (
    await api("/api/v1/subscription/checkout", {
      as: "demo@washpilot.ci",
      method: "POST",
      body: { plan_code: "pro", months: 1 },
    })
  ).json()
  assert.equal(first.reference, second.reference)
})

test("déclarer un paiement n'active rien", async () => {
  // Une déclaration est une affirmation du client, pas une preuve.
  const intent = await (
    await api("/api/v1/subscription/checkout", {
      as: "demo@washpilot.ci",
      method: "POST",
      body: { plan_code: "pro", months: 1 },
    })
  ).json()

  const declared = await api(`/api/v1/subscription/checkout/${intent.reference}/declare`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { transaction_reference: "OM-77412093", paid_with: "Orange Money" },
  })
  assert.equal(declared.status, 200)

  const state = await (await api("/api/v1/subscription", { as: "demo@washpilot.ci" })).json()
  assert.equal(state.read_only, true, "toujours en lecture seule tant que rien n'est vérifié")
  assert.notEqual(state.plan_code, "pro")
})

test("l'éditeur voit la déclaration dans sa file, et valide en un clic", async () => {
  const file = await (
    await console_("/payment-intents?declared=true")
  ).json()
  const intent = file.intents[0]
  assert.equal(intent.declared_reference, "OM-77412093")
  assert.equal(intent.organization_name.length > 0, true)
  assert.equal(intent.plan_code, "pro")

  const confirmed = await console_(`/payment-intents/${intent.reference}/confirm`, {method: "POST",
    body: {},
  })
  assert.equal(confirmed.status, 200)

  // L'effet doit être immédiat côté client.
  const state = await (await api("/api/v1/subscription", { as: "demo@washpilot.ci" })).json()
  assert.equal(state.plan_code, "pro")
  assert.equal(state.status, "active")
  assert.equal(state.read_only, false)
})

test("une validation déjà faite ne se rejoue pas", async () => {
  const file = await (
    await console_("/payment-intents?status=paid")
  ).json()
  const reference = file.intents[0].reference

  const replay = await console_(`/payment-intents/${reference}/confirm`, {method: "POST",
    body: {},
  })
  assert.equal(replay.status, 404, "le second appel ne doit pas activer un mois de plus")
})

test("deux validations simultanées n'activent qu'un seul mois", async () => {
  // Le cas qui n'arrive jamais en test manuel et toujours en production :
  // double clic, ou webhook rejoué pendant que l'éditeur valide.
  await resetSubscription("trialing", "starter", 5)
  const intent = await (
    await api("/api/v1/subscription/checkout", {
      as: "demo@washpilot.ci",
      method: "POST",
      body: { plan_code: "pro", months: 1 },
    })
  ).json()

  const [a, b] = await Promise.all([
    console_(`/payment-intents/${intent.reference}/confirm`, {method: "POST",
      body: {},
    }),
    console_(`/payment-intents/${intent.reference}/confirm`, {method: "POST",
      body: {},
    }),
  ])
  const codes = [a.status, b.status].sort()
  assert.deepEqual(codes, [200, 404], "exactement une des deux doit aboutir")

  const activations = await pool.query(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE organization_id = $1::uuid
        AND action = 'subscription.activated'
        AND metadata->>'intent_reference' = $2`,
    [organizationId, intent.reference],
  )
  assert.equal(activations.rows[0].n, 1, "une seule activation journalisée")
})

test("un caissier ne peut pas souscrire", async () => {
  const response = await api("/api/v1/subscription/checkout", {
    as: "caisse@washpilot.ci",
    method: "POST",
    body: { plan_code: "pro", months: 1 },
  })
  assert.equal(response.status, 403)
})

test("une station ne voit pas l'intention d'une autre", async () => {
  const response = await api("/api/v1/subscription/checkout/WP-ZZZZZZZZ/declare", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { transaction_reference: "FAUX-123" },
  })
  assert.equal(response.status, 404)
})

test("la file de validation reste fermée aux clients", async () => {
  assert.equal((await console_("/payment-intents", { cookie: sessions.get("gerant@washpilot.ci") ?? "" })).status, 404)
})

test("une référence mal formée est refusée proprement, pas en erreur serveur", async () => {
  const response = await console_("/payment-intents/pas-une-reference/confirm", {method: "POST",
    body: {},
  })
  assert.ok(response.status >= 400 && response.status < 500, `attendu 4xx, reçu ${response.status}`)
})

// ---------------------------------------------------------------------------
// Relances de renouvellement
//
// Le rail mobile money ne permet pas de prélèvement récurrent fiable : ces
// relances SONT le mécanisme de renouvellement, pas un rappel de courtoisie.
// ---------------------------------------------------------------------------

test("la relance de renouvellement suit l'approche de l'échéance", () => {
  assert.equal(planRenewalReminder(30), null, "rien à 30 jours")
  assert.equal(planRenewalReminder(8), null, "rien à 8 jours")
  assert.equal(planRenewalReminder(7), "renewal_j7")
  assert.equal(planRenewalReminder(3), "renewal_j3")
  assert.equal(planRenewalReminder(1), "renewal_j1")
  assert.equal(planRenewalReminder(-2), "renewal_overdue", "l'échéance dépassée est le cas qui coûte")
})

test("une relance déjà envoyée ne part pas deux fois", () => {
  assert.equal(planRenewalReminder(7, ["renewal_j7"]), null)
  // Mais l'étape suivante, si.
  assert.equal(planRenewalReminder(3, ["renewal_j7"]), "renewal_j3")
})

test("renouveler efface les relances pour que la période suivante en reçoive", async () => {
  // Le défaut qu'on éviterait mal autrement : sans effacement, un client ne
  // reçoit l'avertissement J-7 qu'une seule fois dans sa vie.
  await resetSubscription("active", "pro", 5)
  await pool.query(
    `INSERT INTO subscription_reminders(organization_id, kind)
     VALUES($1::uuid,'renewal_j7'),($1::uuid,'trial_j3')
     ON CONFLICT DO NOTHING`,
    [organizationId],
  )

  const intent = await (
    await api("/api/v1/subscription/checkout", {
      as: "demo@washpilot.ci",
      method: "POST",
      body: { plan_code: "pro", months: 1 },
    })
  ).json()
  await api(`/api/v1/subscription/checkout/${intent.reference}/declare`, {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { transaction_reference: "WAVE-55512" },
  })
  await console_(`/payment-intents/${intent.reference}/confirm`, {method: "POST",
    body: {},
  })

  const kinds = await pool.query(
    "SELECT kind FROM subscription_reminders WHERE organization_id = $1::uuid",
    [organizationId],
  )
  const remaining = kinds.rows.map((r: { kind: string }) => r.kind)
  assert.ok(!remaining.includes("renewal_j7"), "les relances de renouvellement repartent à zéro")
  assert.ok(remaining.includes("trial_j3"), "celles de l'essai ne se répètent pas, on les garde")
})

test("le planificateur relance un forfait payant proche de l'échéance", async () => {
  await resetSubscription("active", "pro", 2)
  await pool.query("DELETE FROM subscription_reminders WHERE organization_id = $1::uuid", [
    organizationId,
  ])

  const outcomes = await runSubscriptionReminders(pool)
  const mine = outcomes.find((o) => o.organization_id === organizationId)
  assert.ok(mine, "la station reçoit une relance")
  assert.equal(mine.kind, "renewal_j3")

  // Et une seule : le second passage ne doit rien renvoyer.
  const second = await runSubscriptionReminders(pool)
  assert.equal(
    second.find((o) => o.organization_id === organizationId),
    undefined,
  )
})
