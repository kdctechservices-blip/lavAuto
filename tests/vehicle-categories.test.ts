import test, { before, after } from "node:test"
import assert from "node:assert/strict"
import type { Server } from "node:http"
import type { Pool } from "pg"
import { randomUUID } from "node:crypto"
import { initDatabaseSchema, getPool, closeDatabase } from "../server/db.ts"
import { createApiApp } from "../server/app.ts"
import { invalidateSubscriptionCache } from "../server/entitlements.ts"

// ---------------------------------------------------------------------------
// Catégories de véhicules et familles de tarif
//
// Le catalogue ne proposait que trois entrées et aucun rattachement : une
// prestation ne pouvait pas coûter plus cher sur un SUV que sur une moto.
// Ce fichier vérifie les trois maillons de la chaîne, dans l'ordre où ils
// cassent s'ils cassent :
//
//   1. la catégorie existe et connaît sa famille (référentiel + import) ;
//   2. le serveur accepte — ou refuse — les clés de tarif au bon endroit ;
//   3. le lavage **facture** le prix de la famille, et c'est ce prix-là qui
//      part dans `wash_items`, donc dans les rapports.
// ---------------------------------------------------------------------------

let server: Server
let baseUrl: string
let pool: Pool
let orgId: string
let siteId: string

const PASSWORD = "WashPilot2026!"
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

async function setPlan(code: string) {
  await pool.query(
    `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code=$2),
       status='active', plan_changed_at=now(), updated_at=now() WHERE organization_id=$1::uuid`,
    [orgId, code],
  )
  invalidateSubscriptionCache(orgId)
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

  for (const email of ["demo@washpilot.ci", "gerant@washpilot.ci"]) {
    await login(email)
  }

  const org = await pool.query(
    "SELECT m.organization_id FROM organization_members m JOIN users u ON u.id = m.user_id WHERE u.email='demo@washpilot.ci'",
  )
  orgId = org.rows[0].organization_id
  siteId = (await pool.query("SELECT id FROM sites WHERE organization_id=$1::uuid LIMIT 1", [orgId])).rows[0].id
  await setPlan("pro")
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closeDatabase()
})

// --- 1. Référentiel -------------------------------------------------------

test("le référentiel expose neuf familles et 61 types", async () => {
  const response = await api("/api/v1/vehicle-categories/catalog", { as: "demo@washpilot.ci" })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.families.length, 9)
  assert.equal(body.total_types, 61)
  for (const family of body.families) {
    assert.ok(family.label.length > 0)
    assert.ok(family.types.length > 0)
    for (const type of family.types) {
      assert.equal(typeof type.added, "boolean")
    }
  }
})

test("le référentiel dit ce qui est déjà configuré dans la station", async () => {
  const body = await (await api("/api/v1/vehicle-categories/catalog", { as: "demo@washpilot.ci" })).json()
  const allTypes = body.families.flatMap((family: { types: Array<{ code: string; added: boolean; category_id: string | null }> }) => family.types)
  // La station de démonstration a reçu ses catégories à l'initialisation.
  const added = allTypes.filter((type: { added: boolean }) => type.added)
  assert.ok(added.length > 0, "aucune catégorie de démonstration reconnue dans le référentiel")
  for (const type of added) assert.ok(type.category_id)
  assert.equal(body.added_types, added.length)
})

// --- 2. Ajout en lot ------------------------------------------------------

test("ajouter une famille entière, sans doublon au second passage", async () => {
  const types = ["scooter", "cyclomoteur", "moto-taxi"]
  const first = await api("/api/v1/vehicle-categories/catalog", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { types },
  })
  assert.equal(first.status, 201)
  const created = await first.json()
  assert.equal(created.requested, 3)
  assert.equal(created.added + created.skipped, 3)

  // Rejouer le même ajout ne crée aucun doublon : c'est ce qui rend le bouton
  // « toute la famille » utilisable sans réfléchir.
  const second = await api("/api/v1/vehicle-categories/catalog", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { types },
  })
  assert.equal(second.status, 201)
  assert.equal((await second.json()).added, 0)

  const rows = await pool.query(
    "SELECT name, family FROM vehicle_categories WHERE organization_id=$1::uuid AND name = ANY($2::text[])",
    [orgId, ["Scooter", "Cyclomoteur", "Moto-taxi"]],
  )
  assert.equal(rows.rowCount, 3)
  for (const row of rows.rows) assert.equal(row.family, "deux_roues")
})

test("un type inconnu est refusé, et rien n'est ajouté", async () => {
  const before = await pool.query(
    "SELECT count(*)::int AS n FROM vehicle_categories WHERE organization_id=$1::uuid",
    [orgId],
  )
  const response = await api("/api/v1/vehicle-categories/catalog", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { types: ["dragster"] },
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, "invalid_vehicle_type")
  const afterCount = await pool.query(
    "SELECT count(*)::int AS n FROM vehicle_categories WHERE organization_id=$1::uuid",
    [orgId],
  )
  assert.equal(afterCount.rows[0].n, before.rows[0].n)
})

test("la liste rendue est rangée par famille, pas par ordre alphabétique", async () => {
  const rows = await (await api("/api/v1/vehicle-categories", { as: "demo@washpilot.ci" })).json()
  const names = rows.map((row: { name: string }) => row.name)
  // « Moto » (deux-roues) passe avant « Berline moyenne » (berlines), qui
  // passe avant « SUV familial », quel que soit l'alphabet.
  assert.ok(names.indexOf("Moto") < names.indexOf("Berline moyenne"))
  assert.ok(names.indexOf("Berline moyenne") < names.indexOf("SUV familial"))
})

// --- 3. Création / modification ------------------------------------------

test("une famille inconnue est refusée à la création", async () => {
  const response = await api("/api/v1/vehicle-categories", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: "Véhicule maison", family: "soucoupe" },
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, "invalid_vehicle_family")
})

test("créer une catégorie avec sa famille, puis la reclasser", async () => {
  const created = await api("/api/v1/vehicle-categories", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: "Pick-up atelier", family: "utilitaires" },
  })
  assert.equal(created.status, 201)
  const category = await created.json()
  assert.equal(category.family, "utilitaires")
  assert.ok(category.updated_at, "updated_at doit exister réellement")

  const patched = await api(`/api/v1/vehicle-categories/${category.id}`, {
    as: "demo@washpilot.ci",
    method: "PATCH",
    body: { family: "suv" },
  })
  assert.equal(patched.status, 200)
  const updated = await patched.json()
  assert.equal(updated.family, "suv")
  assert.notEqual(updated.updated_at, category.updated_at, "updated_at doit bouger à la modification")

  // L'écriture est tracée : un changement de référentiel qui touche aux tarifs
  // ne peut pas être anonyme.
  const audit = await pool.query(
    "SELECT action FROM audit_logs WHERE organization_id=$1::uuid AND entity_id=$2 ORDER BY created_at",
    [orgId, category.id],
  )
  assert.deepEqual(
    audit.rows.map((row) => row.action),
    ["vehicle_category.created", "vehicle_category.updated"],
  )
})

test("un gérant lit le référentiel mais ne peut pas l'écrire", async () => {
  const read = await api("/api/v1/vehicle-categories", { as: "gerant@washpilot.ci" })
  const write = await api("/api/v1/vehicle-categories", {
    as: "gerant@washpilot.ci",
    method: "POST",
    body: { name: "Catégorie du gérant" },
  })
  assert.equal(read.status, 200)
  assert.equal(write.status, 403)
})

// --- 4. Tarification par famille -----------------------------------------

test("un ancien tarif de famille ne décide plus rien : sans autorisation explicite, le lavage est refusé", async () => {
  const suv = await api("/api/v1/vehicle-categories", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: "SUV de test tarif", family: "suv" },
  })
  assert.equal(suv.status, 201)
  const suvCategory = await suv.json()

  // Données héritées de l'ancien modèle, gravées comme l'ancienne version le
  // faisait : prix de base + tarif de famille. Elles ne doivent plus rien
  // décider — ni éligibilité, ni prix. L'écran d'API les expose encore
  // (affichage), mais le lavage ne s'appuie que sur les autorisations
  // explicites de `service_vehicle_prices`.
  const legacy = await pool.query(
    `INSERT INTO services(organization_id, name, price_cents, price_by_vehicle_type, duration_minutes, is_active)
     VALUES($1::uuid,'Lavage test famille',200000,'{"suv":450000}',30,true) RETURNING id`,
    [orgId],
  )
  const legacyId = legacy.rows[0].id

  const wash = await api("/api/v1/washes", {
    as: "demo@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: {
      site_id: siteId,
      vehicle_category_id: suvCategory.id,
      items: [{ service_id: legacyId, quantity: 2 }],
      worker_ids: [],
      payment_method: "orange_money",
      amount_received_cents: 0,
    },
  })
  assert.equal(wash.status, 400, "le tarif de famille ne doit pas rendre la prestation disponible")
  assert.equal((await wash.json()).error.code, "service_not_available_for_vehicle")
})

test("le tarif facturé est celui de la catégorie, explicite", async () => {
  const moto = await pool.query(
    "SELECT id FROM vehicle_categories WHERE organization_id=$1::uuid AND name='Moto' LIMIT 1",
    [orgId],
  )
  const motoId = moto.rows[0].id

  const service = await api("/api/v1/services", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: {
      name: "Lavage test catégorie exacte",
      duration_minutes: 30,
      vehicle_pricing: [{ vehicle_category_id: motoId, price_cents: 50_000 }],
    },
  })
  assert.equal(service.status, 201)
  const created = await service.json()

  // Un reliquat d'ancien tarif de famille, gravé à côté, n'altère rien.
  await pool.query(
    `UPDATE services SET price_by_vehicle_type = price_by_vehicle_type || '{"deux_roues":100000}'::jsonb WHERE id=$1::uuid`,
    [created.id],
  )

  const wash = await api("/api/v1/washes", {
    as: "demo@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: {
      site_id: siteId,
      vehicle_category_id: motoId,
      items: [{ service_id: created.id, quantity: 1 }],
      worker_ids: [],
      payment_method: "orange_money",
      amount_received_cents: 0,
    },
  })
  assert.equal(wash.status, 201)
  assert.equal((await wash.json()).total_cents, 50_000, "500 F pour la moto, pas le tarif de famille")
})

test("les champs de tarif hérités ne sont plus des entrées : la sauvegarde exige les catégories autorisées", async () => {
  const onlyLegacy = await api("/api/v1/services", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: "Tarif famille inconnue", price_cents: 1000, price_by_vehicle_type: { avion: 5000 } },
  })
  assert.equal(onlyLegacy.status, 400)
  assert.equal((await onlyLegacy.json()).error.code, "vehicle_pricing_required")

  const unknownCategory = await api("/api/v1/services", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: {
      name: "Tarif catégorie inconnue",
      vehicle_pricing: [{ vehicle_category_id: randomUUID(), price_cents: 5000 }],
    },
  })
  assert.equal(unknownCategory.status, 400)
  assert.equal((await unknownCategory.json()).error.code, "invalid_vehicle_category")
})

test("un tarif par catégorie d'une autre station est refusé", async () => {
  // Catégorie appartenant à une autre organisation, créée pour l'occasion :
  // la base de test ne contient que la station de démonstration.
  const otherOrg = await pool.query(
    "INSERT INTO organizations(name) VALUES('Station voisine') RETURNING id",
  )
  const foreign = await pool.query(
    `INSERT INTO vehicle_categories(organization_id, name, family)
     VALUES($1::uuid,'Catégorie voisine','suv') RETURNING id`,
    [otherOrg.rows[0].id],
  )
  const response = await api("/api/v1/services", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: {
      name: "Tarif volé",
      vehicle_pricing: [{ vehicle_category_id: foreign.rows[0].id, price_cents: 5000 }],
    },
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, "invalid_vehicle_category")
})

// --- 5. Suppression -------------------------------------------------------

test("supprimer une catégorie retire aussi son autorisation et son tarif", async () => {
  const created = await api("/api/v1/vehicle-categories", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: "Catégorie éphémère", family: "berlines" },
  })
  const category = await created.json()
  const keptCreated = await api("/api/v1/vehicle-categories", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: "Catégorie sœur de tarif", family: "suv" },
  })
  const keptCategory = await keptCreated.json()

  const service = await api("/api/v1/services", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: {
      name: "Prestation à tarif orphelin",
      vehicle_pricing: [
        { vehicle_category_id: category.id, price_cents: 300_000 },
        { vehicle_category_id: keptCategory.id, price_cents: 400_000 },
      ],
    },
  })
  assert.equal(service.status, 201)
  const created2 = await service.json()

  const deleted = await api(`/api/v1/vehicle-categories/${category.id}`, {
    as: "demo@washpilot.ci",
    method: "DELETE",
  })
  assert.equal(deleted.status, 204)

  // L'association est partie avec la catégorie (clé étrangère en cascade) :
  // plus aucune autorisation orpheline, et le miroir hérité est nettoyé.
  const rows = await pool.query(
    "SELECT vehicle_category_id FROM service_vehicle_prices WHERE service_id=$1::uuid",
    [created2.id],
  )
  assert.equal(rows.rowCount, 1, "une seule association survit")
  assert.equal(String(rows.rows[0].vehicle_category_id), String(keptCategory.id))
  const after = await pool.query("SELECT price_by_vehicle_type FROM services WHERE id=$1::uuid", [created2.id])
  assert.deepEqual(after.rows[0].price_by_vehicle_type, { [String(keptCategory.id)]: 400_000 })
})

test("une catégorie utilisée par un lavage ne peut pas être supprimée", async () => {
  const created = await api("/api/v1/vehicle-categories", {
    as: "demo@washpilot.ci",
    method: "POST",
    body: { name: "Catégorie utilisée", family: "berlines" },
  })
  const category = await created.json()
  const service = await (
    await api("/api/v1/services", {
      as: "demo@washpilot.ci",
      method: "POST",
      body: {
        name: "Prestation catégorie utilisée",
        vehicle_pricing: [{ vehicle_category_id: category.id, price_cents: 5000 }],
      },
    })
  ).json()

  const wash = await api("/api/v1/washes", {
    as: "demo@washpilot.ci",
    method: "POST",
    key: randomUUID(),
    body: {
      site_id: siteId,
      vehicle_category_id: category.id,
      items: [{ service_id: service.id, quantity: 1 }],
      worker_ids: [],
      payment_method: "orange_money",
      amount_received_cents: 0,
    },
  })
  assert.equal(wash.status, 201)

  const deleted = await api(`/api/v1/vehicle-categories/${category.id}`, {
    as: "demo@washpilot.ci",
    method: "DELETE",
  })
  assert.equal(deleted.status, 409)
  assert.equal((await deleted.json()).error.code, "category_in_use")
})
