import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { readdir, readFile } from "node:fs/promises"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"

// ---------------------------------------------------------------------------
// Back-office de l'éditeur
//
// C'est la seule surface de l'API qui franchit volontairement l'isolation
// entre clients : elle écrit chez autrui. Les tests portent donc d'abord sur
// le refus, et seulement ensuite sur la fonctionnalité.
//
// Depuis la séparation, l'administration n'est plus un drapeau sur un compte
// de station mais un compte d'opérateur distinct, avec sa propre session et
// son propre cookie. Les tests vérifient d'abord cette étanchéité : une
// session de station ne doit jamais ouvrir la console, et réciproquement.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool
let organizationId: string

const PASSWORD = "WashPilot2026!"
const sessions = new Map<string, string>()

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

async function loginOperator() {
  const response = await fetch(`${baseUrl}/api/v1/console/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD }),
  })
  assert.equal(response.status, 200, "connexion de l'opérateur")
  operatorCookie = response.headers.getSetCookie?.().join("; ") ?? response.headers.get("set-cookie") ?? ""
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

/** Remet l'abonnement de la station de démonstration dans un état connu. */
async function resetSubscription(status: string, planCode: string, daysLeft: number) {
  await pool.query(
    `UPDATE subscriptions
        SET plan_id = (SELECT id FROM plans WHERE code = $2),
            status = $1,
            current_period_end = now() + ($3 || ' days')::interval,
            plan_changed_at = now()
      WHERE organization_id = $4::uuid`,
    [status, planCode, String(daysLeft), organizationId],
  )
  invalidateSubscriptionCache(organizationId)
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

  const org = await pool.query("SELECT id FROM organizations LIMIT 1")
  organizationId = org.rows[0].id

  // Un opérateur de console, sans aucune station : c'est ce que ferait
  // `syncPlatformOperators` au démarrage à partir de PLATFORM_ADMIN_EMAILS.
  // Noter qu'aucun compte de `users` n'est touché — c'est tout l'objet de la
  // séparation.
  const { hashPassword } = await import("../server/auth.ts")
  await pool.query(
    `INSERT INTO platform_operators(email, password_hash, full_name, status)
     VALUES($1, $2, 'Operateur de test', 'active')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'`,
    [OPERATOR_EMAIL, await hashPassword(OPERATOR_PASSWORD)],
  )
  await pool.query("UPDATE users SET platform_admin = false")

  for (const email of ["demo@washpilot.ci", "gerant@washpilot.ci", "caisse@washpilot.ci"]) {
    await login(email)
  }
  await loginOperator()
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// ---------------------------------------------------------------------------
// 1. Le refus d'abord
// ---------------------------------------------------------------------------

test("la console est invisible depuis n'importe quelle session de station", async () => {
  // 404 et non 403 : un 403 confirmerait qu'il y a quelque chose à cette
  // adresse. Pour qui vient d'une station, la console n'existe pas.
  //
  // `demo@washpilot.ci` est inclus à dessein : c'est le compte du créateur de
  // l'application, celui qui PEUT administrer le parc. Sa session de station
  // ne doit pas plus ouvrir la console que celle d'un caissier — c'est tout
  // l'objet de la séparation.
  for (const path of ["/metrics", "/organizations", "/upgrade-requests", "/plans"]) {
    for (const who of ["demo@washpilot.ci", "gerant@washpilot.ci", "caisse@washpilot.ci"]) {
      const response = await console_(path, { cookie: sessions.get(who) ?? "" })
      assert.equal(response.status, 404, `${who} sur ${path}`)
      assert.equal((await response.json()).error.code, "not_found")
    }
  }
})

test("une session de console n'ouvre aucune route de station", async () => {
  // La réciproque. Un cookie d'opérateur ne doit pas valoir session de
  // station : sans quoi l'éditeur pourrait enregistrer des lavages chez un
  // client, et le journal de celui-ci n'y verrait qu'une écriture ordinaire.
  for (const path of ["/api/v1/subscription", "/api/v1/washes", "/api/v1/reports/summary"]) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { Cookie: operatorCookie } })
    assert.equal(response.status, 401, path)
  }
})

test("les identifiants d'une station n'ouvrent pas la console", async () => {
  // Les deux tables de comptes sont disjointes : même le mot de passe du
  // propriétaire de démonstration ne vaut rien ici.
  const response = await fetch(`${baseUrl}/api/v1/console/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "demo@washpilot.ci", password: PASSWORD }),
  })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).error.code, "invalid_credentials")
})

test("un propriétaire de station ne peut pas activer son propre forfait", async () => {
  // Le scénario qui compte : le client a tout intérêt à s'offrir le forfait
  // Business. `subscription:manage` ne doit rien y changer.
  const response = await console_(`/organizations/${organizationId}/activate`, {
    cookie: sessions.get("gerant@washpilot.ci") ?? "",
    method: "POST",
    body: { plan_code: "business", months: 12 },
  })
  assert.equal(response.status, 404)

  const state = await (await api("/api/v1/subscription", { as: "demo@washpilot.ci" })).json()
  assert.notEqual(state.plan_code, "business", "le forfait ne doit pas avoir changé")
})

test("sans session, la console répond 404", async () => {
  // 404 et non 401 : répondre « authentifiez-vous » révélerait qu'il y a
  // quelque chose à authentifier. Seul /console/auth/login est visible.
  assert.equal((await console_("/metrics", { cookie: "" })).status, 404)
})

test("aucune route n'accorde la qualité d'opérateur", async () => {
  // Un opérateur peut être amorcé par PLATFORM_ADMIN_EMAILS ou délégué par un
  // administrateur de la Console. Aucune route de station ne doit toutefois
  // écrire cette table : ce serait une élévation vers toutes les organisations.
  //
  // La garantie se vérifie à la source sur les deux seuls modules autorisés.
  const files = await readdir(new URL("../server/", import.meta.url))
  const writers: string[] = []
  for (const file of files.filter((f) => f.endsWith(".ts"))) {
    const source = await readFile(new URL(`../server/${file}`, import.meta.url), "utf8")
    for (const line of source.split("\n")) {
      if (/platform_operators/.test(line) && /\b(UPDATE|INSERT)\b/.test(line)) {
        writers.push(file)
        break
      }
    }
  }
  assert.deepEqual(
    [...new Set(writers)],
    ["console-auth.ts", "console-operators.ts"],
    "seuls l'amorçage et la gestion admin de la Console peuvent écrire platform_operators",
  )
  const management = await readFile(new URL("../server/console-operators.ts", import.meta.url), "utf8")
  const adminRouter = await readFile(new URL("../server/admin.ts", import.meta.url), "utf8")
  assert.match(adminRouter, /r\.use\("\/operators",\s*requireConsoleAdmin,/)
  assert.doesNotMatch(management, /requireTenantContext|requireSession/)

  // Et à l'exécution : une tentative passée par les routes qui touchent aux
  // comptes ne doit créer aucun opérateur.
  await api("/api/v1/auth/profile", {
    as: "gerant@washpilot.ci",
    method: "PATCH",
    body: { full_name: "Kofi Mensah", platform_admin: true },
  })
  const q = await pool.query("SELECT count(*)::int AS n FROM platform_operators WHERE email = 'gerant@washpilot.ci'")
  assert.equal(q.rows[0].n, 0)
})

test("l'ancien drapeau platform_admin n'autorise plus rien", async () => {
  // Reposé en base comme s'il subsistait d'une version antérieure. Il ne doit
  // plus rien ouvrir : la console ne lit que `platform_operators`. Sans ce
  // test, un reliquat en production rouvrirait silencieusement la porte que
  // la séparation vient de fermer.
  await pool.query("UPDATE users SET platform_admin = true WHERE email = 'demo@washpilot.ci'")
  try {
    const response = await console_("/metrics", { cookie: sessions.get("demo@washpilot.ci") ?? "" })
    assert.equal(response.status, 404)
  } finally {
    await pool.query("UPDATE users SET platform_admin = false")
  }
})

// ---------------------------------------------------------------------------
// 2. L'activation — la marche qui manquait
// ---------------------------------------------------------------------------

test("l'administrateur active un forfait payant, et la capacité suit", async () => {
  await resetSubscription("trialing", "starter", 3)

  // En Starter, l'historique est refusé par le forfait.
  assert.equal((await api("/api/v1/audit-logs", { as: "demo@washpilot.ci" })).status, 402)

  const response = await console_(`/organizations/${organizationId}/activate`, {method: "POST",
    body: { plan_code: "pro", months: 3, payment_reference: "WAVE-884213" },
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.plan_code, "pro")
  assert.equal(result.status, "active")

  // L'effet doit être réel côté client, pas seulement en base.
  const state = await (await api("/api/v1/subscription", { as: "demo@washpilot.ci" })).json()
  assert.equal(state.plan_code, "pro")
  assert.equal(state.status, "active")
  assert.equal(state.read_only, false)
  assert.equal((await api("/api/v1/audit-logs", { as: "demo@washpilot.ci" })).status, 200)
})

test("l'activation est inscrite au journal de la station, pas ailleurs", async () => {
  // Le propriétaire doit pouvoir constater l'intervention chez lui : une
  // action de l'éditeur invisible du client serait une porte dérobée.
  const logs = await (
    await api("/api/v1/audit-logs?action=subscription.activated", { as: "demo@washpilot.ci" })
  ).json()
  assert.ok(logs.entries.length > 0, "l'activation figure dans l'historique du client")
  const entry = logs.entries[0]
  assert.equal(entry.metadata.by, "platform_admin")
  assert.equal(entry.metadata.plan_code, "pro")
  assert.equal(entry.metadata.payment_reference, "WAVE-884213")
})

test("un renouvellement anticipé ne fait pas perdre les jours payés", async () => {
  await resetSubscription("active", "pro", 20)
  const before = await (
    await console_(`/organizations/${organizationId}`)
  ).json()
  const previousEnd = new Date(before.organization.current_period_end).getTime()

  await console_(`/organizations/${organizationId}/activate`, {method: "POST",
    body: { plan_code: "pro", months: 1 },
  })

  const after = await (
    await console_(`/organizations/${organizationId}`)
  ).json()
  const newEnd = new Date(after.organization.current_period_end).getTime()
  assert.ok(
    newEnd > previousEnd + 25 * 86_400_000,
    "le mois ajouté doit partir de l'échéance en cours, pas d'aujourd'hui",
  )
})

test("activer un forfait inconnu est refusé", async () => {
  const response = await console_(`/organizations/${organizationId}/activate`, {method: "POST",
    body: { plan_code: "platine", months: 1 },
  })
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, "plan_not_found")
})

// ---------------------------------------------------------------------------
// 3. Suspension et geste commercial
// ---------------------------------------------------------------------------

test("la suspension passe la station en lecture seule sans rien détruire", async () => {
  await resetSubscription("active", "pro", 30)

  const response = await console_(`/organizations/${organizationId}/suspend`, {method: "POST",
    body: { reason: "Impayé : deux relances sans réponse" },
  })
  assert.equal(response.status, 200)

  const state = await (await api("/api/v1/subscription", { as: "demo@washpilot.ci" })).json()
  assert.equal(state.read_only, true)

  // Lecture et export restent ouverts : on suspend un service, on ne retient
  // pas les données d'un client.
  assert.equal((await api("/api/v1/washes", { as: "demo@washpilot.ci" })).status, 200)
  assert.equal((await api("/api/v1/backup/export", { as: "demo@washpilot.ci" })).status, 200)
})

test("un motif est exigé pour suspendre", async () => {
  const response = await console_(`/organizations/${organizationId}/suspend`, {method: "POST",
    body: { reason: "x" },
  })
  assert.equal(response.status, 400)
})

test("prolonger un essai échu repart d'aujourd'hui", async () => {
  await resetSubscription("trialing", "starter", -5)

  const response = await console_(`/organizations/${organizationId}/extend-trial`, {method: "POST",
    body: { days: 7, reason: "Installation retardée, matériel non livré" },
  })
  assert.equal(response.status, 200)

  const state = await (await api("/api/v1/subscription", { as: "demo@washpilot.ci" })).json()
  assert.equal(state.status, "trialing")
  assert.equal(state.read_only, false)
  // 7 jours pleins, et non 2 (7 ajoutés à une échéance vieille de 5 jours).
  assert.ok(
    state.days_remaining >= 6 && state.days_remaining <= 7,
    `essai relancé à 7 jours, reçu ${state.days_remaining}`,
  )
})

test("prolonger l'essai d'un forfait payant est refusé", async () => {
  // Le repasser en essai effacerait ce que le client a payé.
  await resetSubscription("active", "business", 60)

  const response = await console_(`/organizations/${organizationId}/extend-trial`, {method: "POST",
    body: { days: 30, reason: "Geste commercial" },
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, "subscription_active")

  const state = await (await api("/api/v1/subscription", { as: "demo@washpilot.ci" })).json()
  assert.equal(state.plan_code, "business")
  assert.equal(state.status, "active")
})

// ---------------------------------------------------------------------------
// 4. Le parc
// ---------------------------------------------------------------------------

test("la liste du parc montre l'état effectif, pas le statut stocké", async () => {
  // Un essai dont l'échéance est passée vaut « expired » pour l'application.
  // Le back-office doit dire la même chose : deux vérités divergentes seraient
  // pires que pas de back-office du tout.
  await resetSubscription("trialing", "starter", -1)

  const data = await (
    await console_("/organizations")
  ).json()
  const organization = data.organizations.find(
    (o: { id: string }) => o.id === organizationId,
  )
  assert.equal(organization.stored_status, "trialing")
  assert.equal(organization.status, "expired")
  assert.equal(organization.read_only, true)
})

test("une échéance dépassée est signalée, jamais coupée d'office", async () => {
  await resetSubscription("active", "pro", -10)

  const metrics = await (await console_("/metrics")).json()
  assert.ok(metrics.past_due >= 1, "l'échéance dépassée remonte dans les indicateurs")

  const data = await (
    await console_("/organizations?status=past_due")
  ).json()
  const organization = data.organizations.find((o: { id: string }) => o.id === organizationId)
  assert.ok(organization, "la station apparaît dans le filtre « échéance dépassée »")
  assert.equal(organization.past_due, true)
  assert.ok(organization.days_past_due >= 9)

  // Mais le client écrit toujours : la décision de couper revient à un humain.
  const state = await (await api("/api/v1/subscription", { as: "demo@washpilot.ci" })).json()
  assert.equal(state.read_only, false)
})

test("le revenu mensuel ne compte que les forfaits réellement actifs", async () => {
  await resetSubscription("active", "pro", 30)
  const active = await (await console_("/metrics")).json()
  assert.equal(active.mrr_cents, 2_000_000, "Pro à 20 000 F")

  await resetSubscription("trialing", "business", 10)
  const trial = await (await console_("/metrics")).json()
  assert.equal(trial.mrr_cents, 0, "un essai ne rapporte rien")
})

// ---------------------------------------------------------------------------
// 5. Répondre aux demandes : valider ou décliner
// ---------------------------------------------------------------------------

/** Dépose une demande d'activation comme le ferait un client. */
async function requestUpgrade(planCode: string) {
  const response = await api("/api/v1/support/upgrade-request", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { plan_code: planCode, note: "Je veux passer au forfait supérieur" },
  })
  assert.ok(response.ok, `demande déposée (${response.status})`)
}

test("une demande déclinée cesse d'être en attente", async () => {
  await resetSubscription("trialing", "starter", 5)
  const before = await (await console_("/metrics")).json()

  await requestUpgrade("pro")
  const during = await (await console_("/metrics")).json()
  assert.equal(during.pending_requests, before.pending_requests + 1)

  const list = await (
    await console_("/upgrade-requests")
  ).json()
  const request = list.requests[0]

  const response = await console_(`/upgrade-requests/${request.id}/decline`, {method: "POST",
    body: { reason: "Paiement non reçu à ce jour" },
  })
  assert.equal(response.status, 200)

  // Le compteur retombe : sans cela, le tableau de bord accumulerait un
  // décompte que plus personne ne regarderait.
  const after = await (await console_("/metrics")).json()
  assert.equal(after.pending_requests, before.pending_requests)
})

test("un refus ne touche pas à l'abonnement de la station", async () => {
  await resetSubscription("trialing", "starter", 9)
  await requestUpgrade("business")
  const list = await (
    await console_("/upgrade-requests")
  ).json()

  await console_(`/upgrade-requests/${list.requests[0].id}/decline`, {method: "POST",
    body: { reason: "Doublon" },
  })

  const state = await (await api("/api/v1/subscription", { as: "demo@washpilot.ci" })).json()
  assert.equal(state.plan_code, "starter")
  assert.equal(state.status, "trialing")
  assert.equal(state.read_only, false)
})

test("le client voit le refus dans son propre historique", async () => {
  await resetSubscription("active", "pro", 30) // pour que audit:read soit permis
  const logs = await (
    await api("/api/v1/audit-logs?action=subscription.request_declined", {
      as: "demo@washpilot.ci",
    })
  ).json()
  assert.ok(logs.entries.length > 0, "le refus est inscrit chez le client")
  assert.equal(logs.entries[0].metadata.by, "platform_admin")
  assert.ok(logs.entries[0].metadata.reason.length > 0, "le motif est conservé")
})

test("décliner une demande inexistante répond 404", async () => {
  const response = await console_("/upgrade-requests/00000000-0000-0000-0000-000000000000/decline", {method: "POST", body: { reason: "Essai" } },
  )
  assert.equal(response.status, 404)
})

test("le refus reste réservé à l'éditeur", async () => {
  const response = await console_(
    "/upgrade-requests/00000000-0000-0000-0000-000000000000/decline",
    { cookie: sessions.get("gerant@washpilot.ci") ?? "", method: "POST", body: { reason: "Essai" } },
  )
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, "not_found")
})

// ---------------------------------------------------------------------------
// 6. L'éditeur n'est pas un client
//
// Le créateur de l'application n'exploite pas forcément de station. Rien ne
// doit lui imposer d'en configurer une — ni côté serveur, ni côté interface.
// ---------------------------------------------------------------------------

test("le back-office répond même si la station de l'éditeur n'est pas configurée", async () => {
  // Les routes /admin sont montées avant requireTenantContext : elles ne
  // parlent pas d'une station, elles parlent du parc. Une organisation non
  // configurée ne doit donc rien bloquer.
  await pool.query("UPDATE organizations SET onboarding_completed = false WHERE id = $1::uuid", [
    organizationId,
  ])
  try {
    const response = await console_("/metrics")
    assert.equal(response.status, 200)
    assert.ok(typeof (await response.json()).total === "number")
  } finally {
    await pool.query("UPDATE organizations SET onboarding_completed = true WHERE id = $1::uuid", [
      organizationId,
    ])
  }
})

test("l'application cliente ne mentionne nulle part la console", async () => {
  // Le contrôle qui compte vraiment pour « le back-office ne doit pas être
  // accessible via une station » : pas un lien, pas une route, pas une
  // mention dans tout `src/` hors du dossier de la console.
  //
  // Un test statique parce qu'un lien se réintroduit par inadvertance — le
  // précédent vivait dans le menu de l'avatar, où personne ne pensait à le
  // chercher.
  const offenders: string[] = []
  async function walk(dir: URL, relative: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir)
      const path = `${relative}${entry.name}`
      if (relative === "" && entry.name === "console") continue
      if (entry.isDirectory()) {
        await walk(child, `${path}/`)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      const source = await readFile(child, "utf8")
      if (/["'`]\/console/.test(source) || /platformAdmin/.test(source)) offenders.push(path)
    }
  }
  await walk(new URL("../src/", import.meta.url), "")

  // `App.tsx` monte la branche : c'est la seule mention légitime.
  assert.deepEqual(offenders, ["App.tsx"], "aucun écran de station ne doit désigner la console")
})

test("la console est montée hors de la racine de l'application cliente", async () => {
  // Si elle était un enfant de `RootLayout`, elle hériterait de la garde de
  // session des stations : une session absente renverrait vers
  // /auth/sign-in, et une session de station laisserait croire à une entrée
  // légitime.
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8")
  const consoleBranch = source.indexOf('path: "/console"')
  const rootBranch = source.indexOf("<RootLayout />")
  assert.ok(consoleBranch > 0, "la branche /console doit exister")
  assert.ok(
    consoleBranch < rootBranch,
    "la branche /console doit être soeur de RootLayout, déclarée avant lui",
  )
  assert.doesNotMatch(
    source.slice(rootBranch),
    /console/i,
    "RootLayout ne doit contenir aucune route de console",
  )
})
