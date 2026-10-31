import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import {
  bindRlsGuard,
  isRlsRoleAvailable,
  probeRlsRole,
  setRlsRoleAvailable,
  type RlsPool,
} from "../server/db-rls.ts"
import { runWithTenant, runWithoutTenant, currentTenantScope } from "../server/tenant-context.ts"

// ---------------------------------------------------------------------------
// Le rôle applicatif RLS : sonde, appartenance, repli.
//
// Rappel de la régression : le rôle existait, la sonde disait « active », et
// pourtant chaque requête mourait sur « permission denied to set role » —
// `SET ROLE` exige l'appartenance au rôle, que rien n'accordait. Les tests
// (superutilisateur) ne pouvaient pas le voir. Cette suite éprouve la sonde
// sur les trois états réels du monde, le repli qui garde l'API debout, et la
// vraie base de test.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>
function fakeQuery(rows: Array<Row>) {
  return { query: async () => ({ rows }) }
}

const SCOPE = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
}

// ---------------------------------------------------------------------------
// La sonde : les trois états, et la manière de les annoncer
// ---------------------------------------------------------------------------

test("sonde : le rôle est absent → le garde reste désactivé", async () => {
  await probeRlsRole(fakeQuery([{ role_exists: false, is_member: false, app_user: "washpilot" }]))
  assert.equal(isRlsRoleAvailable(), false)
})

test("sonde : le rôle existe et le compte en est membre → le garde s'active", async () => {
  await probeRlsRole(fakeQuery([{ role_exists: true, is_member: true, app_user: "washpilot" }]))
  assert.equal(isRlsRoleAvailable(), true)
})

test("sonde : le rôle existe mais le compte n'en est pas membre → désactivé, jamais « active »", async () => {
  // C'est l'état de la régression : afficher « active » ici mentirait, et la
  // première requête casserait sur SET ROLE.
  await probeRlsRole(fakeQuery([{ role_exists: true, is_member: false, app_user: "washpilot" }]))
  assert.equal(isRlsRoleAvailable(), false)
})

test("sonde : vérification impossible → désactivé, sans faire échouer le démarrage", async () => {
  await probeRlsRole({
    query: async () => {
      throw new Error("connexion refusée")
    },
  })
  assert.equal(isRlsRoleAvailable(), false)
})

// ---------------------------------------------------------------------------
// Le repli : SET ROLE refusé en cours de route ne doit pas tuer l'API
// ---------------------------------------------------------------------------

function fakePoolDenyingSetRole() {
  const calls: string[] = []
  const answer = (text: string) => {
    calls.push(text)
    return { rows: [{ ok: 1 }], rowCount: 1, fields: [], command: "SELECT", affectedRows: 1 }
  }
  const client = {
    async query(text: string) {
      if (/^SET ROLE/i.test(text.trim())) {
        answer(text)
        throw new Error('permission denied to set role "washpilot_app"')
      }
      return answer(text)
    },
    release() {},
  }
  const pool = {
    async query(text: string) {
      return answer(text)
    },
    async connect() {
      return client
    },
    async end() {},
  }
  return { pool, calls }
}

test("repli : SET ROLE refusé → la requête aboutit sans le rôle, l'avertissement part une fois", async () => {
  setRlsRoleAvailable(true)
  const { pool, calls } = fakePoolDenyingSetRole()
  const guard = bindRlsGuard(pool as unknown as RlsPool)

  const q = await runWithTenant(SCOPE, () => guard.query("SELECT 1"))
  assert.equal(q.rows.length, 1, "la requête aboutit malgré le refus")
  assert.equal(isRlsRoleAvailable(), false, "le garde est désactivé après le refus")
  assert.ok(
    calls.some((text) => /^SET ROLE/i.test(text.trim())),
    "le SET ROLE a bien été tenté la première fois",
  )

  // Les requêtes suivantes ne retentent plus : pas de bruit, pas de latence.
  calls.length = 0
  await runWithTenant(SCOPE, () => guard.query("SELECT 2"))
  assert.ok(!calls.some((text) => /^SET ROLE/i.test(text.trim())), "pas de nouvelle tentative")
})

test("repli : une vraie panne (autre que le rôle) remonte, n'est pas avalée", async () => {
  setRlsRoleAvailable(true)
  const pool = {
    async query() {
      return { rows: [], rowCount: 0, fields: [], command: "SELECT" }
    },
    async connect() {
      return {
        async query(text: string) {
          if (/^SET ROLE/i.test(text.trim())) throw new Error("server closed the connection")
          return { rows: [], rowCount: 0, fields: [], command: "SELECT" }
        },
        release() {},
      }
    },
    async end() {},
  }
  const guard = bindRlsGuard(pool as unknown as RlsPool)
  await assert.rejects(
    () => runWithTenant(SCOPE, () => guard.query("SELECT 1")),
    /server closed the connection/,
  )
  assert.equal(isRlsRoleAvailable(), true, "une panne de connexion ne désarme pas le garde")
})

// ---------------------------------------------------------------------------
// Le contexte : la surveillance doit pouvoir sortir de la portée
// ---------------------------------------------------------------------------

test("runWithoutTenant sort bien du contexte de locataire", () => {
  runWithTenant(SCOPE, () => {
    assert.ok(currentTenantScope(), "dans la requête : portée présente")
    runWithoutTenant(() => {
      assert.equal(currentTenantScope(), null, "hors portée : le chemin système est neutre")
    })
    assert.ok(currentTenantScope(), "la sortie ne détruit pas la portée de l'appelant")
  })
})

// ---------------------------------------------------------------------------
// La vraie base : la sonde confirme le rôle après l'initialisation
// ---------------------------------------------------------------------------

before(async () => {
  assert.ok(await initDatabaseSchema(), "base de test initialisée")
})

after(async () => {
  await closeDatabase()
})

test("intégration : sur la base de test, la sonde confirme rôle + appartenance", async () => {
  const pool = getPool()
  assert.ok(pool, "pool prêt")
  await probeRlsRole(pool as unknown as { query: (text: string) => Promise<{ rows: Array<Row> }> })
  assert.equal(isRlsRoleAvailable(), true, "le compte de test est membre de washpilot_app")
})
