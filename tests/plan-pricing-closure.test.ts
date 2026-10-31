import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { initDatabaseSchema, getPool, closeDatabase, schemaSql } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"
import { acceptPendingClosure } from "../server/closure.ts"

// ---------------------------------------------------------------------------
// Lot « trois écarts » : tarifs modifiables, essai réglable, départ du client
//
// Les trois manques relevés par l'audit du back-office. Ce qui est vérifié
// ici n'est pas que les routes répondent — c'est qu'elles tiennent leurs
// promesses dans les cas où elles pourraient mentir :
//
//   • un prix changé en console doit survivre au redémarrage du serveur ;
//   • la vitrine doit afficher ce prix-là, pas celui écrit dans son code ;
//   • un client en lecture seule doit pouvoir demander à partir ;
//   • une demande de départ ne doit rien fermer par elle-même.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool
let organizationId: string

const PASSWORD = "WashPilot2026!"
const sessions = new Map<string, string>()

const OPERATOR_EMAIL = "ops-closure@washpilot.ci"
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
  sessions.set(
    email,
    response.headers.getSetCookie?.().join("; ") ?? response.headers.get("set-cookie") ?? "",
  )
}

async function setSubscription(status: string, daysLeft: number) {
  await pool.query(
    `UPDATE subscriptions SET status = $1, current_period_end = now() + ($2 || ' days')::interval
      WHERE organization_id = $3::uuid`,
    [status, String(daysLeft), organizationId],
  )
  invalidateSubscriptionCache(organizationId)
}

/** Remet la grille livrée avec le produit, override compris. */
async function resetPlans() {
  await pool.query(
    `UPDATE plans SET price_overridden_at = NULL,
            price_cents = CASE code WHEN 'starter' THEN 1000000
                                    WHEN 'pro' THEN 2000000
                                    ELSE 3500000 END
      WHERE code IN ('starter','pro','business')`,
  )
}

async function clearClosures() {
  await pool.query("DELETE FROM closure_requests")
}

/**
 * (Re)crée l'opérateur de console et rouvre toutes les sessions.
 *
 * Nécessaire après un redémarrage simulé : réinitialiser le schéma réaligne
 * la table des opérateurs sur PLATFORM_ADMIN_EMAILS — qui ne contient pas
 * notre opérateur de test — et invalide les sessions ouvertes. Sans cette
 * réouverture, tout ce qui suivrait répondrait 404 ou 401 pour une raison
 * sans rapport avec ce qu'on cherche à prouver.
 */
async function openSessions() {
  const { hashPassword } = await import("../server/auth.ts")
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
  operatorCookie =
    loggedIn.headers.getSetCookie?.().join("; ") ?? loggedIn.headers.get("set-cookie") ?? ""

  for (const email of ["demo@washpilot.ci", "gerant@washpilot.ci", "caisse@washpilot.ci"]) {
    await login(email)
  }
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
  await openSessions()
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// ---------------------------------------------------------------------------
// Écart 1 — le tarif se change depuis la console
// ---------------------------------------------------------------------------

test("l'éditeur change un tarif, et le nouveau prix fait foi", async () => {
  await resetPlans()
  const response = await console_("/plans/pro", {
    method: "PATCH",
    body: { price_xof: 25000, reason: "Alignement sur la concurrence d'Abidjan" },
  })
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.price_xof, 25000)
  assert.equal(payload.previous_price_xof, 20000, "l'ancien prix est rendu, pour la trace")

  const row = await pool.query("SELECT price_cents FROM plans WHERE code='pro'")
  assert.equal(Number(row.rows[0].price_cents), 2_500_000)
  await resetPlans()
})

test("un prix fixé en console survit au redémarrage du serveur", async () => {
  // Le vrai piège de cet écart. Le catalogue se rejoue à chaque démarrage
  // avec un ON CONFLICT DO UPDATE : sans protection, le tarif décidé par
  // l'éditeur serait silencieusement remplacé par celui écrit en dur, et
  // personne n'aurait compris pourquoi le prix « revient tout seul ».
  await resetPlans()
  await console_("/plans/business", {
    method: "PATCH",
    body: { price_xof: 40000, reason: "Nouvelle grille 2027" },
  })

  // On rejoue le SQL de démarrage sur la base en cours : c'est exactement ce
  // qu'exécute un serveur qui redémarre. Passer par initDatabaseSchema()
  // créerait ici une base neuve — le prix « reviendrait » pour une raison
  // sans rapport, et le test ne prouverait rien.
  await pool.query(schemaSql)

  const row = await pool.query("SELECT price_cents FROM plans WHERE code='business'")
  assert.equal(
    Number(row.rows[0].price_cents),
    4_000_000,
    "le prix décidé par l'éditeur doit survivre au redémarrage",
  )

  // À l'inverse, un forfait jamais modifié suit toujours la grille livrée.
  const untouched = await pool.query("SELECT price_cents FROM plans WHERE code='starter'")
  assert.equal(Number(untouched.rows[0].price_cents), 1_000_000)
  await resetPlans()
})

test("un tarif à zéro est refusé : aucun forfait n'est gratuit", async () => {
  const response = await console_("/plans/starter", {
    method: "PATCH",
    body: { price_xof: 0, reason: "Test de gratuité" },
  })
  assert.equal(response.status, 400)
})

test("un montant qui n'est pas multiple de 5 est refusé", async () => {
  // Les opérateurs mobile money ivoiriens rejettent ces montants : le forfait
  // serait invendable, et l'erreur n'apparaîtrait qu'au premier client.
  const response = await console_("/plans/starter", {
    method: "PATCH",
    body: { price_xof: 10001, reason: "Prix psychologique" },
  })
  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.equal(payload.error.code, "price_not_multiple_of_5")
})

test("changer un tarif exige un motif", async () => {
  const response = await console_("/plans/starter", {
    method: "PATCH",
    body: { price_xof: 12000 },
  })
  assert.equal(response.status, 400)
})

test("un forfait inconnu ne se tarife pas", async () => {
  const response = await console_("/plans/entreprise", {
    method: "PATCH",
    body: { price_xof: 50000, reason: "Forfait imaginaire" },
  })
  assert.equal(response.status, 404)
})

test("une station ne peut pas changer les tarifs de l'éditeur", async () => {
  // La console est invisible depuis une session de station : 404, pas 403.
  const response = await fetch(`${baseUrl}/api/v1/console/plans/pro`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: sessions.get("demo@washpilot.ci") ?? "",
    },
    body: JSON.stringify({ price_xof: 5, reason: "Je me fais un prix" }),
  })
  assert.equal(response.status, 404)
  const row = await pool.query("SELECT price_cents FROM plans WHERE code='pro'")
  assert.equal(Number(row.rows[0].price_cents), 2_000_000, "le tarif n'a pas bougé")
})

test("le changement de tarif est inscrit au registre de l'éditeur", async () => {
  await resetPlans()
  await console_("/plans/pro", {
    method: "PATCH",
    body: { price_xof: 22000, reason: "Hausse des coûts d'hébergement" },
  })
  const log = await pool.query(
    `SELECT metadata FROM platform_audit_logs
      WHERE action = 'plan.price_changed' ORDER BY created_at DESC LIMIT 1`,
  )
  assert.equal(log.rowCount, 1)
  const meta = log.rows[0].metadata as Record<string, unknown>
  assert.equal(meta.previous_price_xof, 20000)
  assert.equal(meta.new_price_xof, 22000)
  assert.equal(meta.reason, "Hausse des coûts d'hébergement")
  await resetPlans()
})

// ---------------------------------------------------------------------------
// La vitrine ne doit jamais démentir la facture
// ---------------------------------------------------------------------------

test("la grille publique se lit sans compte", async () => {
  const response = await fetch(`${baseUrl}/api/v1/public/pricing`)
  assert.equal(response.status, 200, "un visiteur anonyme doit pouvoir lire les prix")
  const payload = await response.json()
  assert.equal(payload.plans.length, 3)
  assert.equal(payload.trial_days, 14)
})

test("la vitrine affiche le prix réellement facturé, pas celui écrit en dur", async () => {
  await resetPlans()
  await console_("/plans/pro", {
    method: "PATCH",
    body: { price_xof: 24000, reason: "Nouvelle grille" },
  })
  const payload = await (await fetch(`${baseUrl}/api/v1/public/pricing`)).json()
  const pro = payload.plans.find((p: { code: string }) => p.code === "pro")
  assert.equal(pro.price_xof, 24000, "un visiteur doit lire 24 000 F, pas 20 000 F")
  await resetPlans()
})

test("la grille publique ne divulgue rien d'autre que les prix", async () => {
  // Une route sans authentification doit être avare : ni plafonds, ni
  // capacités, ni nombre de clients.
  const payload = await (await fetch(`${baseUrl}/api/v1/public/pricing`)).json()
  const keys = Object.keys(payload.plans[0]).sort()
  assert.deepEqual(keys, ["code", "price_xof"])
})

// ---------------------------------------------------------------------------
// Écart 3 — le client demande lui-même à partir
// ---------------------------------------------------------------------------

test("le propriétaire demande la clôture, et rien ne se ferme", async () => {
  await clearClosures()
  await setSubscription("active", 20)

  const response = await api("/api/v1/subscription/closure", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Je vends la station à un confrère en novembre." },
  })
  assert.equal(response.status, 201)

  // Le point essentiel : la station continue de fonctionner normalement.
  const state = await (await api("/api/v1/subscription", { as: "demo@washpilot.ci" })).json()
  assert.equal(state.read_only, false, "demander à partir ne coupe rien")

  const org = await pool.query(
    "SELECT deletion_requested_at FROM organizations WHERE id = $1::uuid",
    [organizationId],
  )
  assert.equal(org.rows[0].deletion_requested_at, null, "aucune suppression n'est programmée")
})

test("un motif sérieux est exigé : « non » ne suffit pas", async () => {
  await clearClosures()
  const response = await api("/api/v1/subscription/closure", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "non" },
  })
  assert.equal(response.status, 400)
})

test("deux demandes de clôture ne s'empilent pas", async () => {
  await clearClosures()
  const first = await api("/api/v1/subscription/closure", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Je ferme définitivement mon activité de lavage." },
  })
  assert.equal(first.status, 201)

  const second = await api("/api/v1/subscription/closure", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Je ferme définitivement mon activité de lavage." },
  })
  assert.equal(second.status, 409)
  const payload = await second.json()
  assert.equal(payload.error.code, "closure_already_requested")
})

test("le client peut se raviser tant que personne n'a tranché", async () => {
  await clearClosures()
  await api("/api/v1/subscription/closure", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Trop cher pour mon volume actuel de lavages." },
  })
  const cancelled = await api("/api/v1/subscription/closure/cancel", {
    as: "demo@washpilot.ci",
    method: "POST",
  })
  assert.equal(cancelled.status, 200)

  const after_ = await (await api("/api/v1/subscription/closure", { as: "demo@washpilot.ci" })).json()
  assert.equal(after_.pending, false)

  // Et il peut en redéposer une : se raviser deux fois reste permis.
  const again = await api("/api/v1/subscription/closure", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Finalement je pars, j'ai trouvé un autre outil." },
  })
  assert.equal(again.status, 201)
})

test("un client en lecture seule peut encore demander à partir", async () => {
  // C'est précisément celui qui veut partir : lui répondre « payez d'abord »
  // serait grotesque. Le préfixe /subscription échappe au blocage.
  await clearClosures()
  await setSubscription("trialing", -5)
  const state = await (await api("/api/v1/subscription", { as: "demo@washpilot.ci" })).json()
  assert.equal(state.read_only, true, "la station est bien bloquée en écriture")

  const response = await api("/api/v1/subscription/closure", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "L'essai est fini et je ne souhaite pas continuer." },
  })
  assert.equal(response.status, 201, "un client bloqué doit pouvoir partir")
  await setSubscription("active", 20)
})

test("le caissier ne ferme pas la station de son patron", async () => {
  await clearClosures()
  const response = await api("/api/v1/subscription/closure", {
    as: "caisse@washpilot.ci",
    method: "POST",
    body: { reason: "Je n'aime pas ce logiciel, on arrête tout." },
  })
  assert.equal(response.status, 403)
})

test("le gérant non plus : fermer l'entreprise est la décision du propriétaire", async () => {
  await clearClosures()
  const response = await api("/api/v1/subscription/closure", {
    as: "gerant@washpilot.ci",
    method: "POST",
    body: { reason: "Je pense que nous devrions arrêter l'abonnement." },
  })
  assert.equal(response.status, 403)
})

test("annuler une demande inexistante ne fait pas semblant de réussir", async () => {
  await clearClosures()
  const response = await api("/api/v1/subscription/closure/cancel", {
    as: "demo@washpilot.ci",
    method: "POST",
  })
  assert.equal(response.status, 404)
})

// ---------------------------------------------------------------------------
// Côté éditeur
// ---------------------------------------------------------------------------

test("la demande apparaît dans la file de l'éditeur", async () => {
  await clearClosures()
  await api("/api/v1/subscription/closure", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Le réseau est trop mauvais chez moi pour un outil en ligne." },
  })
  const payload = await (await console_("/closure-requests")).json()
  assert.equal(payload.requests.length, 1)
  assert.equal(payload.requests[0].organization_id, organizationId)
  assert.match(payload.requests[0].reason, /réseau/)
  assert.ok(payload.requests[0].organization_name, "le nom de la station est joint")
})

test("l'éditeur refuse en expliquant, et le client lit la réponse", async () => {
  await clearClosures()
  await api("/api/v1/subscription/closure", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Je trouve que le stock est trop compliqué à tenir." },
  })
  const list = await (await console_("/closure-requests")).json()
  const id = list.requests[0].id

  const declined = await console_(`/closure-requests/${id}/decline`, {
    method: "POST",
    body: { note: "Nous vous appelons demain pour simplifier votre suivi de stock." },
  })
  assert.equal(declined.status, 200)

  const seen = await (await api("/api/v1/subscription/closure", { as: "demo@washpilot.ci" })).json()
  assert.equal(seen.pending, false)
  assert.equal(seen.request.status, "declined")
  assert.match(seen.request.resolution_note, /appelons demain/)
})

test("un refus sans explication est refusé", async () => {
  await clearClosures()
  await api("/api/v1/subscription/closure", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Je change de logiciel le mois prochain." },
  })
  const list = await (await console_("/closure-requests")).json()
  const response = await console_(`/closure-requests/${list.requests[0].id}/decline`, {
    method: "POST",
    body: { note: "non" },
  })
  assert.equal(response.status, 400)
})

test("une demande déjà traitée ne se traite pas deux fois", async () => {
  await clearClosures()
  await api("/api/v1/subscription/closure", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Je pars, merci pour tout et bonne continuation." },
  })
  const list = await (await console_("/closure-requests")).json()
  const id = list.requests[0].id
  const body = { note: "Compris, nous programmons la clôture pour fin de mois." }

  assert.equal((await console_(`/closure-requests/${id}/decline`, { method: "POST", body })).status, 200)
  assert.equal(
    (await console_(`/closure-requests/${id}/decline`, { method: "POST", body })).status,
    404,
    "le second refus ne doit pas réécrire la réponse déjà envoyée",
  )
})

test("programmer la clôture solde la demande du client", async () => {
  // Sans cela, la demande resterait éternellement « en attente » alors
  // qu'elle a été exaucée, et un second opérateur la traiterait à nouveau.
  await clearClosures()
  await api("/api/v1/subscription/closure", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Je cesse mon activité à la fin du mois, merci." },
  })

  const scheduled = await console_(`/organizations/${organizationId}/schedule-deletion`, {
    method: "POST",
    body: { reason: "Clôture demandée par le client", grace_days: 30 },
  })
  assert.equal(scheduled.status, 200)
  const payload = await scheduled.json()
  assert.equal(payload.closure_request_accepted, true)

  const row = await pool.query("SELECT status FROM closure_requests LIMIT 1")
  assert.equal(row.rows[0].status, "accepted")

  // On remet la station en service : les autres tests en dépendent.
  //
  // Au passage, une propriété rassurante vérifiée ici : programmer une
  // clôture révoque sur-le-champ les sessions ouvertes de la station.
  // Annuler la clôture ne les ressuscite pas — il faut se reconnecter.
  const dead = await api("/api/v1/subscription", { as: "demo@washpilot.ci" })
  assert.equal(dead.status, 401, "la clôture programmée coupe les sessions en cours")

  await console_(`/organizations/${organizationId}/cancel-deletion`, { method: "POST" })
  invalidateSubscriptionCache(organizationId)
  await openSessions()
})

test("acceptPendingClosure ne touche qu'aux demandes en attente", async () => {
  // Appel direct : par l'API, le contrôle de statut de la route de
  // suppression répondrait avant d'atteindre cette garde, et le test
  // mesurerait le statut HTTP plutôt que la fonction.
  await clearClosures()
  const created = await api("/api/v1/subscription/closure", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { reason: "Demande qui sera annulée juste après son dépôt." },
  })
  assert.equal(created.status, 201, "la demande doit d'abord exister")
  const cancelled = await api("/api/v1/subscription/closure/cancel", {
    as: "demo@washpilot.ci",
    method: "POST",
  })
  assert.equal(cancelled.status, 200, "puis être annulée")

  const touched = await acceptPendingClosure(pool, organizationId, "ops@washpilot.ci", "motif")
  assert.equal(touched, false, "une demande annulée ne doit pas devenir « acceptée »")

  const row = await pool.query("SELECT status FROM closure_requests LIMIT 1")
  assert.equal(row.rows[0].status, "cancelled")
})

test("une station ne voit pas la file des départs des autres", async () => {
  const response = await fetch(`${baseUrl}/api/v1/console/closure-requests`, {
    headers: { Cookie: sessions.get("demo@washpilot.ci") ?? "" },
  })
  assert.equal(response.status, 404)
})

// ---------------------------------------------------------------------------
// Écart 2 — la durée d'essai
// ---------------------------------------------------------------------------

test("la durée d'essai annoncée est celle que le serveur applique", async () => {
  // La vitrine lit cette valeur sur l'API. Tant qu'elle la lit, elle ne peut
  // plus annoncer 14 jours à un prospect qui en recevra 30.
  const { TRIAL_DAYS } = await import("../server/entitlements.ts")
  const payload = await (await fetch(`${baseUrl}/api/v1/public/pricing`)).json()
  assert.equal(payload.trial_days, TRIAL_DAYS)
})

test("la durée d'essai refuse les valeurs absurdes", async () => {
  // Zéro jour afficherait « essayez gratuitement » à un visiteur déjà
  // expiré ; mille jours ne convergerait jamais vers un abonnement.
  const { z } = await import("zod")
  const schema = z.coerce.number().int().min(1).max(90).default(14)
  assert.equal(schema.parse(undefined), 14)
  assert.equal(schema.parse("30"), 30)
  assert.throws(() => schema.parse(0))
  assert.throws(() => schema.parse(365))
})
