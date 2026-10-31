import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { buildOrganizationBackup } from "../server/backup.ts"
import type { Pool } from "pg"

// ---------------------------------------------------------------------------
// Isolation multi-station
//
// Une station ne doit jamais voir les données d'une autre. Ce test crée une
// seconde organisation complète (station, catalogue, laveur, lavage, paiement,
// dépense) à côté de l'organisation de démonstration, puis vérifie que les
// lectures scopées par `organization_id` ne laissent rien filtrer.
// ---------------------------------------------------------------------------

let pool: Pool
let orgA: string // organisation de démonstration
let orgB: string // seconde station, créée par ce test
let washB: string

before(async () => {
  const ready = await initDatabaseSchema()
  assert.ok(ready, "la base de test doit être initialisée")
  pool = getPool() as Pool

  const demo = await pool.query("SELECT id FROM organizations ORDER BY created_at LIMIT 1")
  orgA = demo.rows[0].id

  // --- Seconde station, totalement indépendante -----------------------------
  const org = await pool.query(
    "INSERT INTO organizations(name, slug) VALUES('Station Yopougon','station-yopougon') RETURNING id",
  )
  orgB = org.rows[0].id

  const site = await pool.query(
    "INSERT INTO sites(organization_id, name, city, address) VALUES($1,'Yopougon Siporex','Abidjan','Yopougon') RETURNING id",
    [orgB],
  )
  const category = await pool.query(
    "INSERT INTO service_categories(organization_id, name) VALUES($1,'Lavage') RETURNING id",
    [orgB],
  )
  const vehicle = await pool.query(
    "INSERT INTO vehicle_categories(organization_id, name) VALUES($1,'Berline') RETURNING id",
    [orgB],
  )
  const service = await pool.query(
    `INSERT INTO services(organization_id, category_id, name, price_cents, is_active)
     VALUES($1,$2,'Lavage complet',500000,true) RETURNING id`,
    [orgB, category.rows[0].id],
  )
  const worker = await pool.query(
    `INSERT INTO workers(organization_id, site_id, first_name, last_name, role, status)
     VALUES($1,$2,'Koffi','Yao','car_washer','active') RETURNING id`,
    [orgB, site.rows[0].id],
  )
  const wash = await pool.query(
    `INSERT INTO washes(organization_id, site_id, vehicle_category_id, reference,
                        status, payment_status, total_cents)
     VALUES($1,$2,$3,'YOP-0001','completed','paid',500000) RETURNING id`,
    [orgB, site.rows[0].id, vehicle.rows[0].id],
  )
  washB = wash.rows[0].id

  await pool.query(
    `INSERT INTO wash_items(wash_id, service_id, service_name, quantity, unit_price_cents, line_total_cents)
     VALUES($1,$2,'Lavage complet',1,500000,500000)`,
    [washB, service.rows[0].id],
  )
  await pool.query("INSERT INTO wash_assignments(wash_id, worker_id) VALUES($1,$2)", [
    washB,
    worker.rows[0].id,
  ])
  await pool.query(
    `INSERT INTO payments(organization_id, wash_id, method, amount_cents, status)
     VALUES($1,$2,'wave',500000,'verified')`,
    [orgB, washB],
  )
})

after(async () => {
  await closeDatabase()
})

test("chaque station ne voit que ses propres lavages", async () => {
  const a = await pool.query("SELECT id FROM washes WHERE organization_id=$1::uuid", [orgA])
  const b = await pool.query("SELECT id FROM washes WHERE organization_id=$1::uuid", [orgB])

  const idsA = new Set(a.rows.map((row) => row.id))
  assert.ok(b.rows.length > 0, "la seconde station doit avoir au moins un lavage")
  for (const row of b.rows) {
    assert.equal(idsA.has(row.id), false, "un lavage de la station B ne doit jamais apparaître côté A")
  }
})

test("un identifiant de lavage d'une autre station reste introuvable", async () => {
  // C'est exactement la requête de GET /washes/:id : id + organization_id.
  const q = await pool.query("SELECT id FROM washes WHERE id=$1::uuid AND organization_id=$2::uuid", [
    washB,
    orgA,
  ])
  assert.equal(q.rowCount, 0, "la station A ne doit pas pouvoir ouvrir un lavage de la station B")
})

test("l'export de sauvegarde d'une station ne contient aucune donnée de l'autre", async () => {
  const backupB = await buildOrganizationBackup(pool, orgB)
  const washesA = await pool.query("SELECT id FROM washes WHERE organization_id=$1::uuid", [orgA])
  const idsA = new Set(washesA.rows.map((row) => row.id))

  assert.equal((backupB.data.organization as { id: string }).id, orgB)
  for (const wash of backupB.data.washes as { id: string; organization_id: string }[]) {
    assert.equal(wash.organization_id, orgB)
    assert.equal(idsA.has(wash.id), false)
  }
  // Les tables enfants passent par une jointure : elles doivent rester scopées.
  const items = backupB.data.wash_items as { wash_id: string }[]
  assert.ok(items.every((item) => item.wash_id === washB))
  assert.equal(backupB.counts.payments, 1)
})

test("les agrégats financiers sont cloisonnés par station", async () => {
  const q = await pool.query<{ organization_id: string; total: string }>(
    `SELECT organization_id, COALESCE(SUM(amount_cents),0)::text AS total
     FROM payments WHERE status <> 'refunded' GROUP BY organization_id`,
  )
  const byOrg = new Map(q.rows.map((row) => [row.organization_id, Number(row.total)]))
  assert.equal(byOrg.get(orgB), 500000)
  assert.notEqual(byOrg.get(orgA), byOrg.get(orgB))
})

test("les laveurs et le catalogue d'une station restent invisibles pour l'autre", async () => {
  for (const table of ["workers", "services", "sites", "vehicle_categories"]) {
    const a = await pool.query(`SELECT id FROM ${table} WHERE organization_id=$1::uuid`, [orgA])
    const b = await pool.query(`SELECT id FROM ${table} WHERE organization_id=$1::uuid`, [orgB])
    const idsA = new Set(a.rows.map((row) => row.id))
    for (const row of b.rows) {
      assert.equal(idsA.has(row.id), false, `fuite détectée dans ${table}`)
    }
  }
})
