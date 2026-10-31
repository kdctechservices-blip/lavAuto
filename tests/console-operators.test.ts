import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"

import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { hashPassword } from "../server/auth.ts"
import { syncPlatformOperators } from "../server/console-auth.ts"
import { env } from "../server/env.ts"

let server: Server
let baseUrl: string
let pool: Pool
let adminCookie = ""
let adminId = ""
let supportId = ""
let supportPassword = ""
let supportCookie = ""

const ADMIN_EMAIL = "admin-roles@washpilot.ci"
const ADMIN_PASSWORD = "ConsoleAdmin2026!"

async function login(email: string, password: string) {
  const response = await fetch(`${baseUrl}/api/v1/console/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  const cookie = response.headers.getSetCookie?.().join("; ") ?? response.headers.get("set-cookie") ?? ""
  return { response, cookie, payload: await response.json() }
}

async function consoleReq(path: string, options: {
  method?: string
  body?: unknown
  cookie?: string
} = {}) {
  return fetch(`${baseUrl}/api/v1/console${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      Cookie: options.cookie === undefined ? adminCookie : options.cookie,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

before(async () => {
  assert.ok(await initDatabaseSchema(), "base de test initialisée")
  pool = getPool() as Pool
  const app = createApiApp()
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", resolve) })
  const address = server.address()
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
  await pool.query(
    `INSERT INTO platform_operators(email, password_hash, full_name, status, role, managed_by)
     VALUES($1,$2,'Administrateur des rôles','active','admin','bootstrap')`,
    [ADMIN_EMAIL, await hashPassword(ADMIN_PASSWORD)],
  )
  const session = await login(ADMIN_EMAIL, ADMIN_PASSWORD)
  assert.equal(session.response.status, 200, JSON.stringify(session.payload))
  adminCookie = session.cookie
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

test("la session expose le rôle, sans réutiliser une session de station", async () => {
  const session = await login(ADMIN_EMAIL, ADMIN_PASSWORD)
  assert.equal(session.payload.operator.role, "admin")
  const me = await (await consoleReq("/auth/me", { cookie: session.cookie })).json()
  assert.equal(me.operator.role, "admin")
  adminId = me.operator.id
  const stationLogin = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo@washpilot.ci", password: "WashPilot2026!" }),
  })
  assert.equal(stationLogin.status, 200)
  const stationCookie = stationLogin.headers.getSetCookie?.().join("; ") ?? stationLogin.headers.get("set-cookie") ?? ""
  assert.equal((await consoleReq("/metrics", { cookie: stationCookie })).status, 404)
})

test("un administrateur crée un opérateur et le mot de passe n'apparaît qu'une fois", async () => {
  const response = await consoleReq("/operators", {
    method: "POST",
    body: { email: "support-roles@washpilot.ci", full_name: "Support Lecture", role: "support" },
  })
  const created = await response.json()
  assert.equal(response.status, 201, JSON.stringify(created))
  supportId = created.operator.id
  supportPassword = created.temporary_password
  assert.ok(supportPassword.startsWith("WPC-"))
  assert.equal(created.operator.role, "support")
  assert.equal(created.operator.managed_by, "console")
  assert.equal(created.operator.password_hash, undefined)

  const list = await (await consoleReq("/operators")).json()
  const listed = list.operators.find((row: { id: string }) => row.id === supportId)
  assert.equal(listed.email, "support-roles@washpilot.ci")
  assert.equal(JSON.stringify(listed).includes("password"), false)
  assert.equal(JSON.stringify(list).includes(supportPassword), false)

  const session = await login("support-roles@washpilot.ci", supportPassword)
  assert.equal(session.response.status, 200)
  supportCookie = session.cookie
})

test("le support lit la Console mais aucune écriture ne passe, même avec une requête valide", async () => {
  assert.equal((await consoleReq("/reconciliation", { cookie: supportCookie })).status, 200)
  assert.equal((await consoleReq("/monitoring/alerts", { cookie: supportCookie })).status, 200)
  assert.equal((await consoleReq("/operators", { cookie: supportCookie })).status, 403)

  const write = await consoleReq("/reconciliation/batches", {
    cookie: supportCookie,
    method: "POST",
    body: { provider: "wave", from: "2026-10-01", to: "2026-10-24", entries: [{ reference: "X", amount: 1 }] },
  })
  assert.equal(write.status, 403)
  assert.equal((await write.json()).error.code, "console_read_only")

  const tickets = await consoleReq("/support/not-a-uuid/status", {
    cookie: supportCookie,
    method: "POST",
    body: { status: "resolved" },
  })
  assert.equal(tickets.status, 403, "le garde doit précéder même la validation de la route")
})

test("le superviseur peut administrer l'exploitation, pas les opérateurs ni les alertes", async () => {
  const created = await (await consoleReq("/operators", {
    method: "POST",
    body: { email: "supervisor-roles@washpilot.ci", full_name: "Superviseur Exploitation", role: "supervisor" },
  })).json()
  const session = await login("supervisor-roles@washpilot.ci", created.temporary_password)
  assert.equal(session.response.status, 200)
  assert.equal(session.payload.operator.role, "supervisor")

  assert.equal((await consoleReq("/operators", { cookie: session.cookie })).status, 403)
  const alert = await consoleReq("/monitoring/alerts/test", { cookie: session.cookie, method: "POST", body: {} })
  assert.equal(alert.status, 403)
  assert.equal((await alert.json()).error.code, "console_admin_required")

  // Un corps incomplet doit maintenant produire une erreur de validation, et
  // non le 403 du support : cela prouve que le garde d'écriture est passé.
  const operationalWrite = await consoleReq("/reconciliation/batches", {
    cookie: session.cookie,
    method: "POST",
    body: {},
  })
  assert.equal(operationalWrite.status, 400)
})

test("un changement de rôle s'applique à la session déjà ouverte", async () => {
  const changed = await consoleReq(`/operators/${supportId}`, {
    method: "PATCH",
    body: { role: "supervisor", reason: "Promotion validée par la direction" },
  })
  assert.equal(changed.status, 200, await changed.text())
  const write = await consoleReq("/reconciliation/batches", {
    cookie: supportCookie,
    method: "POST",
    body: {},
  })
  assert.equal(write.status, 400, "l'ancienne session n'est plus limitée au support")
})

test("réinitialiser un mot de passe révoque les sessions et le nouveau secret fonctionne", async () => {
  const created = await (await consoleReq("/operators", {
    method: "POST",
    body: { email: "reset-roles@washpilot.ci", full_name: "Compte À Réinitialiser", role: "support" },
  })).json()
  const oldSession = await login("reset-roles@washpilot.ci", created.temporary_password)
  assert.equal(oldSession.response.status, 200)

  const reset = await consoleReq(`/operators/${created.operator.id}/reset-password`, {
    method: "POST",
    body: { reason: "Soupçon de partage du mot de passe" },
  })
  const result = await reset.json()
  assert.equal(reset.status, 200)
  assert.ok(result.sessions_revoked >= 1)
  assert.equal((await consoleReq("/metrics", { cookie: oldSession.cookie })).status, 404)
  assert.equal((await login("reset-roles@washpilot.ci", created.temporary_password)).response.status, 401)
  const renewed = await login("reset-roles@washpilot.ci", result.temporary_password)
  assert.equal(renewed.response.status, 200)
})

test("le compte connecté est protégé et l'amorçage ne désactive pas les comptes gérés", async () => {
  const self = await consoleReq(`/operators/${adminId}`, {
    method: "PATCH",
    body: { role: "support", reason: "Tentative de rétrogradation du compte connecté" },
  })
  assert.equal(self.status, 409)
  assert.equal((await self.json()).error.code, "self_modification")

  env.PLATFORM_ADMIN_EMAILS.push(ADMIN_EMAIL)
  try {
    await syncPlatformOperators(pool.query.bind(pool))
  } finally {
    env.PLATFORM_ADMIN_EMAILS.pop()
  }
  const managed = await pool.query(
    "SELECT status FROM platform_operators WHERE id = $1::uuid AND managed_by = 'console'",
    [supportId],
  )
  assert.equal(managed.rows[0].status, "active")
})
