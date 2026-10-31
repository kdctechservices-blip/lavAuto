import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { runWithTenant } from "../server/tenant-context.ts"
import { isRlsRoleAvailable } from "../server/db-rls.ts"
import type { Pool } from "pg"

// ---------------------------------------------------------------------------
// Isolation multi-station au niveau des lignes (RLS)
//
// `tests/tenant-isolation.test.ts` prouve que le code filtre correctement ;
// cette suite prouve que la base le fait **même quand le code oublie**. Chaque
// test exécute la même requête dans deux contextes : la portée d'une station
// (comme pendant une requête HTTP) et hors portée (semis, console, travaux
// planifiés), et vérifie que les lignes de la station voisine ne bougent pas.
// ---------------------------------------------------------------------------

let pool: Pool
let orgA: string
let orgB: string
let washA: string
let washB: string

const scopeA = () => ({ organizationId: orgA, userId: orgA })
const scopeB = () => ({ organizationId: orgB, userId: orgB })

async function createOrg(name: string, slug: string): Promise<string> {
  const q = await pool.query("INSERT INTO organizations(name, slug) VALUES($1,$2) RETURNING id", [
    name,
    slug,
  ])
  return q.rows[0].id as string
}

async function createWash(orgId: string, reference: string): Promise<string> {
  const site = await pool.query(
    "INSERT INTO sites(organization_id, name, city) VALUES($1,$2,'Abidjan') RETURNING id",
    [orgId, `Site ${reference}`],
  )
  const vehicle = await pool.query(
    "INSERT INTO vehicle_categories(organization_id, name) VALUES($1,'Berline') RETURNING id",
    [orgId],
  )
  const q = await pool.query(
    `INSERT INTO washes(organization_id, site_id, vehicle_category_id, reference, status, payment_status, total_cents)
     VALUES($1,$2,$3,$4,'completed','paid',1000) RETURNING id`,
    [orgId, site.rows[0].id, vehicle.rows[0].id, reference],
  )
  return q.rows[0].id as string
}

before(async () => {
  const ready = await initDatabaseSchema()
  assert.ok(ready, "la base de test doit être initialisée")
  pool = getPool() as Pool

  orgA = await createOrg("Station RLS A", "station-rls-a")
  orgB = await createOrg("Station RLS B", "station-rls-b")
  washA = await createWash(orgA, "RLS-A-0001")
  washB = await createWash(orgB, "RLS-B-0001")

  await pool.query(
    "INSERT INTO expenses(organization_id, category, amount_cents, payment_method) VALUES($1,'supply',111111,'cash')",
    [orgA],
  )
  await pool.query(
    "INSERT INTO expenses(organization_id, category, amount_cents, payment_method) VALUES($1,'supply',222222,'cash')",
    [orgB],
  )
  for (const [organizationId, number] of [[orgA, "RLS-CIE-A"], [orgB, "RLS-CIE-B"]] as const) {
    const site = await pool.query("SELECT id FROM sites WHERE organization_id=$1::uuid ORDER BY created_at LIMIT 1", [organizationId])
    const meter = await pool.query(
      "INSERT INTO utility_meters(organization_id,site_id,provider,meter_number) VALUES($1,$2,'cie',$3) RETURNING id",
      [organizationId, site.rows[0].id, number],
    )
    const reading = await pool.query(
      "INSERT INTO utility_readings(organization_id,meter_id,reading_date,index_milli) VALUES($1,$2,CURRENT_DATE,100000) RETURNING id",
      [organizationId, meter.rows[0].id],
    )
    await pool.query(
      "INSERT INTO utility_reading_photos(organization_id,reading_id,mime_type,byte_size,photo_data) VALUES($1,$2,'image/jpeg',4,$3)",
      [organizationId, reading.rows[0].id, Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    )
  }
  await pool.query(
    "INSERT INTO wash_items(wash_id, service_name, quantity, unit_price_cents, line_total_cents) VALUES($1,'Lavage A',1,100,100)",
    [washA],
  )
  await pool.query(
    "INSERT INTO wash_items(wash_id, service_name, quantity, unit_price_cents, line_total_cents) VALUES($1,'Lavage B',1,200,200)",
    [washB],
  )
})

after(async () => {
  await closeDatabase()
})

test("la base s'exprime au rôle applicatif pendant une requête de station", async () => {
  const q = await runWithTenant(scopeA(), () =>
    pool.query<{ current: string }>("SELECT current_user AS current"),
  )
  if (isRlsRoleAvailable()) {
    assert.equal(
      q.rows[0].current,
      "washpilot_app",
      "les requêtes de station doivent passer par le rôle applicatif, seul sujet aux politiques RLS",
    )
  } else {
    // Sans rôle (hébergement verrouillé), Postgres dispense le propriétaire :
    // l'alerte est déjà journalisée au démarrage. Le test suit l'état réel.
    assert.ok(q.rows[0].current.length > 0)
  }
})

test("sans WHERE, une station ne voit que ses propres dépenses", async () => {
  // La requête fautive d'un développeur distrait : aucun filtre d'organisation.
  const q = await runWithTenant(scopeA(), () =>
    pool.query<{ organization_id: string; amount_cents: number }>(
      "SELECT organization_id, amount_cents FROM expenses",
    ),
  )
  assert.ok(q.rows.length > 0, "la station A doit voir ses dépenses")
  for (const row of q.rows) {
    assert.equal(row.organization_id, orgA, "une dépense d'une autre station a traversé le garde RLS")
  }
  assert.ok(
    q.rows.some((row) => row.amount_cents === 111111),
    "la dépense de la station A doit être visible",
  )
})

test("les compteurs, relevés et photos restent cloisonnés même sans WHERE", async () => {
  for (const table of ["utility_meters", "utility_readings", "utility_reading_photos"]) {
    const q = await runWithTenant(scopeA(), () =>
      pool.query<{ organization_id: string }>(`SELECT organization_id FROM ${table}`),
    )
    assert.ok(q.rows.length > 0, `${table} doit contenir la ligne de la station A`)
    for (const row of q.rows) assert.equal(row.organization_id, orgA, `fuite RLS dans ${table}`)
  }
})

test("un WHERE explicite vers une autre station ne renvoie rien", async () => {
  // Le garde-fou doit tenir même face à une requête qui demande ouvertement
  // les données de la station voisine (identifiant deviné, route oubliée).
  const q = await runWithTenant(scopeA(), () =>
    pool.query("SELECT id FROM expenses WHERE organization_id=$1::uuid", [orgB]),
  )
  assert.equal(q.rowCount, 0, "les dépenses de la station B doivent être invisibles de la station A")
})

test("l'écriture chez une autre station est rejetée par le contrôle des lignes", async () => {
  await assert.rejects(
    () =>
      runWithTenant(scopeA(), () =>
        pool.query(
          "INSERT INTO expenses(organization_id, category, amount_cents, payment_method) VALUES($1,'rent',999999,'cash')",
          [orgB],
        ),
      ),
    /row-level security/i,
  )
})

test("l'écriture chez soi reste possible", async () => {
  const inserted = await runWithTenant(scopeA(), () =>
    pool.query<{ id: string }>(
      "INSERT INTO expenses(organization_id, category, amount_cents, payment_method) VALUES($1,'marketing',333333,'wave') RETURNING id",
      [orgA],
    ),
  )
  assert.equal(inserted.rowCount, 1)
  // Mise en ordre : la ligne repart, créée hors portée.
  await pool.query("DELETE FROM expenses WHERE id=$1::uuid", [inserted.rows[0].id])
})

test("la racine organizations ne montre que la station courante", async () => {
  const q = await runWithTenant(scopeA(), () =>
    pool.query<{ id: string }>("SELECT id FROM organizations"),
  )
  assert.deepEqual(
    q.rows.map((row) => row.id),
    [orgA],
    "une station ne doit voir que sa fiche d'organisation",
  )
})

test("une mise à jour vers une autre station n'atteint aucune ligne", async () => {
  const q = await runWithTenant(scopeA(), () =>
    pool.query("UPDATE organizations SET name='Station compromise' WHERE id=$1::uuid", [orgB]),
  )
  assert.equal(q.rowCount, 0, "la station A ne doit pas pouvoir modifier la station B")
  const check = await pool.query<{ name: string }>("SELECT name FROM organizations WHERE id=$1::uuid", [
    orgB,
  ])
  assert.equal(check.rows[0].name, "Station RLS B")
})

test("les tables filles ne se voient qu'à travers leur mère", async () => {
  const q = await runWithTenant(scopeA(), () =>
    pool.query<{ service_name: string }>("SELECT service_name FROM wash_items"),
  )
  const names = q.rows.map((row) => row.service_name)
  assert.ok(names.includes("Lavage A"), "les lignes du lavage de la station A doivent être visibles")
  assert.ok(!names.includes("Lavage B"), "les lignes du lavage de la station B doivent être invisibles")

  // Attacher une ligne au lavage voisin : interdit, la mère est hors portée.
  await assert.rejects(
    () =>
      runWithTenant(scopeA(), () =>
        pool.query(
          "INSERT INTO wash_items(wash_id, service_name, quantity, unit_price_cents, line_total_cents) VALUES($1,'Ligne parasite',1,1,1)",
          [washB],
        ),
      ),
    /row-level security/i,
  )
})

test("les journaux sans organisation restent lisibles, ceux des autres non", async () => {
  // Une erreur publique (page 404, panne avant identification) n'appartient à
  // personne ; une erreur d'une station ne sort pas de la station.
  await runWithTenant(scopeA(), () =>
    pool.query(
      "INSERT INTO error_events(kind, method, route, path, status, code, message) VALUES('test','GET','/rls','/rls',500,'internal_error','erreur publique')",
    ),
  )
  await runWithTenant(scopeB(), () =>
    pool.query(
      "INSERT INTO error_events(kind, method, route, path, status, code, message, organization_id) VALUES('test','GET','/rls','/rls',500,'internal_error','erreur B',$1::uuid)",
      [orgB],
    ),
  )

  const q = await runWithTenant(scopeA(), () =>
    pool.query<{ message: string; organization_id: string | null }>(
      "SELECT message, organization_id FROM error_events WHERE kind='test'",
    ),
  )
  for (const row of q.rows) {
    assert.ok(
      row.organization_id === null || row.organization_id === orgA,
      "le journal d'erreurs d'une station ne doit pas exposer celles des autres",
    )
  }
  assert.ok(q.rows.some((row) => row.message === "erreur publique"))

  await assert.rejects(
    () =>
      runWithTenant(scopeA(), () =>
        pool.query(
          "INSERT INTO error_events(kind, method, route, path, status, code, message, organization_id) VALUES('test','GET','/rls','/rls',500,'internal_error','intrus',$1::uuid)",
          [orgB],
        ),
      ),
    /row-level security/i,
  )
})

test("hors portée, le chemin système reste multi-clients", async () => {
  // Semis, console de l'éditeur, travaux planifiés : ces passages voient
  // toutes les stations, sans quoi la console ne pourrait plus en administrer
  // aucune. Rien de tout cela n'est exposé à un navigateur de station.
  const q = await pool.query<{ organization_id: string }>(
    "SELECT organization_id FROM expenses WHERE amount_cents IN (111111,222222)",
  )
  const orgs = new Set(q.rows.map((row) => row.organization_id))
  assert.ok(orgs.has(orgA) && orgs.has(orgB), "le chemin système doit voir les deux stations")
})

test("la connexion repart neutre après une requête de station", async () => {
  await runWithTenant(scopeA(), () => pool.query("SELECT id FROM organizations"))
  const q = await pool.query<{ org: string | null; current: string }>(
    "SELECT current_setting('app.current_org', true) AS org, current_user AS current",
  )
  assert.ok(
    !q.rows[0].org,
    "la variable du locataire doit être effacée en rendant la connexion (RESET ou valeur vide)",
  )
  if (isRlsRoleAvailable()) {
    assert.notEqual(q.rows[0].current, "washpilot_app", "le rôle applicatif doit être quitté")
  }
})
