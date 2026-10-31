import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { createSession, hashPassword } from "../server/auth.ts"

// ---------------------------------------------------------------------------
// Le registre d'assistance
//
// Deux choses sont réellement en jeu ici :
//
//   1. **Les notes internes ne doivent jamais atteindre le client.** Une fuite
//      serait un désastre de confiance, pire que l'absence de la
//      fonctionnalité. Le test correspondant est le premier du fichier.
//
//   2. **L'engagement de délai doit être mesuré honnêtement.** Si une note
//      interne ou un message du client pouvait éteindre le compteur, l'éditeur
//      tiendrait sa promesse en se parlant à lui-même.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool

const OPERATOR_EMAIL = "ops-assistance@washpilot.ci"
const OPERATOR_PASSWORD = "ConsoleSecret2026!"
const USER_PASSWORD = "WashPilot2026!"
let operatorCookie = ""

let seq = 0

async function consoleReq(path: string, options: { method?: string; body?: unknown } = {}) {
  return fetch(`${baseUrl}/api/v1/console${path}`, {
    method: options.method ?? "GET",
    headers: { "Content-Type": "application/json", Cookie: operatorCookie },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

async function clientReq(
  token: string,
  path: string,
  options: { method?: string; body?: unknown } = {},
) {
  return fetch(`${baseUrl}/api/v1${path}`, {
    method: options.method ?? "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

/** Une station avec son propriétaire connecté, sur le forfait demandé. */
async function station(planCode: string | null) {
  seq += 1
  const orgQ = await pool.query(
    "INSERT INTO organizations(name, slug, onboarding_completed) VALUES($1,$2,true) RETURNING id",
    [`Station ${planCode ?? "essai"} ${seq}`, `sup-${planCode ?? "trial"}-${seq}`],
  )
  const organizationId = orgQ.rows[0].id as string

  if (planCode) {
    await pool.query(
      `INSERT INTO subscriptions(organization_id, plan_id, status, current_period_end)
       VALUES($1,(SELECT id FROM plans WHERE code=$2),'active', now() + interval '60 days')`,
      [organizationId, planCode],
    )
  } else {
    // L'essai n'a pas de colonne dediee : sa fin est portee par
    // `current_period_end`, comme pour un abonnement payant.
    await pool.query(
      `INSERT INTO subscriptions(organization_id, plan_id, status, current_period_end)
       VALUES($1,(SELECT id FROM plans WHERE code='starter'),'trialing', now() + interval '10 days')`,
      [organizationId],
    )
  }

  return { organizationId, member: (role: string) => addMember(organizationId, role) }
}

async function addMember(organizationId: string, role: string) {
  seq += 1
  const email = `sup-${role}-${seq}@exemple.ci`
  const userQ = await pool.query(
    `INSERT INTO users(email, password_hash, first_name, last_name, status)
     VALUES($1,$2,'Yao','Konan','active') RETURNING id`,
    [email, await hashPassword(USER_PASSWORD)],
  )
  const userId = userQ.rows[0].id as string
  await pool.query(
    "INSERT INTO organization_members(organization_id, user_id, role, status) VALUES($1,$2,$3,'active')",
    [organizationId, userId, role],
  )
  // Session créée directement plutôt que par `POST /auth/login` : ce fichier
  // ouvre une soixantaine de comptes et le limiteur de débit de la connexion
  // répondait 429 en fin de suite. Le parcours de connexion est couvert par
  // `auth.test.ts` ; le marteler ici ne prouverait rien de plus.
  const token = await createSession(pool, userId)
  return { userId, email, token }
}

/** Ouvre une demande et renvoie son identifiant. */
async function openRequest(token: string, subject = "La caisse ne se ferme pas") {
  const response = await clientReq(token, "/support/requests", {
    method: "POST",
    body: {
      subject,
      category: "technique",
      body: "Quand je clique sur fermer la caisse, rien ne se passe et la page reste figée.",
    },
  })
  const payload = await response.json()
  assert.equal(response.status, 201, JSON.stringify(payload))
  return payload.request as { id: string; commitment_hours: number; response_due_at: string }
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
     VALUES($1,$2,'Operateur assistance','active')
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
// 1. L'étanchéité des notes internes
// ---------------------------------------------------------------------------

test("une note interne n'atteint jamais le client, par aucun chemin", async () => {
  const s = await station("pro")
  const owner = await s.member("owner")
  const request = await openRequest(owner.token)

  const secret = "NOTE-INTERNE-QUI-NE-DOIT-JAMAIS-SORTIR"
  const noted = await consoleReq(`/support/${request.id}/messages`, {
    method: "POST",
    body: { body: secret, internal: true },
  })
  const noteResult = await noted.json()
  assert.equal(noted.status, 201, JSON.stringify(noteResult))
  assert.equal(noteResult.notification.in_app, false)
  assert.equal(noteResult.notification.email_delivered, false)
  const silent = await pool.query(
    "SELECT count(*)::int AS n FROM notifications WHERE entity_type = 'support_request' AND entity_id = $1::uuid",
    [request.id],
  )
  assert.equal(silent.rows[0].n, 0, "une note interne ne crée aucune notification client")

  // Chemin 1 : le fil de la demande.
  const detail = await (await clientReq(owner.token, `/support/requests/${request.id}`)).text()
  assert.ok(!detail.includes(secret), "la note fuit par le fil")

  // Chemin 2 : la liste des demandes.
  const list = await (await clientReq(owner.token, "/support/requests")).text()
  assert.ok(!list.includes(secret), "la note fuit par la liste")

  // Chemin 3 : le compteur de messages ne doit pas la compter non plus,
  // sinon le client voit qu'il existe un message qu'on lui cache.
  const payload = await (await clientReq(owner.token, `/support/requests/${request.id}`)).json()
  assert.equal(payload.request.message_count, 1, "seul son propre message est compté")
  assert.equal(payload.messages.length, 1)

  // Mais l'opérateur, lui, la voit.
  const operatorView = await (await consoleReq(`/support/${request.id}`)).json()
  assert.ok(
    (operatorView.messages as Array<{ body: string }>).some((m) => m.body === secret),
    "l'opérateur doit voir sa propre note",
  )
})

test("une note interne n'éteint pas le compteur d'engagement", async () => {
  // Sans cette règle, l'éditeur tiendrait sa promesse en se parlant à lui-même.
  const s = await station("pro")
  const owner = await s.member("owner")
  const request = await openRequest(owner.token)

  await consoleReq(`/support/${request.id}/messages`, {
    method: "POST",
    body: { body: "Client déjà vu la semaine dernière, même sujet.", internal: true },
  })

  const row = await pool.query(
    "SELECT first_responded_at, status FROM support_requests WHERE id = $1::uuid",
    [request.id],
  )
  assert.equal(row.rows[0].first_responded_at, null, "le compteur tourne encore")
  assert.equal(row.rows[0].status, "open")
})

// ---------------------------------------------------------------------------
// 2. L'engagement de délai
// ---------------------------------------------------------------------------

test("chaque forfait reçoit l'engagement qu'il a acheté", async () => {
  for (const [plan, hours] of [
    ["business", 4],
    ["pro", 10],
    ["starter", 30],
  ] as const) {
    const s = await station(plan)
    const owner = await s.member("owner")
    const request = await openRequest(owner.token)
    assert.equal(request.commitment_hours, hours, `forfait ${plan}`)
  }
})

test("un essai reçoit un délai indicatif, pas un engagement", async () => {
  const s = await station(null)
  const owner = await s.member("owner")
  const request = await openRequest(owner.token)
  assert.equal(request.commitment_hours, 50)

  const config = await (await clientReq(owner.token, "/support/config")).json()
  assert.equal(config.commitment.guaranteed, false, "rien n'a été acheté, rien n'est promis")
})

test("l'engagement reste celui du forfait en vigueur au dépôt", async () => {
  // Le client rétrograde après avoir écrit : la promesse faite tient.
  const s = await station("business")
  const owner = await s.member("owner")
  const request = await openRequest(owner.token)
  assert.equal(request.commitment_hours, 4)

  await pool.query(
    "UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code='starter') WHERE organization_id = $1::uuid",
    [s.organizationId],
  )

  const after = await (await clientReq(owner.token, `/support/requests/${request.id}`)).json()
  assert.equal(after.request.commitment_hours, 4, "l'engagement a été figé")
  assert.equal(after.request.plan_code, "business")
})

test("une réponse publique arrête le compteur et change l'état", async () => {
  const s = await station("pro")
  const owner = await s.member("owner")
  const request = await openRequest(owner.token)

  const replied = await consoleReq(`/support/${request.id}/messages`, {
    method: "POST",
    body: { body: "Bonjour, pouvez-vous me dire quel navigateur vous utilisez ?" },
  })
  assert.equal(replied.status, 201)
  const payload = await replied.json()
  assert.equal(payload.request.status, "answered")
  assert.equal(payload.request.sla.responded, true)
  assert.ok(payload.request.first_responded_at, "l'instant de première réponse est posé")
})

test("une réponse publique notifie le seul demandeur et l'envoie vers son ticket", async () => {
  const s = await station("pro")
  const requester = await s.member("owner")
  const otherOwner = await s.member("owner")
  const request = await openRequest(requester.token, "Notification de réponse")

  const replied = await consoleReq(`/support/${request.id}/messages`, {
    method: "POST",
    body: { body: "La correction est disponible, vous pouvez rouvrir la caisse." },
  })
  const result = await replied.json()
  assert.equal(replied.status, 201, JSON.stringify(result))
  assert.equal(result.notification.in_app, true)
  assert.equal(result.notification.email_configured, false)
  assert.equal(result.notification.email_delivered, false, "l'absence de Resend n'annule pas la réponse")

  const persisted = await pool.query(
    `SELECT user_id, type, title, message FROM notifications
     WHERE entity_type = 'support_request' AND entity_id = $1::uuid`,
    [request.id],
  )
  assert.equal(persisted.rowCount, 1)
  assert.equal(persisted.rows[0].user_id, requester.userId)
  assert.equal(persisted.rows[0].type, "SUPPORT_REPLY")
  assert.match(persisted.rows[0].message, /Operateur assistance/)

  const bell = await (await clientReq(requester.token, "/notifications")).json()
  const mine = bell.notifications.find((item: { entity_id: string }) => item.entity_id === request.id)
  assert.equal(mine.entity_type, "support_request")
  assert.ok(bell.unread_count >= 1)

  const otherBell = await (await clientReq(otherOwner.token, "/notifications")).json()
  assert.ok(!otherBell.notifications.some((item: { entity_id: string }) => item.entity_id === request.id))
})

test("une relance du client remet la demande en attente", async () => {
  const s = await station("pro")
  const owner = await s.member("owner")
  const request = await openRequest(owner.token)
  await consoleReq(`/support/${request.id}/messages`, {
    method: "POST",
    body: { body: "Pouvez-vous préciser ?" },
  })

  const relance = await clientReq(owner.token, `/support/requests/${request.id}/messages`, {
    method: "POST",
    body: { body: "J'utilise Chrome sur Android, et le bouton ne réagit pas." },
  })
  assert.equal(relance.status, 201)
  assert.equal((await relance.json()).request.status, "open", "la balle revient à l'éditeur")
})

test("la première réponse ne se réécrit pas à la deuxième", async () => {
  const s = await station("pro")
  const owner = await s.member("owner")
  const request = await openRequest(owner.token)
  await consoleReq(`/support/${request.id}/messages`, { method: "POST", body: { body: "Première." } })
  const first = (
    await pool.query("SELECT first_responded_at FROM support_requests WHERE id=$1::uuid", [
      request.id,
    ])
  ).rows[0].first_responded_at

  await consoleReq(`/support/${request.id}/messages`, { method: "POST", body: { body: "Deuxième." } })
  const second = (
    await pool.query("SELECT first_responded_at FROM support_requests WHERE id=$1::uuid", [
      request.id,
    ])
  ).rows[0].first_responded_at
  assert.deepEqual(second, first, "la première réponse reste la première")
})

// ---------------------------------------------------------------------------
// 3. La file de l'éditeur
// ---------------------------------------------------------------------------

test("la file place le Business devant le Starter arrivé plus tôt", async () => {
  // C'est ici que « assistance prioritaire » cesse d'être un argument
  // commercial : aucune règle de tri spéciale, l'échéance ordonne seule.
  const starterStation = await station("starter")
  const starterOwner = await starterStation.member("owner")
  const vieux = await openRequest(starterOwner.token, "Starter arrivé en premier")

  const businessStation = await station("business")
  const businessOwner = await businessStation.member("owner")
  const recent = await openRequest(businessOwner.token, "Business arrivé après")

  const queue = (await (await consoleReq("/support")).json()).requests as Array<{ id: string }>
  const posStarter = queue.findIndex((q) => q.id === vieux.id)
  const posBusiness = queue.findIndex((q) => q.id === recent.id)
  assert.ok(posStarter >= 0 && posBusiness >= 0, "les deux sont dans la file")
  assert.ok(posBusiness < posStarter, "le Business passe devant")
})

test("la file compte les demandes en retard", async () => {
  const s = await station("business")
  const owner = await s.member("owner")
  const request = await openRequest(owner.token)
  // On fait vieillir l'échéance plutôt que d'attendre quatre heures.
  await pool.query(
    "UPDATE support_requests SET response_due_at = now() - interval '2 hours' WHERE id = $1::uuid",
    [request.id],
  )

  const payload = await (await consoleReq("/support")).json()
  assert.ok(payload.totals.breached >= 1, "le retard est compté")
  const mine = (payload.requests as Array<{ id: string; sla: { breached: boolean } }>).find(
    (q) => q.id === request.id,
  )
  assert.equal(mine?.sla.breached, true)
})

test("une demande résolue quitte la file", async () => {
  const s = await station("pro")
  const owner = await s.member("owner")
  const request = await openRequest(owner.token)

  const closed = await consoleReq(`/support/${request.id}/status`, {
    method: "POST",
    body: { status: "resolved" },
  })
  assert.equal(closed.status, 200)
  assert.equal((await closed.json()).request.status, "resolved")

  const queue = (await (await consoleReq("/support")).json()).requests as Array<{ id: string }>
  assert.ok(!queue.some((q) => q.id === request.id), "elle n'encombre plus la file")
})

// ---------------------------------------------------------------------------
// 4. Qui voit quoi, côté client
// ---------------------------------------------------------------------------

test("un caissier ne lit pas la demande d'un collègue", async () => {
  // Une demande peut parler d'un écart de caisse : la mettre sous les yeux de
  // toute l'équipe serait indélicat.
  const s = await station("pro")
  await s.member("owner")
  const premier = await s.member("cashier")
  const second = await s.member("cashier")
  const request = await openRequest(premier.token, "Écart de caisse inexpliqué")

  const refus = await clientReq(second.token, `/support/requests/${request.id}`)
  assert.equal(refus.status, 404, "introuvable, et non interdite")

  const sienne = await clientReq(premier.token, `/support/requests/${request.id}`)
  assert.equal(sienne.status, 200)
})

test("le propriétaire voit les demandes de toute la station", async () => {
  const s = await station("pro")
  const owner = await s.member("owner")
  const cashier = await s.member("cashier")
  const request = await openRequest(cashier.token, "Demande du caissier")

  const vue = await clientReq(owner.token, `/support/requests/${request.id}`)
  assert.equal(vue.status, 200)

  const liste = await (await clientReq(owner.token, "/support/requests")).json()
  assert.equal(liste.scope, "station")
  assert.ok((liste.requests as Array<{ id: string }>).some((q) => q.id === request.id))
})

test("une demande d'une autre station est introuvable", async () => {
  const a = await station("pro")
  const b = await station("pro")
  const ownerA = await a.member("owner")
  const ownerB = await b.member("owner")
  const request = await openRequest(ownerA.token)

  const response = await clientReq(ownerB.token, `/support/requests/${request.id}`)
  assert.equal(response.status, 404)
})

test("une demande vide ou bâclée est refusée", async () => {
  const s = await station("pro")
  const owner = await s.member("owner")
  const response = await clientReq(owner.token, "/support/requests", {
    method: "POST",
    body: { subject: "bug", category: "technique", body: "ça marche pas" },
  })
  assert.equal(response.status, 400)
  const message = (await response.json()).error.message as string
  assert.match(message, /Résumez|Décrivez/)
})

// ---------------------------------------------------------------------------
// 5. Le diagnostic
// ---------------------------------------------------------------------------

test("le diagnostic nomme la cause quand le compte est bloqué", async () => {
  const s = await station("pro")
  const owner = await s.member("owner")
  const cashier = await s.member("cashier")
  await pool.query("UPDATE users SET status='inactive' WHERE id=$1::uuid", [cashier.userId])

  const payload = await (
    await consoleReq(`/organizations/${s.organizationId}/members/${cashier.userId}/diagnostic`)
  ).json()
  assert.equal(payload.blockers[0].cause, "compte_bloque")
  assert.ok(owner.userId)
})

test("le diagnostic nomme la cause quand l'abonnement est en lecture seule", async () => {
  const s = await station(null)
  const owner = await s.member("owner")
  await pool.query(
    "UPDATE subscriptions SET current_period_end = now() - interval '3 days' WHERE organization_id=$1::uuid",
    [s.organizationId],
  )

  const payload = await (
    await consoleReq(`/organizations/${s.organizationId}/members/${owner.userId}/diagnostic`)
  ).json()
  assert.equal(payload.subscription.read_only, true)
  assert.ok(
    (payload.blockers as Array<{ cause: string }>).some(
      (b) => b.cause === "abonnement_en_lecture_seule",
    ),
  )
})

test("le diagnostic signale un plafond de forfait atteint", async () => {
  // « Je ne peux pas ajouter d'utilisateur » vient presque toujours d'ici.
  const s = await station("starter") // 2 utilisateurs
  const owner = await s.member("owner")
  await s.member("cashier")

  const payload = await (
    await consoleReq(`/organizations/${s.organizationId}/members/${owner.userId}/diagnostic`)
  ).json()
  const users = (payload.limits as Array<{ key: string; used: number; max: number; reached: boolean }>).find(
    (l) => l.key === "users",
  )
  assert.equal(users?.used, 2)
  assert.equal(users?.max, 2)
  assert.equal(users?.reached, true)
  assert.ok((payload.blockers as Array<{ cause: string }>).some((b) => b.cause === "plafond_users"))
})

test("le diagnostic distingue un droit du rôle d'une exception accordée", async () => {
  const s = await station("pro")
  const owner = await s.member("owner")
  const cashier = await s.member("cashier")
  await pool.query(
    `INSERT INTO member_permissions(organization_id, user_id, permission, granted)
     VALUES($1,$2,'report:export',true)`,
    [s.organizationId, cashier.userId],
  )

  const payload = await (
    await consoleReq(`/organizations/${s.organizationId}/members/${cashier.userId}/diagnostic`)
  ).json()
  const granted = payload.permissions.granted as Array<{ permission: string; source: string }>
  assert.equal(
    granted.find((p) => p.permission === "report:export")?.source,
    "exception",
    "accordée à la personne, pas au rôle",
  )
  assert.equal(
    granted.find((p) => p.permission === "wash:create")?.source,
    "role",
    "héritée du rôle caissier",
  )
  assert.ok(owner.userId)
})

test("un membre en règle n'a aucune cause de blocage", async () => {
  const s = await station("pro")
  const owner = await s.member("owner")
  const payload = await (
    await consoleReq(`/organizations/${s.organizationId}/members/${owner.userId}/diagnostic`)
  ).json()
  assert.deepEqual(payload.blockers, [], "rien ne bloque, et on le dit clairement")
})

test("le diagnostic ne laisse échapper aucun montant", async () => {
  // La limite posée : expliquer des blocages, pas ouvrir la comptabilité.
  // Contrôle structurel plutôt que relecture — une évolution future qui
  // ajouterait un champ monétaire ferait tomber ce test.
  const s = await station("pro")
  const owner = await s.member("owner")
  await pool.query(
    `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, metadata)
     VALUES($1::uuid,$2::uuid,'payment.recorded','payment','{"amount_cents":4500000}'::jsonb)`,
    [s.organizationId, owner.userId],
  )

  const raw = await (
    await consoleReq(`/organizations/${s.organizationId}/members/${owner.userId}/diagnostic`)
  ).text()
  for (const forbidden of ["cents", "amount", "montant", "price", "4500000"]) {
    assert.ok(!raw.toLowerCase().includes(forbidden), `« ${forbidden} » apparaît dans la réponse`)
  }
  // Mais l'activité est bien là, réduite aux noms d'actions.
  const payload = JSON.parse(raw)
  assert.ok(
    (payload.recent_activity as Array<{ action: string }>).some(
      (a) => a.action === "payment.recorded",
    ),
    "l'action est visible, pas son contenu",
  )
})

test("le diagnostic refuse un compte étranger à la station", async () => {
  const a = await station("pro")
  const b = await station("pro")
  await a.member("owner")
  const ownerB = await b.member("owner")

  const response = await consoleReq(
    `/organizations/${a.organizationId}/members/${ownerB.userId}/diagnostic`,
  )
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, "member_not_found")
})

// ---------------------------------------------------------------------------
// 6. Étanchéité
// ---------------------------------------------------------------------------

test("la file d'assistance reste fermée à une session de station", async () => {
  const s = await station("pro")
  const owner = await s.member("owner")
  const response = await clientReq(owner.token, "/console/support")
  assert.equal(response.status, 404, "la console n'existe pas pour une station")
})
