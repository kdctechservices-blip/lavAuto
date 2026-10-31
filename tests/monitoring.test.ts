import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Server } from "node:http"
import type { Pool } from "pg"
import express from "express"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp, apiErrorHandler } from "../server/app.ts"
import { HttpError, hashPassword } from "../server/auth.ts"
import { monitorRequests } from "../server/monitoring-middleware.ts"
import {
  REDACTED,
  bucketStart,
  isSensitiveKey,
  monitoringOverview,
  normalizeRoute,
  prepareBody,
  purgeMonitoring,
  recordErrorEvent,
  recordRequest,
  redactBody,
  statusClass,
} from "../server/monitoring.ts"

// ---------------------------------------------------------------------------
// La surveillance
//
// Deux choses sont réellement en jeu dans ce fichier :
//
//   1. **Aucun mot de passe ne doit atterrir dans la table de supervision.**
//      Enregistrer les corps de requête a été décidé en connaissance de
//      cause ; enregistrer des identifiants en clair n'a jamais fait partie
//      de la décision. C'est le premier bloc, et le plus long.
//
//   2. **Les chiffres doivent être exacts.** Un taux d'erreur approximatif est
//      pire que pas de taux du tout : il donne confiance sans la mériter. Les
//      compteurs sont donc vérifiés sur des volumes connus, pas sur des
//      échantillons.
// ---------------------------------------------------------------------------

let pool: Pool
let server: Server
let baseUrl: string
let faultyServer: Server
let faultyUrl: string

const OPERATOR_EMAIL = "ops-surveillance@washpilot.ci"
const OPERATOR_PASSWORD = "ConsoleSecret2026!"
let operatorCookie = ""

async function consoleReq(path: string) {
  return fetch(`${baseUrl}/api/v1/console${path}`, {
    headers: { "Content-Type": "application/json", Cookie: operatorCookie },
  })
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

  // Une application assemblée exactement comme la production — `express.json`,
  // puis `monitorRequests`, puis les routes, puis `apiErrorHandler` — mais
  // dont les routes échouent à la demande. Provoquer une vraie panne dans
  // l'API réelle demanderait de casser une route existante ; reconstituer la
  // pile à l'identique prouve la même chose sans rien abîmer.
  const faulty = express()
  faulty.use(express.json({ limit: "1mb" }))
  faulty.use(monitorRequests())
  faulty.post("/api/v1/auth/login", () => {
    throw new Error("la base de session est injoignable")
  })
  faulty.post("/api/v1/washes/:id/pay", () => {
    throw new HttpError(500, "boom", "Panne pendant l'encaissement.")
  })
  faulty.get("/api/v1/slow", (_req, res) => {
    setTimeout(() => res.json({ ok: true }), 2100)
  })
  faulty.get("/api/v1/fine", (_req, res) => res.json({ ok: true }))
  faulty.use(apiErrorHandler)
  await new Promise<void>((resolve) => {
    faultyServer = faulty.listen(0, "127.0.0.1", resolve)
  })
  const faultyAddress = faultyServer.address()
  faultyUrl = `http://127.0.0.1:${typeof faultyAddress === "object" && faultyAddress ? faultyAddress.port : 0}`

  await pool.query(
    `INSERT INTO platform_operators(email, password_hash, full_name, status)
     VALUES($1,$2,'Operateur surveillance','active')
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
  await new Promise<void>((resolve) => faultyServer.close(() => resolve()))
  await closeDatabase()
})

// ---------------------------------------------------------------------------
// 1. Le masquage des identifiants
// ---------------------------------------------------------------------------

test("un mot de passe n'est jamais conservé, quelle que soit sa place dans le corps", () => {
  const cases: unknown[] = [
    { email: "demo@washpilot.ci", password: "WashPilot2026!" },
    { currentPassword: "ancien", newPassword: "nouveau" },
    { user: { credentials: { password: "imbriqué" } } },
    { users: [{ name: "Yao", password: "dans-un-tableau" }] },
    { reset_token: "abc", session_token: "def", api_key: "ghi" },
    { Password: "majuscule" },
    { PASSWORD: "capitales" },
    { data: { items: [{ nested: { deep: { password: "profond" } } }] } },
  ]

  for (const input of cases) {
    const serialized = JSON.stringify(redactBody(input))
    for (const leak of [
      "WashPilot2026!",
      "ancien",
      "nouveau",
      "imbriqué",
      "dans-un-tableau",
      "abc",
      "def",
      "ghi",
      "majuscule",
      "capitales",
      "profond",
    ]) {
      assert.ok(
        !serialized.includes(leak),
        `la valeur « ${leak} » a survécu au masquage dans ${serialized}`,
      )
    }
  }
})

test("le masquage garde les champs métier, qui sont la raison d'être de la capture", () => {
  const redacted = redactBody({
    amount_cents: 350000,
    customer_name: "Mme Aya Koffi",
    plate: "1234 AB 01",
    password: "secret",
    services: [{ label: "Lavage complet", price_cents: 250000 }],
  }) as Record<string, unknown>

  // Le corps sert à reproduire un bug : vider tout le reste par précaution
  // reviendrait à ne rien enregistrer du tout.
  assert.equal(redacted.amount_cents, 350000)
  assert.equal(redacted.customer_name, "Mme Aya Koffi")
  assert.equal(redacted.plate, "1234 AB 01")
  assert.equal(redacted.password, REDACTED)
  assert.deepEqual(redacted.services, [{ label: "Lavage complet", price_cents: 250000 }])
})

test("tout champ d'identifiant présent dans le code serveur est reconnu comme sensible", () => {
  // Garde contre la dérive : le jour où une route ajoute un champ
  // `confirmPassword` ou `webhook_secret`, ce test échoue avant la fuite.
  const dir = join(process.cwd(), "server")
  const names = new Set<string>()
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(join(dir, file), "utf-8")
    for (const match of source.matchAll(
      /([A-Za-z_][A-Za-z0-9_]*(?:password|passwd|token|secret|pin|cvv|apikey|api_key)[A-Za-z0-9_]*)\s*:/gi,
    )) {
      names.add(match[1])
    }
  }

  assert.ok(names.size >= 5, `trop peu de champs détectés (${names.size}), la détection est cassée`)
  const missed = [...names].filter((name) => !isSensitiveKey(name))
  assert.deepEqual(missed, [], `champs d'identifiant non masqués : ${missed.join(", ")}`)
})

test("chaque champ de la liste de refus est effectivement masqué", () => {
  // Liste écrite en dur, et c'est volontaire : itérer sur la constante
  // exportée du code serait une tautologie — supprimer une entrée la
  // retirerait aussi du test, qui continuerait à passer. Sept de ces champs
  // ne sont protégés par aucune règle de sous-chaîne, la liste est leur
  // unique défense.
  const protectedKeys = [
    "password", "passwd", "pwd", "current_password", "new_password",
    "password_confirmation", "confirm_password", "pin", "cvv", "card_number",
    "secret", "apikey", "authorization", "cookie",
  ]
  for (const key of protectedKeys) {
    const redacted = redactBody({ [key]: "valeur-confidentielle" }) as Record<string, unknown>
    assert.equal(redacted[key], REDACTED, `le champ « ${key} » n'est pas masqué`)
  }
})

test("le masquage ne déborde pas sur des champs métier qui se ressemblent", () => {
  // Une liste trop gourmande abîmerait le diagnostic sans rien protéger :
  // « pin » ne doit pas emporter « spinning », ni « secret » emporter
  // « secretariat » par un simple préfixe.
  const kept = redactBody({
    spinning: "brossage",
    card_wash: "lavage carte",
    pinceau: "outil",
    cookie_policy_accepted: true,
    token_count: 3,
  }) as Record<string, unknown>
  assert.equal(kept.spinning, "brossage")
  assert.equal(kept.card_wash, "lavage carte")
  assert.equal(kept.pinceau, "outil")
  assert.equal(kept.cookie_policy_accepted, true)
  assert.equal(kept.token_count, 3)
})

test("un corps démesuré est tronqué plutôt que stocké entier", () => {
  const prepared = prepareBody({ note: "x".repeat(50_000) }) as Record<string, unknown>
  assert.equal(prepared._tronque, true)
  assert.ok(String(prepared.apercu).length <= 4100)
})

test("un corps vide ou absent ne crée pas de ligne de bruit", () => {
  assert.equal(prepareBody(undefined), null)
  assert.equal(prepareBody({}), null)
})

test("un corps anormalement imbriqué ne fait pas tomber le gestionnaire d'erreurs", () => {
  // Le masquage s'exécute à l'intérieur du traitement d'une panne : une
  // exception à cet endroit ferait perdre la réponse du client en plus de la
  // trace.
  let deep: Record<string, unknown> = { password: "au-fond" }
  for (let i = 0; i < 200; i += 1) deep = { level: deep }
  const serialized = JSON.stringify(redactBody(deep))
  assert.ok(!serialized.includes("au-fond"))
  assert.ok(serialized.includes("trop profond"))
})

// ---------------------------------------------------------------------------
// 2. La normalisation des routes, et la cardinalité
// ---------------------------------------------------------------------------

test("les identifiants d'un chemin sont remplacés par des marqueurs", () => {
  assert.equal(
    normalizeRoute("/api/v1/washes/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
    "/api/v1/washes/:id",
  )
  assert.equal(normalizeRoute("/api/v1/reports/2026/10"), "/api/v1/reports/:n/:n")
  assert.equal(normalizeRoute("/api/v1/checkout/WP-A1B2C3D4"), "/api/v1/checkout/:ref")
  assert.equal(normalizeRoute("/api/v1/washes?site=abc"), "/api/v1/washes")
  assert.equal(normalizeRoute("/api/v1/washes/"), "/api/v1/washes")
})

test("mille identifiants différents produisent une seule route", () => {
  // Sans cette garantie, la table de supervision grossirait avec le trafic
  // exactement comme les données qu'elle surveille, et aucun taux par route
  // ne serait calculable.
  const routes = new Set<string>()
  for (let i = 0; i < 1000; i += 1) {
    const uuid = `3f2b1c4d-5e6f-4a7b-8c9d-${String(i).padStart(12, "0")}`
    routes.add(normalizeRoute(`/api/v1/washes/${uuid}/payments/${i}`))
  }
  assert.equal(routes.size, 1)
  assert.equal([...routes][0], "/api/v1/washes/:id/payments/:n")
})

test("les tranches de cinq minutes tombent toujours sur un multiple", () => {
  for (const minute of [0, 1, 4, 5, 9, 17, 33, 59]) {
    const d = new Date(Date.UTC(2026, 9, 21, 14, minute, 37, 500))
    const bucket = bucketStart(d)
    assert.equal(bucket.getUTCSeconds(), 0)
    assert.equal(bucket.getUTCMilliseconds(), 0)
    assert.equal(bucket.getUTCMinutes() % 5, 0)
    assert.ok(bucket.getTime() <= d.getTime())
    assert.ok(d.getTime() - bucket.getTime() < 5 * 60 * 1000)
  }
  assert.equal(statusClass(200), "2xx")
  assert.equal(statusClass(404), "4xx")
  assert.equal(statusClass(503), "5xx")
})

// ---------------------------------------------------------------------------
// 3. Des chiffres exacts
// ---------------------------------------------------------------------------

test("le taux d'erreur est un comptage exact, pas une estimation", async () => {
  await pool.query("DELETE FROM request_metrics")
  const at = new Date()
  // 997 succès et 3 pannes : un taux qu'un échantillonnage raterait.
  for (let i = 0; i < 997; i += 1) {
    await recordRequest(pool, { method: "GET", route: "/api/v1/washes", status: 200, durationMs: 10, at })
  }
  for (let i = 0; i < 3; i += 1) {
    await recordRequest(pool, { method: "GET", route: "/api/v1/washes", status: 500, durationMs: 40, at })
  }

  const overview = await monitoringOverview(pool, { hours: 1 })
  assert.equal(overview.totals.requests, 1000)
  assert.equal(overview.totals.server_errors, 3)
  assert.equal(overview.totals.error_rate, 0.3)
  // 1000 requêtes agrégées, mais seulement deux lignes en base : une par
  // classe de statut.
  const rows = await pool.query("SELECT count(*)::int AS n FROM request_metrics")
  assert.equal(rows.rows[0].n, 2)
})

test("la durée moyenne et le maximum sont ceux des requêtes observées", async () => {
  await pool.query("DELETE FROM request_metrics")
  const at = new Date()
  for (const ms of [10, 20, 30, 40, 900]) {
    await recordRequest(pool, { method: "POST", route: "/api/v1/washes", status: 201, durationMs: ms, at })
  }
  const overview = await monitoringOverview(pool, { hours: 1 })
  assert.equal(overview.totals.requests, 5)
  assert.equal(overview.totals.avg_duration_ms, 200) // (10+20+30+40+900)/5
  assert.equal(overview.totals.max_duration_ms, 900)
})

test("une route sans panne n'apparaît pas dans les routes en souffrance", async () => {
  await pool.query("DELETE FROM request_metrics")
  const at = new Date()
  await recordRequest(pool, { method: "GET", route: "/api/v1/sain", status: 200, durationMs: 5, at })
  await recordRequest(pool, { method: "GET", route: "/api/v1/casse", status: 500, durationMs: 5, at })
  const overview = await monitoringOverview(pool, { hours: 1 })
  const routes = overview.failing_routes.map((r: { route: string }) => r.route)
  assert.deepEqual(routes, ["/api/v1/casse"])
})

// ---------------------------------------------------------------------------
// 4. De bout en bout : une panne réelle laisse une trace exploitable
// ---------------------------------------------------------------------------

test("une panne 500 est enregistrée avec sa pile, son corps masqué et sa route", async () => {
  await pool.query("DELETE FROM error_events")

  const response = await fetch(`${faultyUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo@washpilot.ci", password: "WashPilot2026!" }),
  })
  assert.equal(response.status, 500)
  const payload = await response.json()
  // Le client ne voit toujours rien de l'interne : la supervision ne change
  // pas ce qui sort.
  assert.equal(payload.error.code, "internal_error")
  assert.ok(!JSON.stringify(payload).includes("injoignable"))

  await new Promise((r) => setTimeout(r, 300))

  const rows = await pool.query("SELECT * FROM error_events ORDER BY occurred_at DESC")
  assert.equal(rows.rowCount, 1)
  const event = rows.rows[0]
  assert.equal(event.kind, "error")
  assert.equal(event.status, 500)
  assert.equal(event.method, "POST")
  assert.equal(event.route, "/api/v1/auth/login")
  // Le message interne, lui, est bien conservé côté éditeur.
  assert.match(event.message, /injoignable/)
  assert.match(event.stack, /monitoring.test.ts/)
  assert.equal(event.request_body.email, "demo@washpilot.ci")
  assert.equal(event.request_body.password, REDACTED)
})

test("aucun mot de passe en clair ne subsiste nulle part dans la table des incidents", async () => {
  // L'assertion qui compte vraiment : on ne vérifie pas un champ, on fouille
  // la table entière.
  const rows = await pool.query("SELECT request_body::text AS body, message, stack, path FROM error_events")
  for (const row of rows.rows) {
    const haystack = `${row.body ?? ""}${row.message ?? ""}${row.stack ?? ""}${row.path ?? ""}`
    assert.ok(!haystack.includes("WashPilot2026!"), "un mot de passe en clair est présent en base")
  }
})

test("le gabarit de route est enregistré, pas le chemin littéral", async () => {
  await pool.query("DELETE FROM error_events")
  await pool.query("DELETE FROM request_metrics")

  for (const id of ["3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]) {
    const response = await fetch(`${faultyUrl}/api/v1/washes/${id}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_cents: 250000 }),
    })
    assert.equal(response.status, 500)
  }
  await new Promise((r) => setTimeout(r, 300))

  const events = await pool.query("SELECT DISTINCT route FROM error_events")
  assert.equal(events.rowCount, 1, "deux lavages différents ont créé deux routes")
  assert.equal(events.rows[0].route, "/api/v1/washes/:id/pay")

  const metrics = await pool.query("SELECT route, requests FROM request_metrics")
  assert.equal(metrics.rowCount, 1)
  assert.equal(metrics.rows[0].route, "/api/v1/washes/:id/pay")
  assert.equal(Number(metrics.rows[0].requests), 2)
})

test("une requête lente qui réussit est signalée comme lenteur et non comme panne", async () => {
  await pool.query("DELETE FROM error_events")
  const response = await fetch(`${faultyUrl}/api/v1/slow`)
  assert.equal(response.status, 200)
  await new Promise((r) => setTimeout(r, 400))

  const rows = await pool.query("SELECT kind, code, status, duration_ms FROM error_events")
  assert.equal(rows.rowCount, 1)
  assert.equal(rows.rows[0].kind, "slow")
  assert.equal(rows.rows[0].code, "slow_request")
  assert.equal(rows.rows[0].status, 200)
  assert.ok(rows.rows[0].duration_ms >= 2000)
})

test("une requête saine ne laisse aucun incident, seulement un compteur", async () => {
  await pool.query("DELETE FROM error_events")
  await pool.query("DELETE FROM request_metrics")
  const response = await fetch(`${faultyUrl}/api/v1/fine`)
  assert.equal(response.status, 200)
  await new Promise((r) => setTimeout(r, 200))

  const events = await pool.query("SELECT count(*)::int AS n FROM error_events")
  assert.equal(events.rows[0].n, 0)
  const metrics = await pool.query("SELECT status_class, requests FROM request_metrics")
  assert.equal(metrics.rowCount, 1)
  assert.equal(metrics.rows[0].status_class, "2xx")
})

test("la même panne répétée forme un seul groupe", async () => {
  await pool.query("DELETE FROM error_events")
  for (let i = 0; i < 7; i += 1) {
    const response = await fetch(`${faultyUrl}/api/v1/washes/3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount_cents: 1000 }),
    })
    assert.equal(response.status, 500)
  }
  await new Promise((r) => setTimeout(r, 400))

  const response = await consoleReq("/monitoring?hours=1")
  assert.equal(response.status, 200)
  const payload = await response.json()
  const group = payload.error_groups.find((g: { route: string }) => g.route === "/api/v1/washes/:id/pay")
  assert.ok(group, "le groupe est absent")
  // Sept pannes identiques sont un problème, pas sept.
  assert.equal(group.occurrences, 7)
  assert.equal(group.code, "boom")
})

// ---------------------------------------------------------------------------
// 5. La console
// ---------------------------------------------------------------------------

test("la console refuse un visiteur sans session d'opérateur", async () => {
  const response = await fetch(`${baseUrl}/api/v1/console/monitoring`)
  // Refus de console = 404, jamais 403 : la console ne révèle pas son
  // existence.
  assert.equal(response.status, 404)
})

test("ouvrir le corps d'un incident laisse une trace dans le journal de la plateforme", async () => {
  await pool.query("DELETE FROM error_events")
  await recordErrorEvent(pool, {
    method: "POST",
    route: "/api/v1/washes",
    path: "/api/v1/washes",
    status: 500,
    code: "boom",
    message: "panne de test",
    durationMs: 12,
    body: { amount_cents: 500000, password: "jamais-stocke" },
  })
  const row = await pool.query("SELECT id FROM error_events LIMIT 1")
  const id = row.rows[0].id as string

  const before = await pool.query(
    "SELECT count(*)::int AS n FROM platform_audit_logs WHERE action = 'monitoring.error.read'",
  )
  const response = await consoleReq(`/monitoring/errors/${id}`)
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.event.request_body.amount_cents, 500000)
  assert.equal(payload.event.request_body.password, REDACTED)

  const after = await pool.query(
    "SELECT count(*)::int AS n FROM platform_audit_logs WHERE action = 'monitoring.error.read'",
  )
  // Lire des compteurs agrégés n'engage personne ; lire ce qu'un gérant a
  // saisi, si.
  assert.equal(after.rows[0].n, before.rows[0].n + 1)
})

test("la liste de repérage ne transporte ni corps ni pile d'appel", async () => {
  const response = await consoleReq("/monitoring/errors?limit=5")
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.ok(Array.isArray(payload.events))
  for (const event of payload.events) {
    assert.equal(event.request_body, undefined)
    assert.equal(event.stack, undefined)
  }
})

test("un identifiant d'incident mal formé est refusé proprement", async () => {
  const response = await consoleReq("/monitoring/errors/pas-un-uuid")
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, "invalid_id")
})

test("un type d'incident inconnu est refusé", async () => {
  const response = await consoleReq("/monitoring/errors?kind=nimporte")
  assert.equal(response.status, 400)
})

// ---------------------------------------------------------------------------
// 6. La rétention
// ---------------------------------------------------------------------------

test("la purge supprime les enregistrements expirés et garde les récents", async () => {
  await pool.query("DELETE FROM error_events")
  await pool.query("DELETE FROM request_metrics")

  await pool.query(
    `INSERT INTO error_events(kind, method, route, path, status, code, message, occurred_at)
     VALUES('error','GET','/api/v1/vieux','/api/v1/vieux',500,'old','ancien', now() - interval '31 days'),
           ('error','GET','/api/v1/neuf','/api/v1/neuf',500,'new','recent', now() - interval '2 days')`,
  )
  await pool.query(
    `INSERT INTO request_metrics(bucket_start, method, route, status_class, requests)
     VALUES(now() - interval '91 days','GET','/api/v1/vieux','2xx',1),
           (now() - interval '10 days','GET','/api/v1/neuf','2xx',1)`,
  )

  const purged = await purgeMonitoring(pool)
  assert.equal(purged.errors, 1)
  assert.equal(purged.metrics, 1)

  const events = await pool.query("SELECT route FROM error_events")
  assert.deepEqual(
    events.rows.map((r) => r.route),
    ["/api/v1/neuf"],
  )
  const metrics = await pool.query("SELECT route FROM request_metrics")
  assert.deepEqual(
    metrics.rows.map((r) => r.route),
    ["/api/v1/neuf"],
  )
})
