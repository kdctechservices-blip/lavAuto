import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { hashPassword } from "../server/auth.ts"

// ---------------------------------------------------------------------------
// Gestion des comptes depuis la console
//
// La route de suspension livrée dans la version précédente répondait 500 :
// elle écrivait `users.status = 'disabled'`, valeur que la contrainte
// `users_status_check` refuse. Les 265 tests passaient — aucun ne
// l'exerçait. Ce fichier commence donc par la régression, puis couvre ce que
// l'incident a mis en évidence : **appartenance et compte ne sont pas le même
// état**, et les confondre casse les gens qui travaillent sur deux stations.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool

const OPERATOR_EMAIL = "ops-comptes@washpilot.ci"
const OPERATOR_PASSWORD = "ConsoleSecret2026!"
const USER_PASSWORD = "WashPilot2026!"
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

let seq = 0
async function createUser(label: string): Promise<{ id: string; email: string }> {
  seq += 1
  const email = `${label}-${seq}@exemple.ci`
  const q = await pool.query(
    `INSERT INTO users(email, password_hash, first_name, last_name, phone, status)
     VALUES($1,$2,'Akissi','Brou','+2250700000000','active') RETURNING id`,
    [email, await hashPassword(USER_PASSWORD)],
  )
  return { id: q.rows[0].id as string, email }
}

async function createStation(label: string): Promise<string> {
  seq += 1
  const q = await pool.query(
    "INSERT INTO organizations(name, slug, onboarding_completed) VALUES($1,$2,true) RETURNING id",
    [`Station ${label} ${seq}`, `cpt-${label}-${seq}`],
  )
  const orgId = q.rows[0].id as string
  await pool.query(
    `INSERT INTO subscriptions(organization_id, plan_id, status, current_period_end)
     VALUES($1,(SELECT id FROM plans WHERE code='pro'),'active', now() + interval '60 days')`,
    [orgId],
  )
  return orgId
}

async function addMember(orgId: string, userId: string, role: string): Promise<void> {
  await pool.query(
    "INSERT INTO organization_members(organization_id, user_id, role, status) VALUES($1,$2,$3,'active')",
    [orgId, userId, role],
  )
}

async function loginStation(email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: USER_PASSWORD }),
  })
  assert.equal(response.status, 200, `connexion ${email}`)
  return response.headers.getSetCookie?.().join("; ") ?? response.headers.get("set-cookie") ?? ""
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
     VALUES($1,$2,'Operateur comptes','active')
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
// 1. La régression
// ---------------------------------------------------------------------------

test("suspendre une appartenance répond 200, pas 500", async () => {
  // Le test qui manquait. `users.status` n'accepte que 'active' ou
  // 'inactive' ; y écrire 'disabled' violait la contrainte.
  const org = await createStation("regression")
  const owner = await createUser("proprio")
  const cashier = await createUser("caissier")
  await addMember(org, owner.id, "owner")
  await addMember(org, cashier.id, "cashier")

  const response = await console_(`/organizations/${org}/members/${cashier.id}/status`, {
    method: "POST",
    body: { status: "disabled", reason: "Fin de contrat" },
  })
  const payload = await response.json()
  assert.equal(response.status, 200, JSON.stringify(payload))
  assert.equal(payload.membership_status, "disabled")
})

test("suspendre une appartenance ne touche pas au compte", async () => {
  const org = await createStation("portee")
  const owner = await createUser("proprio")
  const member = await createUser("membre")
  await addMember(org, owner.id, "owner")
  await addMember(org, member.id, "manager")

  await console_(`/organizations/${org}/members/${member.id}/status`, {
    method: "POST",
    body: { status: "disabled", reason: "Absence prolongée" },
  })

  const user = await pool.query("SELECT status FROM users WHERE id = $1::uuid", [member.id])
  assert.equal(user.rows[0].status, "active", "le compte reste ouvert")
  const membership = await pool.query(
    "SELECT status, disabled_at FROM organization_members WHERE organization_id=$1::uuid AND user_id=$2::uuid",
    [org, member.id],
  )
  assert.equal(membership.rows[0].status, "disabled")
  assert.ok(membership.rows[0].disabled_at, "la date de suspension est posée")
})

test("quitter une station ne déconnecte pas des autres", async () => {
  // Le cœur de la distinction. Quelqu'un qui travaille sur deux stations ne
  // doit pas tout perdre parce qu'il quitte l'une d'elles.
  const orgA = await createStation("double-A")
  const orgB = await createStation("double-B")
  const ownerA = await createUser("proprio-a")
  const ownerB = await createUser("proprio-b")
  const worker = await createUser("polyvalent")
  await addMember(orgA, ownerA.id, "owner")
  await addMember(orgB, ownerB.id, "owner")
  await addMember(orgA, worker.id, "cashier")
  await addMember(orgB, worker.id, "cashier")

  const cookie = await loginStation(worker.email)

  await console_(`/organizations/${orgA}/members/${worker.id}/status`, {
    method: "POST",
    body: { status: "disabled", reason: "Transfert vers l'autre site" },
  })

  // La session survit : la personne travaille encore sur la station B.
  const sessions = await pool.query(
    "SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1::uuid",
    [worker.id],
  )
  assert.ok(sessions.rows[0].n > 0, "la session n'est pas détruite")

  const me = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Cookie: cookie } })
  assert.equal(me.status, 200, "la personne reste connectée")
})

// ---------------------------------------------------------------------------
// 2. Le compte, portée globale
// ---------------------------------------------------------------------------

test("bloquer un compte le coupe partout et efface ses sessions", async () => {
  const org = await createStation("blocage")
  const owner = await createUser("proprio")
  const target = await createUser("compromis")
  await addMember(org, owner.id, "owner")
  await addMember(org, target.id, "manager")
  await loginStation(target.email)

  const response = await console_(`/accounts/${target.id}/status`, {
    method: "POST",
    body: { status: "inactive", reason: "Compte compromis, blocage immédiat" },
  })
  assert.equal(response.status, 200, await response.text())

  const user = await pool.query("SELECT status FROM users WHERE id = $1::uuid", [target.id])
  assert.equal(user.rows[0].status, "inactive")
  const sessions = await pool.query(
    "SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1::uuid",
    [target.id],
  )
  assert.equal(sessions.rows[0].n, 0, "les sessions ouvertes sont coupées")
})

test("bloquer le dernier propriétaire est refusé", async () => {
  // Sinon l'éditeur rendrait lui-même la station ingérable, et le client
  // rappellerait le lendemain pour un problème qu'on aurait créé.
  const org = await createStation("dernier-proprio")
  const owner = await createUser("seul-proprio")
  await addMember(org, owner.id, "owner")

  const response = await console_(`/accounts/${owner.id}/status`, {
    method: "POST",
    body: { status: "inactive", reason: "Tentative de blocage du seul responsable" },
  })
  assert.equal(response.status, 409)
  const payload = await response.json()
  assert.equal(payload.error.code, "last_owner")
  assert.match(payload.error.message, /dernier propriétaire/)
})

test("le garde-fou regarde toutes les stations, pas seulement une", async () => {
  // Quelqu'un peut être second propriétaire ici et seul propriétaire
  // ailleurs. Ne regarder qu'une station laisserait passer le blocage.
  const orgA = await createStation("multi-A")
  const orgB = await createStation("multi-B")
  const autre = await createUser("coproprio")
  const cible = await createUser("proprio-ailleurs")
  await addMember(orgA, autre.id, "owner")
  await addMember(orgA, cible.id, "owner") // accompagné ici
  await addMember(orgB, cible.id, "owner") // seul là-bas

  const response = await console_(`/accounts/${cible.id}/status`, {
    method: "POST",
    body: { status: "inactive", reason: "Blocage demandé par le client" },
  })
  assert.equal(response.status, 409)
  const message = (await response.json()).error.message as string
  assert.ok(message.includes("multi-B"), `la station bloquante est nommée : ${message}`)
  assert.ok(!message.includes("multi-A"), "celle où il est accompagné n'est pas citée")
})

test("une station programmée pour suppression ne bloque plus rien", async () => {
  const org = await createStation("supprimee")
  const owner = await createUser("proprio-sortant")
  await addMember(org, owner.id, "owner")
  await pool.query(
    `UPDATE organizations SET deletion_requested_at = now(),
            deletion_scheduled_for = now() + interval '30 days' WHERE id = $1::uuid`,
    [org],
  )

  const response = await console_(`/accounts/${owner.id}/status`, {
    method: "POST",
    body: { status: "inactive", reason: "Depart definitif du client" },
  })
  assert.equal(response.status, 200, await response.text())
})

// ---------------------------------------------------------------------------
// 3. Sessions
// ---------------------------------------------------------------------------

test("révoquer les sessions déconnecte sans bloquer le compte", async () => {
  const org = await createStation("sessions")
  const owner = await createUser("proprio")
  const target = await createUser("telephone-perdu")
  await addMember(org, owner.id, "owner")
  await addMember(org, target.id, "cashier")
  const cookie = await loginStation(target.email)

  const response = await console_(`/accounts/${target.id}/revoke-sessions`, {
    method: "POST",
    body: { reason: "Telephone perdu dans un taxi" },
  })
  assert.equal(response.status, 200)
  assert.ok((await response.json()).revoked >= 1)

  const me = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Cookie: cookie } })
  assert.equal(me.status, 401, "l'ancienne session ne vaut plus rien")

  // Mais le compte vit : la personne se reconnecte avec son mot de passe.
  const again = await loginStation(target.email)
  assert.ok(again.length > 0, "reconnexion possible")
})

// ---------------------------------------------------------------------------
// 4. Rôles et transfert de propriété
// ---------------------------------------------------------------------------

test("changer un rôle met à jour l'appartenance et se justifie", async () => {
  const org = await createStation("roles")
  const owner = await createUser("proprio")
  const member = await createUser("promu")
  await addMember(org, owner.id, "owner")
  await addMember(org, member.id, "cashier")

  const sansMotif = await console_(`/organizations/${org}/members/${member.id}/role`, {
    method: "POST",
    body: { role: "manager" },
  })
  assert.equal(sansMotif.status, 400, "le motif est obligatoire")

  const response = await console_(`/organizations/${org}/members/${member.id}/role`, {
    method: "POST",
    body: { role: "manager", reason: "Promotion demandee par le proprietaire" },
  })
  const payload = await response.json()
  assert.equal(response.status, 200, JSON.stringify(payload))
  assert.equal(payload.role, "manager")
  assert.equal(payload.previous_role, "cashier")
  assert.equal(payload.role_label, "Gérant")
})

test("changer de rôle efface les exceptions de permission", async () => {
  // Elles avaient été accordées pour l'ancien périmètre. Les garder
  // donnerait au nouveau rôle des droits que personne n'a décidés.
  const org = await createStation("exceptions")
  const owner = await createUser("proprio")
  const member = await createUser("delegataire")
  await addMember(org, owner.id, "owner")
  await addMember(org, member.id, "manager")
  await pool.query(
    `INSERT INTO member_permissions(organization_id, user_id, permission, granted)
     VALUES($1,$2,'data:export',true)`,
    [org, member.id],
  )

  const response = await console_(`/organizations/${org}/members/${member.id}/role`, {
    method: "POST",
    body: { role: "cashier", reason: "Retrogradation apres reorganisation" },
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).permission_overrides_cleared, 1)

  const left = await pool.query(
    "SELECT count(*)::int AS n FROM member_permissions WHERE organization_id=$1::uuid AND user_id=$2::uuid",
    [org, member.id],
  )
  assert.equal(left.rows[0].n, 0)
})

test("rétrograder le dernier propriétaire est refusé", async () => {
  const org = await createStation("retrogradation")
  const owner = await createUser("seul-maitre")
  await addMember(org, owner.id, "owner")

  const response = await console_(`/organizations/${org}/members/${owner.id}/role`, {
    method: "POST",
    body: { role: "manager", reason: "Tentative de retrogradation du seul proprietaire" },
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, "last_owner")
})

test("transférer la propriété : nommer d'abord, rétrograder ensuite", async () => {
  // Le cas qui justifie la route : le propriétaire est parti, personne ne
  // peut plus administrer. L'ordre est imposé par le garde-fou lui-même.
  const org = await createStation("transfert")
  const ancien = await createUser("ancien-proprio")
  const nouveau = await createUser("repreneur")
  await addMember(org, ancien.id, "owner")
  await addMember(org, nouveau.id, "manager")

  // 1. Promouvoir le repreneur.
  const promotion = await console_(`/organizations/${org}/members/${nouveau.id}/role`, {
    method: "POST",
    body: { role: "owner", reason: "Reprise de la station par le nouvel exploitant" },
  })
  assert.equal(promotion.status, 200, await promotion.text())

  // 2. L'ancien peut alors être rétrogradé — il n'est plus seul.
  const retrait = await console_(`/organizations/${org}/members/${ancien.id}/role`, {
    method: "POST",
    body: { role: "manager", reason: "Depart de l ancien exploitant" },
  })
  assert.equal(retrait.status, 200, await retrait.text())

  const owners = await pool.query(
    "SELECT count(*)::int AS n FROM organization_members WHERE organization_id=$1::uuid AND role='owner' AND status='active'",
    [org],
  )
  assert.equal(owners.rows[0].n, 1, "la station garde exactement un propriétaire")
})

test("attribuer le rôle déjà porté est refusé plutôt que silencieux", async () => {
  const org = await createStation("inchange")
  const owner = await createUser("proprio")
  const member = await createUser("stable")
  await addMember(org, owner.id, "owner")
  await addMember(org, member.id, "washer")

  const response = await console_(`/organizations/${org}/members/${member.id}/role`, {
    method: "POST",
    body: { role: "washer", reason: "Tentative sans changement reel" },
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, "role_unchanged")
})

test("un compte étranger à la station n'est pas modifiable par cette route", async () => {
  const orgA = await createStation("etanche-A")
  const orgB = await createStation("etanche-B")
  const ownerA = await createUser("proprio-a")
  const ownerB = await createUser("proprio-b")
  await addMember(orgA, ownerA.id, "owner")
  await addMember(orgB, ownerB.id, "owner")

  const response = await console_(`/organizations/${orgA}/members/${ownerB.id}/role`, {
    method: "POST",
    body: { role: "cashier", reason: "Tentative sur une autre station" },
  })
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error.code, "member_not_found")
})

// ---------------------------------------------------------------------------
// 5. Retrouver une personne
// ---------------------------------------------------------------------------

test("la recherche trouve par adresse, par nom et par téléphone", async () => {
  const org = await createStation("recherche")
  const owner = await createUser("proprio")
  const cible = await createUser("recherchable")
  await addMember(org, owner.id, "owner")
  await addMember(org, cible.id, "manager")

  for (const [label, q] of [
    ["adresse", cible.email],
    ["nom", "Akissi"],
    ["téléphone", "0700000000"],
  ] as const) {
    const response = await console_(`/accounts?q=${encodeURIComponent(q)}`)
    assert.equal(response.status, 200)
    const found = (await response.json()).accounts as Array<{ id: string }>
    assert.ok(found.some((a) => a.id === cible.id), `trouvé par ${label}`)
  }
})

test("la fiche d'une personne montre toutes ses stations", async () => {
  const orgA = await createStation("fiche-A")
  const orgB = await createStation("fiche-B")
  const ownerA = await createUser("proprio-a")
  const ownerB = await createUser("proprio-b")
  const cible = await createUser("polyvalent")
  await addMember(orgA, ownerA.id, "owner")
  await addMember(orgB, ownerB.id, "owner")
  await addMember(orgA, cible.id, "cashier")
  await addMember(orgB, cible.id, "manager")

  const response = await console_(`/accounts/${cible.id}`)
  assert.equal(response.status, 200)
  const payload = (await response.json()) as {
    account: { email: string; memberships: number }
    memberships: Array<{ organization_id: string; role: string }>
    sole_owner_of: unknown[]
  }
  assert.equal(payload.account.email, cible.email)
  assert.equal(payload.memberships.length, 2)
  assert.deepEqual(
    payload.memberships.map((m) => m.role).sort(),
    ["cashier", "manager"],
  )
  assert.equal(payload.sole_owner_of.length, 0)
})

test("la fiche signale d'avance où la personne est irremplaçable", async () => {
  const org = await createStation("irremplacable")
  const owner = await createUser("pilier")
  await addMember(org, owner.id, "owner")

  const payload = (await (await console_(`/accounts/${owner.id}`)).json()) as {
    sole_owner_of: Array<{ name: string }>
  }
  assert.equal(payload.sole_owner_of.length, 1, "l'opérateur le voit avant d'essayer")
})

test("un compte inexistant renvoie 404 et non une fiche vide", async () => {
  const response = await console_("/accounts/11111111-2222-4333-8444-555555555555")
  assert.equal(response.status, 404)
})

// ---------------------------------------------------------------------------
// 6. Traces
// ---------------------------------------------------------------------------

test("tout geste sur un compte est inscrit chez le client et chez l'éditeur", async () => {
  const org = await createStation("traces")
  const owner = await createUser("proprio")
  const member = await createUser("trace")
  await addMember(org, owner.id, "owner")
  await addMember(org, member.id, "cashier")

  await console_(`/organizations/${org}/members/${member.id}/role`, {
    method: "POST",
    body: { role: "manager", reason: "Promotion pour verification des traces" },
  })

  const chezLeClient = await pool.query(
    `SELECT metadata FROM audit_logs
      WHERE organization_id = $1::uuid AND action = 'member.role_changed'`,
    [org],
  )
  assert.equal(chezLeClient.rowCount, 1, "le propriétaire le voit dans son journal")
  assert.equal(chezLeClient.rows[0].metadata.after, "manager")

  const chezLEditeur = await pool.query(
    `SELECT operator_email FROM platform_audit_logs
      WHERE organization_id = $1::uuid AND action = 'member.role_changed'`,
    [org],
  )
  assert.equal(chezLEditeur.rowCount, 1)
  assert.equal(chezLEditeur.rows[0].operator_email, OPERATOR_EMAIL)
})

test("la console reste fermée à une session de station", async () => {
  const org = await createStation("etancheite")
  const owner = await createUser("proprio")
  await addMember(org, owner.id, "owner")
  const cookie = await loginStation(owner.email)

  const response = await fetch(`${baseUrl}/api/v1/console/accounts`, { headers: { Cookie: cookie } })
  assert.equal(response.status, 404, "la console n'existe pas pour une station")
})
