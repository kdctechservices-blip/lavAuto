import test, { after, before } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"

/** Parcours de création de comptes utilisé par l'écran Équipe. */
let server: Server
let baseUrl: string
let pool: Pool
const sessions = new Map<string, string>()
const PASSWORD = "WashPilot2026!"
const INITIAL_PASSWORD = "Initial2026!"

async function login(email: string, password = PASSWORD) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  assert.equal(response.status, 200, `connexion ${email}`)
  const cookie = response.headers.getSetCookie?.().join("; ") ?? response.headers.get("set-cookie") ?? ""
  sessions.set(email, cookie)
  return cookie
}

async function api(
  path: string,
  options: { as?: string; method?: string; body?: unknown; cookie?: string } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const cookie = options.cookie ?? (options.as ? sessions.get(options.as) : "")
  if (cookie) headers.Cookie = cookie
  return fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

before(async () => {
  assert.ok(await initDatabaseSchema(), "base de test initialisée")
  pool = getPool() as Pool
  // Le jeu de démonstration est déjà à son plafond : cette suite vérifie
  // d'abord les créations dans un forfait qui dispose de places.
  await pool.query("UPDATE plans SET max_users = 100")
  const app = createApiApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
  await login("demo@washpilot.ci")
  await login("gerant@washpilot.ci")
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

test("la capacité indique les places sans exposer les comptes au responsable", async () => {
  const response = await api("/api/v1/access/capacity", { as: "gerant@washpilot.ci" })
  assert.equal(response.status, 200)
  const capacity = await response.json() as {
    max_users: number | null
    active_users: number
    remaining_users: number | null
    can_create: boolean
  }
  assert.equal(capacity.max_users, 100)
  assert.ok(capacity.active_users >= 4)
  assert.equal(capacity.remaining_users, 100 - capacity.active_users)
  assert.equal(capacity.can_create, true)
})

test("le propriétaire crée un compte actif et le retrouve dans la liste", async () => {
  const created = await api("/api/v1/access/members", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: {
      email: "compte.caissier@example.ci",
      first_name: "Awa",
      last_name: "Caisse",
      phone: null,
      role: "cashier",
      password: INITIAL_PASSWORD,
    },
  })
  assert.equal(created.status, 201, await created.text())

  const response = await api("/api/v1/users", { as: "demo@washpilot.ci" })
  assert.equal(response.status, 200)
  const accounts = await response.json() as Array<{ email: string; role: string; status: string }>
  const account = accounts.find((item) => item.email === "compte.caissier@example.ci")
  assert.equal(account?.role, "cashier")
  assert.equal(account?.status, "active")
})

test("le responsable crée un agent qui peut se connecter immédiatement", async () => {
  const created = await api("/api/v1/access/members", {
    as: "gerant@washpilot.ci",
    method: "POST",
    body: {
      email: "agent.compte@example.ci",
      first_name: "Koffi",
      last_name: "Lavage",
      phone: "+225 07 00 00 00 00",
      role: "washer",
      password: INITIAL_PASSWORD,
    },
  })
  assert.equal(created.status, 201, await created.text())

  // Le responsable ne reçoit pas pour autant la liste des comptes sensibles.
  assert.equal((await api("/api/v1/users", { as: "gerant@washpilot.ci" })).status, 403)
  const ownerList = await api("/api/v1/users", { as: "demo@washpilot.ci" })
  const accounts = await ownerList.json() as Array<{ email: string; role: string }>
  assert.ok(accounts.some((item) => item.email === "agent.compte@example.ci" && item.role === "washer"))

  const cookie = await login("agent.compte@example.ci", INITIAL_PASSWORD)
  const me = await api("/api/v1/auth/me", { cookie })
  assert.equal(me.status, 200)
  const current = await me.json() as { role?: string; user?: { email?: string } }
  assert.equal(current.role, "washer")
  assert.equal(current.user?.email, "agent.compte@example.ci")
})

test("le responsable ne peut pas déléguer un compte caissier", async () => {
  const response = await api("/api/v1/access/members", {
    as: "gerant@washpilot.ci",
    method: "POST",
    body: {
      email: "delegation.interdite@example.ci",
      first_name: "Refus",
      last_name: "Caisse",
      role: "cashier",
      password: INITIAL_PASSWORD,
    },
  })
  assert.equal(response.status, 403)
  const payload = await response.json() as { error?: { code?: string } }
  assert.equal(payload.error?.code, "forbidden")
})

test("le plafond du forfait est annoncé puis appliqué à la création", async () => {
  await pool.query("UPDATE plans SET max_users = 1")
  const capacityResponse = await api("/api/v1/access/capacity", { as: "demo@washpilot.ci" })
  assert.equal(capacityResponse.status, 200)
  const capacity = await capacityResponse.json() as { can_create: boolean; remaining_users: number }
  assert.equal(capacity.can_create, false)
  assert.equal(capacity.remaining_users, 0)

  const response = await api("/api/v1/access/members", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: {
      email: "plafond.atteint@example.ci",
      first_name: "Plafond",
      last_name: "Atteint",
      role: "cashier",
      password: INITIAL_PASSWORD,
    },
  })
  assert.equal(response.status, 409)
  const payload = await response.json() as { error?: { code?: string } }
  assert.equal(payload.error?.code, "plan_user_limit")
})
