import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"
import { resolveLimitState, DOWNGRADE_GRACE_DAYS } from "../server/plan-limits.ts"

// ---------------------------------------------------------------------------
// Garde-fous par forfait
//
// Trois décisions sont vérifiées ici :
//   1. la grille publique et le catalogue applicatif disent la même chose ;
//   2. le rôle se vérifie avant le forfait, et les deux refus ne se
//      ressemblent pas ;
//   3. une rétrogradation ne détruit ni ne masque jamais de donnée.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool
let orgId: string

const PASSWORD = "WashPilot2026!"
const DAY = 86_400_000
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

/** Place l'organisation sur un forfait, en datant éventuellement le changement. */
async function setPlan(code: string, changedDaysAgo = 0) {
  await pool.query(
    `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code=$2),
       status='active', plan_changed_at = now() - ($3 || ' days')::interval, updated_at=now()
     WHERE organization_id=$1::uuid`,
    [orgId, code, String(changedDaysAgo)],
  )
  invalidateSubscriptionCache(orgId)
}

async function errorCode(response: Response) {
  const payload = await response.json()
  return payload.error?.code as string | undefined
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
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// ===========================================================================
// 1. Vitrine et catalogue applicatif alignés
// ===========================================================================

test("les trois forfaits publics existent en base, au même prix", async () => {
  // La page publique et l'onboarding doivent annoncer le même montant : un
  // visiteur qui voit 10 000 F puis 0 F à l'inscription n'a aucune raison de
  // croire le second chiffre plutôt que le premier.
  const expected = [
    { code: "starter", price_cents: 1_000_000 },
    { code: "pro", price_cents: 2_000_000 },
    { code: "business", price_cents: 3_500_000 },
  ]
  for (const plan of expected) {
    const q = await pool.query("SELECT price_cents, name FROM plans WHERE code=$1", [plan.code])
    assert.equal(q.rowCount, 1, `le forfait ${plan.code} doit exister`)
    assert.equal(Number(q.rows[0].price_cents), plan.price_cents, `prix de ${plan.code}`)
  }
})

test("l'ancien code « free » n'existe plus et n'a pas laissé d'orphelin", async () => {
  const stale = await pool.query("SELECT 1 FROM plans WHERE code='free'")
  assert.equal(stale.rowCount, 0)
  // Le renommage ne doit avoir cassé aucun abonnement : tous pointent encore
  // sur un forfait existant.
  const orphans = await pool.query(
    "SELECT COUNT(*)::int AS n FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id WHERE p.id IS NULL",
  )
  assert.equal(orphans.rows[0].n, 0)
})

test("aucun forfait n'est gratuit : l'essai ne peut plus se décider sur le prix", async () => {
  const q = await pool.query("SELECT COUNT(*)::int AS n FROM plans WHERE price_cents = 0")
  assert.equal(q.rows[0].n, 0)
})

test("l'organisation de démonstration démarre en essai sur Starter", async () => {
  await setPlan("starter")
  await pool.query(
    "UPDATE subscriptions SET status='trialing', current_period_end=now() + interval '11 days' WHERE organization_id=$1::uuid",
    [orgId],
  )
  invalidateSubscriptionCache(orgId)
  const state = await (await api("/api/v1/subscription", { as: "demo@washpilot.ci" })).json()
  assert.equal(state.plan_code, "starter")
  assert.equal(state.status, "trialing")
  assert.equal(state.plan_price_cents, 1_000_000)
  // Un forfait payant en essai : la preuve que l'essai ne dépend plus du prix.
  assert.ok(state.days_remaining > 0)
})

// ===========================================================================
// 2. Cumul rôle × forfait
// ===========================================================================

test("sur Starter, le propriétaire reçoit un refus de forfait, pas de rôle", async () => {
  await setPlan("starter")
  const response = await api("/api/v1/audit-logs", { as: "demo@washpilot.ci" })
  assert.equal(response.status, 402)
  assert.equal(await errorCode(response), "plan_upgrade_required")
})

test("sur Starter, le gérant reçoit exactement le même refus que le propriétaire", async () => {
  // Réponse à la question posée : le forfait ne connaît pas les rôles. Un
  // gérant en Starter ne voit rien de l'historique, et le propriétaire non
  // plus — ce n'est pas une question de personne mais d'abonnement.
  await setPlan("starter")
  const response = await api("/api/v1/audit-logs", { as: "gerant@washpilot.ci" })
  assert.equal(response.status, 402)
  assert.equal(await errorCode(response), "plan_upgrade_required")
})

test("le rôle est évalué avant le forfait : le caissier n'est jamais invité à payer", async () => {
  // Même sur Business, où la fonction est incluse, le caissier reste refusé
  // pour son rôle. Lui répondre « passez au forfait supérieur » l'enverrait
  // réclamer une dépense qui ne lui servirait à rien.
  await setPlan("business")
  const response = await api("/api/v1/audit-logs", { as: "caisse@washpilot.ci" })
  assert.equal(response.status, 403)
  assert.equal(await errorCode(response), "forbidden")
})

test("sur Pro, l'historique s'ouvre au propriétaire et au gérant, pas au caissier", async () => {
  await setPlan("pro")
  assert.equal((await api("/api/v1/audit-logs", { as: "demo@washpilot.ci" })).status, 200)
  assert.equal((await api("/api/v1/audit-logs", { as: "gerant@washpilot.ci" })).status, 200)
  assert.equal((await api("/api/v1/audit-logs", { as: "caisse@washpilot.ci" })).status, 403)
})

test("le regroupement par mois est refusé sur Starter, accepté sur Pro", async () => {
  const path = "/api/v1/reports/summary?from=2026-01-01&to=2026-10-20&granularity=month"
  await setPlan("starter")
  const refused = await api(path, { as: "demo@washpilot.ci" })
  assert.equal(refused.status, 402)
  assert.equal(await errorCode(refused), "plan_upgrade_required")

  await setPlan("pro")
  assert.equal((await api(path, { as: "demo@washpilot.ci" })).status, 200)
})

test("le rapport quotidien reste ouvert sur Starter", async () => {
  // C'est la promesse du forfait d'entrée : elle ne doit jamais être gardée.
  await setPlan("starter")
  const response = await api(
    "/api/v1/reports/summary?from=2026-10-01&to=2026-10-20&granularity=day",
    { as: "demo@washpilot.ci" },
  )
  assert.equal(response.status, 200)
})

test("la vue consolidée est vide hors Business, remplie en Business", async () => {
  const path = "/api/v1/reports/summary?from=2026-10-01&to=2026-10-20"
  await setPlan("pro")
  const pro = await (await api(path, { as: "demo@washpilot.ci" })).json()
  assert.equal(pro.consolidated_access, false)
  assert.deepEqual(pro.by_site, [], "aucune ventilation hors Business")

  await setPlan("business")
  const business = await (await api(path, { as: "demo@washpilot.ci" })).json()
  assert.equal(business.consolidated_access, true)
  assert.ok(business.by_site.length >= 1)
})

// ===========================================================================
// 3. Limites et rétrogradation
// ===========================================================================

test("resolveLimitState : sous la limite, rien n'est restreint", () => {
  const state = resolveLimitState({ limit: 3, activeCount: 2, planChangedAt: new Date() })
  assert.equal(state.over_limit, false)
  assert.equal(state.remaining, 1)
  assert.equal(state.creation_blocked, false)
  assert.equal(state.enforced, false)
})

test("resolveLimitState : une limite atteinte bloque la création sans rien restreindre", () => {
  const state = resolveLimitState({ limit: 3, activeCount: 3, planChangedAt: new Date() })
  assert.equal(state.over_limit, false, "atteindre la limite n'est pas la dépasser")
  assert.equal(state.creation_blocked, true)
  assert.equal(state.enforced, false)
})

test("resolveLimitState : pendant le délai de grâce, l'existant continue de fonctionner", () => {
  const now = new Date()
  const state = resolveLimitState({
    limit: 1,
    activeCount: 3,
    planChangedAt: new Date(now.getTime() - 2 * DAY),
    now,
  })
  assert.equal(state.over_limit, true)
  assert.equal(state.excess, 2)
  assert.equal(state.enforced, false, "rien n'est coupé pendant la grâce")
  assert.equal(state.grace_days_remaining, DOWNGRADE_GRACE_DAYS - 2)
})

test("resolveLimitState : le délai écoulé, l'excédent passe en lecture seule", () => {
  const now = new Date()
  const state = resolveLimitState({
    limit: 1,
    activeCount: 3,
    planChangedAt: new Date(now.getTime() - (DOWNGRADE_GRACE_DAYS + 1) * DAY),
    now,
  })
  assert.equal(state.enforced, true)
  assert.equal(state.grace_days_remaining, 0)
})

test("resolveLimitState : une limite nulle signifie illimité", () => {
  const state = resolveLimitState({ limit: null, activeCount: 999, planChangedAt: null })
  assert.equal(state.over_limit, false)
  assert.equal(state.creation_blocked, false)
  assert.equal(state.remaining, null)
})

test("sur Starter, une deuxième station est refusée", async () => {
  await setPlan("starter")
  const response = await api("/api/v1/sites", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: "Station Yopougon", city: "Abidjan" },
  })
  assert.equal(response.status, 409)
  assert.equal(await errorCode(response), "plan_site_limit")
})

test("sur Business, les stations supplémentaires passent", async () => {
  await setPlan("business")
  for (const name of ["Station Yopougon", "Station Treichville"]) {
    const response = await api("/api/v1/sites", {
      as: "demo@washpilot.ci",
      method: "POST",
      body: { name, city: "Abidjan" },
    })
    assert.equal(response.status, 201, name)
  }
})

test("après rétrogradation, aucune donnée n'est supprimée ni masquée", async () => {
  // La promesse centrale : ce qui a été saisi reste lisible, pour toujours.
  await setPlan("pro", DOWNGRADE_GRACE_DAYS + 1)
  const sites = await (await api("/api/v1/sites", { as: "demo@washpilot.ci" })).json()
  assert.equal(sites.length, 3, "les trois stations restent listées")
  assert.ok(
    sites.every((site: { is_active: boolean }) => site.is_active),
    "aucune station n'a été désactivée d'office",
  )
  // Les lectures restent ouvertes, y compris l'export de sauvegarde.
  assert.equal((await api("/api/v1/washes", { as: "demo@washpilot.ci" })).status, 200)
  assert.equal((await api("/api/v1/backup/export", { as: "demo@washpilot.ci" })).status, 200)
})

test("pendant la grâce, toutes les stations acceptent encore des opérations", async () => {
  await setPlan("pro", 1)
  const sites = await (await api("/api/v1/sites", { as: "demo@washpilot.ci" })).json()
  assert.ok(
    sites.every((site: { writable: boolean }) => site.writable),
    "aucune station ne doit être fermée pendant le délai de grâce",
  )
})

test("le délai écoulé, seules les stations les plus anciennes restent inscriptibles", async () => {
  // Critère déterministe et explicable : la station historique reste. Un
  // critère arbitraire laisserait le gérant découvrir au hasard laquelle de
  // ses caisses ne s'ouvre plus.
  await setPlan("pro", DOWNGRADE_GRACE_DAYS + 1)
  const sites = await (await api("/api/v1/sites", { as: "demo@washpilot.ci" })).json()
  const writable = sites.filter((site: { writable: boolean }) => site.writable)
  assert.equal(writable.length, 1, "le forfait Pro couvre une station")
  assert.equal(writable[0].name, sites[0].name, "la plus ancienne est conservée")
})

test("une station excédentaire refuse une nouvelle opération mais garde son historique", async () => {
  await setPlan("pro", DOWNGRADE_GRACE_DAYS + 1)
  const sites = await (await api("/api/v1/sites", { as: "demo@washpilot.ci" })).json()
  const surplus = sites.find((site: { writable: boolean }) => !site.writable)
  assert.ok(surplus, "une station excédentaire est attendue")

  const response = await api("/api/v1/cash-sessions/open", {
    as: "demo@washpilot.ci",
    method: "POST",
    key: `limit-${Date.now()}`,
    body: { site_id: surplus.id, opening_amount_cents: 0 },
  })
  assert.equal(response.status, 402)
  assert.equal(await errorCode(response), "site_over_plan_limit")

  // Sa fiche reste consultable : la lecture n'est jamais coupée.
  assert.equal(
    (await api(`/api/v1/sites/${surplus.id}`, { as: "demo@washpilot.ci" })).status,
    200,
  )
})

test("réactiver une station ne permet pas de contourner le plafond", async () => {
  await setPlan("pro", DOWNGRADE_GRACE_DAYS + 1)
  const sites = await (await api("/api/v1/sites", { as: "demo@washpilot.ci" })).json()
  const target = sites[2]
  // Désactiver est toujours permis ; réactiver repasse par le plafond.
  const off = await api(`/api/v1/sites/${target.id}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { is_active: false },
  })
  assert.equal(off.status, 200)
  const on = await api(`/api/v1/sites/${target.id}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { is_active: true },
  })
  assert.equal(on.status, 409)
  assert.equal(await errorCode(on), "plan_site_limit")
})

test("revenir à Business rouvre immédiatement toutes les stations", async () => {
  // Une remontée de forfait ne doit jamais demander de manipulation : le
  // client vient de payer, il doit retrouver son outil intact.
  await setPlan("business")
  const sites = await (await api("/api/v1/sites", { as: "demo@washpilot.ci" })).json()
  assert.ok(sites.every((site: { writable: boolean }) => site.writable))
})
