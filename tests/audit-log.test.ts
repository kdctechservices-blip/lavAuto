import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"
import {
  AUDIT_ACTION_LABELS,
  auditActionLabel,
  auditEntityLabel,
  auditSeverity,
} from "../server/audit-log.ts"

// ---------------------------------------------------------------------------
// Historique des opérations
//
// Deux promesses à tenir : l'historique doit être *lisible* par ceux qui en ont
// le droit, et *illisible* par les autres. On vérifie aussi qu'il reste en
// lecture seule : aucune route ne permet de réécrire le passé.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool

const PASSWORD = "WashPilot2026!"
const sessions = new Map<string, string>()
let orgId: string

/** Place l'organisation de test sur un forfait donné. */
async function setPlan(code: string) {
  await pool.query(
    `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code=$2),
       status='active', plan_changed_at=now(), updated_at=now()
     WHERE organization_id=$1::uuid`,
    [orgId, code],
  )
  invalidateSubscriptionCache(orgId)
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

  // Quelques traces d'origines différentes, pour éprouver les filtres.
  const org = await pool.query(
    "SELECT m.organization_id FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email='demo@washpilot.ci'",
  )
  orgId = org.rows[0].organization_id
  // L'historique est une fonction du forfait Pro : sans cela, toutes les
  // lectures répondraient 402 et l'on ne testerait que la garde de forfait.
  await setPlan("pro")
  const owner = await pool.query("SELECT id FROM users WHERE email='demo@washpilot.ci'")
  const ownerId = owner.rows[0].id

  await pool.query(
    `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES ($1::uuid,$2::uuid,'payment.refunded','payment',gen_random_uuid(),$3::jsonb)`,
    [orgId, ownerId, JSON.stringify({ reason: "Client parti sans le lavage complet" })],
  )
  await pool.query(
    `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id)
     VALUES ($1::uuid,$2::uuid,'wash.cancelled','wash',gen_random_uuid())`,
    [orgId, ownerId],
  )
  // Action sans auteur : une tâche automatique doit rester lisible.
  await pool.query(
    `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id)
     VALUES ($1::uuid,NULL,'backup.created','backup',gen_random_uuid())`,
    [orgId],
  )
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// --- Libellés --------------------------------------------------------------

test("chaque action connue a un libellé français", () => {
  for (const [action, label] of Object.entries(AUDIT_ACTION_LABELS)) {
    assert.ok(label.length > 0, `libellé manquant pour ${action}`)
    assert.notEqual(label, action, `${action} n'est pas traduit`)
  }
})

test("une action inconnue retombe sur son code plutôt que sur du vide", () => {
  // Mieux vaut afficher « feature.invented » qu'une ligne muette : l'opération
  // a bien eu lieu, l'écran ne doit pas la faire disparaître.
  assert.equal(auditActionLabel("feature.invented"), "feature.invented")
  assert.equal(auditEntityLabel("gadget"), "gadget")
})

test("un refus d'accès est signalé comme un événement de vigilance", () => {
  assert.equal(auditSeverity("access.denied"), "warning")
  assert.equal(auditSeverity("payment.refunded"), "info")
})

// --- Droit de lecture ------------------------------------------------------

test("le propriétaire consulte l'historique", async () => {
  const response = await api("/api/v1/audit-logs", { as: "demo@washpilot.ci" })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.ok(Array.isArray(payload.entries))
  assert.ok(payload.total >= 3)
})

test("le gérant consulte l'historique", async () => {
  const response = await api("/api/v1/audit-logs", { as: "gerant@washpilot.ci" })
  assert.equal(response.status, 200)
})

test("le caissier et l'agent de lavage sont refusés", async () => {
  for (const email of ["caisse@washpilot.ci", "laveur@washpilot.ci"]) {
    const response = await api("/api/v1/audit-logs", { as: email })
    assert.equal(response.status, 403, email)
    const payload = await response.json()
    assert.equal(payload.error.code, "forbidden")
  }
})

test("un visiteur non connecté reçoit 401", async () => {
  const response = await fetch(`${baseUrl}/api/v1/audit-logs`)
  assert.equal(response.status, 401)
})

// --- Contenu des entrées ---------------------------------------------------

test("une entrée porte son libellé, son auteur et sa sévérité", async () => {
  const payload = await (
    await api("/api/v1/audit-logs?action=payment.refunded", { as: "demo@washpilot.ci" })
  ).json()
  assert.ok(payload.entries.length >= 1)
  const entry = payload.entries[0]
  assert.equal(entry.action, "payment.refunded")
  assert.equal(entry.action_label, "Encaissement remboursé")
  assert.equal(entry.severity, "info")
  assert.notEqual(entry.actor_name, "Système")
  assert.equal(entry.metadata.reason, "Client parti sans le lavage complet")
})

test("une action automatique est attribuée au système, pas à un utilisateur", async () => {
  const payload = await (
    await api("/api/v1/audit-logs?action=backup.created", { as: "demo@washpilot.ci" })
  ).json()
  assert.ok(payload.entries.length >= 1)
  assert.equal(payload.entries[0].actor_user_id, null)
  assert.equal(payload.entries[0].actor_name, "Système")
})

test("les entrées sont rendues de la plus récente à la plus ancienne", async () => {
  const payload = await (await api("/api/v1/audit-logs?limit=50", { as: "demo@washpilot.ci" })).json()
  const dates = payload.entries.map((entry: { created_at: string }) => Date.parse(entry.created_at))
  for (let i = 1; i < dates.length; i += 1) {
    assert.ok(dates[i - 1] >= dates[i], "ordre antichronologique attendu")
  }
})

// --- Filtres et pagination -------------------------------------------------

test("le filtre par type d'objet restreint bien la liste", async () => {
  const payload = await (
    await api("/api/v1/audit-logs?entity_type=wash", { as: "demo@washpilot.ci" })
  ).json()
  assert.ok(payload.total >= 1)
  for (const entry of payload.entries) assert.equal(entry.entity_type, "wash")
})

test("la pagination découpe sans perdre d'entrée", async () => {
  const all = await (await api("/api/v1/audit-logs?limit=100", { as: "demo@washpilot.ci" })).json()
  const firstPage = await (await api("/api/v1/audit-logs?limit=2", { as: "demo@washpilot.ci" })).json()
  const secondPage = await (
    await api("/api/v1/audit-logs?limit=2&offset=2", { as: "demo@washpilot.ci" })
  ).json()
  assert.equal(firstPage.entries.length, 2)
  assert.equal(firstPage.total, all.total)
  const ids = new Set([...firstPage.entries, ...secondPage.entries].map((e: { id: string }) => e.id))
  assert.equal(ids.size, firstPage.entries.length + secondPage.entries.length, "pas de doublon entre les pages")
})

test("une période inversée est refusée", async () => {
  const response = await api("/api/v1/audit-logs?from=2026-10-20&to=2026-10-01", {
    as: "demo@washpilot.ci",
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, "invalid_range")
})

test("la borne de fin est incluse : une entrée du jour reste visible", async () => {
  const today = new Date().toISOString().slice(0, 10)
  const payload = await (
    await api(`/api/v1/audit-logs?from=${today}&to=${today}`, { as: "demo@washpilot.ci" })
  ).json()
  assert.ok(payload.total >= 3, "les entrées créées aujourd'hui doivent apparaître")
})

test("les filtres proposés ne listent que des valeurs réellement présentes", async () => {
  const payload = await (await api("/api/v1/audit-logs/filters", { as: "demo@washpilot.ci" })).json()
  const actions = payload.actions.map((option: { value: string }) => option.value)
  assert.ok(actions.includes("payment.refunded"))
  assert.ok(!actions.includes("onboarding.completed"), "aucune action non survenue ne doit être proposée")
  for (const option of payload.actions) assert.ok(option.count > 0)
})

// --- Immuabilité et cloisonnement -----------------------------------------

test("l'historique n'expose aucune route d'écriture", async () => {
  for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
    const response = await api("/api/v1/audit-logs", { as: "demo@washpilot.ci", method, body: {} })
    assert.ok(
      response.status === 404 || response.status === 405,
      `${method} ne doit pas être accepté (reçu ${response.status})`,
    )
  }
})

test("l'historique d'une organisation reste invisible depuis une autre", async () => {
  // Une trace déposée dans une organisation voisine ne doit jamais remonter.
  const other = await pool.query(
    "INSERT INTO organizations(name) VALUES('Station voisine') RETURNING id",
  )
  const foreign = await pool.query(
    `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id)
     VALUES ($1::uuid,NULL,'wash.created','wash',gen_random_uuid()) RETURNING id`,
    [other.rows[0].id],
  )
  const payload = await (await api("/api/v1/audit-logs?limit=200", { as: "demo@washpilot.ci" })).json()
  const leaked = payload.entries.some((entry: { id: string }) => entry.id === foreign.rows[0].id)
  assert.equal(leaked, false, "l'entrée de l'organisation voisine ne doit pas fuiter")
})
