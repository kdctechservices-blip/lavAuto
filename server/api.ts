import { Router } from "express"
import { z } from "zod"
import type { Pool } from "pg"
import { getPool } from "./db.ts"
import { asyncRoute, body, tenant, parseId, requirePermission, HttpError } from "./http.ts"
import { fingerprint, withIdempotency } from "./idempotency.ts"
import { consumeForWash, reverseWashConsumption } from "./stock.ts"
import { initialPaymentStatus, resolvePaymentStatus, PAYMENT_METHODS } from "./payments.ts"
import { plateDisplay, plateKey } from "./plate.ts"
import { assertSiteCapacity, assertSiteWritable, loadSiteLimitState } from "./plan-limits.ts"
import {
  VEHICLE_FAMILIES,
  VEHICLE_TYPES,
  isVehicleFamily,
  sortVehicleCategories,
  vehicleType,
} from "../src/config/vehicle-taxonomy.ts"

export const catalogValidators = {
  category: z
    .object({
      name: z.string().trim().min(1, "Le nom est obligatoire.").max(100),
      is_active: z.boolean().optional(),
    })
    .strip(),
  service: z
    .object({
      template_id: z.string().uuid().nullable().optional(),
      name: z.string().trim().min(1, "Le nom est obligatoire.").max(120),
      description: z.string().max(1000).nullable().optional(),
      category_id: z.string().uuid().nullable().optional(),
      duration_minutes: z.number().int().min(1).max(1440).nullable().optional(),
      is_active: z.boolean().optional(),
      /**
       * Éligibilité + tarif, inséparables : une entrée = « cette catégorie de
       * véhicule peut bénéficier de la prestation, à ce prix ». Au moins une
       * catégorie ; un prix obligatoire par catégorie — jamais de zéro par
       * silence. Les anciens champs `price_cents` / `price_by_vehicle_type`
       * n'entrent plus dans ce contrat : eux seuls ne distinguaient pas
       * l'éligibilité du tarif.
       */
      vehicle_pricing: z
        .array(
          z
            .object({
              vehicle_category_id: z.string().uuid(),
              // Absent ou nul passe le schéma pour que le refus métier puisse
              // nommer la catégorie (« Renseignez le prix pour la catégorie
              // Berline. »). `assertVehiclePricing` refuse ensuite toujours
              // une sauvegarde sans tarif : jamais de zéro par silence.
              price_cents: z.number().int().min(0).max(100000000).nullish(),
            })
            .strip(),
        )
        // Le minimum d'une catégorie est un refus métier (code
        // `vehicle_pricing_required`), pas une erreur de schéma : le message
        // doit rester celui du catalogue d'erreurs, quel que soit le champ
        // manquant. Le schéma ne borne que la taille haute et chaque entrée.
        .max(200)
        .optional(),
    })
    .strip(),
  /**
   * Catégorie de véhicule : même socle que les autres catégories, plus la
   * famille (qui porte le tarif) et le rang d'affichage.
   *
   * `family` reste un texte libre validé contre le référentiel : la base
   * n'impose pas de clé étrangère, une station peut donc ranger une catégorie
   * maison dans une famille connue sans migration.
   */
  vehicleCategory: z
    .object({
      name: z.string().trim().min(1, "Le nom est obligatoire.").max(100),
      is_active: z.boolean().optional(),
      family: z.string().trim().max(40).nullable().optional(),
      sort_order: z.number().int().min(0).max(999).optional(),
    })
    .strip(),
  /** Ajout en lot depuis le référentiel : codes de types (`suv_familial`) ou libellés. */
  vehicleCategoryImport: z
    .object({
      types: z.array(z.string().trim().min(1).max(120)).min(1, "Sélectionnez au moins un type.").max(200),
    })
    .strip(),
  site: z
    .object({
      name: z.string().trim().min(2).max(120),
      city: z.string().trim().min(1).max(120),
      address: z.string().trim().max(300).nullable().optional(),
      phone: z.string().trim().max(30).nullable().optional(),
      email: z.string().trim().max(200).nullable().optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      is_active: z.boolean().optional(),
    })
    .strip(),
}

/** UUID canonique : sert à distinguer une clé de tarif « catégorie » d'une famille. */
/**
 * Refuse une famille inconnue.
 *
 * Une faute de frappe (`suvs`, `poids-lourd`) rangerait la catégorie dans une
 * famille qui n'existe nulle part : elle n'apparaîtrait dans aucun
 * regroupement et ne recevrait aucun tarif de famille. Mieux vaut un 400 net
 * au moment de l'écriture qu'une catégorie silencieusement orpheline.
 */
function assertVehicleFamily(family: string | null | undefined) {
  if (family == null || family === "") return
  if (!isVehicleFamily(family)) {
    throw new HttpError(
      400,
      "invalid_vehicle_family",
      `Famille de véhicules inconnue : « ${family} ». Choisissez-en une dans la liste proposée.`,
    )
  }
}

/**
 * Valide la liste « catégories autorisées + tarif » d'une prestation.
 *
 * C'est le cœur du contrat : une entrée = une catégorie de véhicule
 * autorisée, avec **son** prix. Chaque contrôle a son message :
 *   • liste vide → « Sélectionnez au moins une catégorie de véhicule. » ;
 *   • catégorie listée deux fois → refus (laquelle des deux prix croirait ?) ;
 *   • prix absent ou non numérique → jamais remplacé par zéro en silence ;
 *   • catégorie inconnue, d'une autre station, ou inactive (hors associations
 *     déjà enregistrées) → « Cette catégorie de véhicule n'est plus
 *     disponible. »
 *
 * `keepExisting` porte les catégories déjà associées à la prestation en
 * modification : une catégorie **devenue** inactive n'est pas effacée en
 * silence — l'association est conservée et l'écran l'annonce explicitement.
 * En revanche, on ne peut pas **ajouter** une association à une catégorie
 * inactive.
 */
interface VehiclePriceInput {
  vehicle_category_id: string
  price_cents?: unknown
}

async function assertVehiclePricing(
  vehiclePricing: VehiclePriceInput[] | null | undefined,
  organizationId: string,
  keepExisting: Set<string> = new Set(),
): Promise<void> {
  if (!vehiclePricing || vehiclePricing.length === 0) {
    throw new HttpError(
      400,
      "vehicle_pricing_required",
      "Sélectionnez au moins une catégorie de véhicule.",
    )
  }
  const seen = new Set<string>()
  for (const entry of vehiclePricing) {
    if (seen.has(entry.vehicle_category_id)) {
      throw new HttpError(
        400,
        "duplicate_vehicle_category",
        "Une catégorie de véhicule est listée deux fois.",
      )
    }
    seen.add(entry.vehicle_category_id)
  }

  const q = await db().query(
    "SELECT id, name, is_active FROM vehicle_categories WHERE organization_id=$1::uuid AND id = ANY($2::uuid[])",
    [organizationId, [...seen]],
  )
  const found = new Map(q.rows.map((row) => [String(row.id), row as { name: string; is_active: boolean }]))

  for (const entry of vehiclePricing) {
    const category = found.get(entry.vehicle_category_id)
    if (!category) {
      throw new HttpError(
        400,
        "invalid_vehicle_category",
        "Cette catégorie de véhicule n'est plus disponible.",
      )
    }
    if (!category.is_active && !keepExisting.has(entry.vehicle_category_id)) {
      throw new HttpError(
        400,
        "inactive_vehicle_category",
        `Cette catégorie de véhicule n'est plus disponible : « ${category.name} ».`,
      )
    }
    const price = entry.price_cents
    if (price === undefined || price === null || (typeof price === "number" && Number.isNaN(price))) {
      throw new HttpError(
        400,
        "vehicle_price_required",
        `Renseignez le prix pour la catégorie ${category.name}.`,
      )
    }
    if (typeof price !== "number" || !Number.isInteger(price) || price < 0 || price > 100000000) {
      throw new HttpError(400, "invalid_vehicle_price", "Le prix doit être un montant valide en FCFA.")
    }
  }
}

/**
 * Le type de service choisi doit exister et être actif au catalogue.
 *
 * Le formulaire ne propose jamais un type supprimé ou désactivé ; le serveur
 * le refuse pareillement, même envoyé à la main.
 */
async function assertServiceTemplate(templateId: string | null | undefined): Promise<void> {
  if (!templateId) return
  const q = await db().query("SELECT 1 FROM service_catalog WHERE id=$1::uuid AND is_active", [templateId])
  if (!q.rowCount) {
    throw new HttpError(
      400,
      "invalid_service_template",
      "Ce type de service n'est plus disponible.",
    )
  }
}

/**
 * Représentation API d'une prestation : associations d'éligibilité en liste
 * (`vehicle_pricing`, le contrat) et en map (`vehicle_prices`, pour les
 * écrans qui indexent par catégorie).
 */
function serviceResponse(
  row: Record<string, unknown>,
  pricing: Array<{ vehicle_category_id: string; price_cents: number }>,
): Record<string, unknown> {
  return {
    ...row,
    vehicle_pricing: pricing,
    vehicle_prices: Object.fromEntries(pricing.map((entry) => [entry.vehicle_category_id, entry.price_cents])),
  }
}

/** Charge les associations de plusieurs prestations en une requête. */
async function loadServicePricing(
  serviceIds: string[],
): Promise<Map<string, Array<{ vehicle_category_id: string; price_cents: number }>>> {
  const byService = new Map<string, Array<{ vehicle_category_id: string; price_cents: number }>>()
  if (serviceIds.length === 0) return byService
  const q = await db().query(
    "SELECT service_id, vehicle_category_id, price_cents FROM service_vehicle_prices WHERE service_id = ANY($1::uuid[]) ORDER BY created_at",
    [serviceIds],
  )
  for (const row of q.rows) {
    const list = byService.get(String(row.service_id)) ?? []
    list.push({ vehicle_category_id: String(row.vehicle_category_id), price_cents: Number(row.price_cents) })
    byService.set(String(row.service_id), list)
  }
  return byService
}

/** Trace une écriture du catalogue des prestations (prix compris). */
async function auditService(
  q: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  t: { organizationId: string; userId: string },
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
) {
  await q.query(
    `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES($1,$2,$3,'service',$4,$5)`,
    [t.organizationId, t.userId, action, entityId, JSON.stringify(metadata)],
  )
}

/** Trace une écriture sur le référentiel des véhicules. */
async function auditVehicleCategory(
  t: { organizationId: string; userId: string },
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
) {
  await db().query(
    `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES($1,$2,$3,'vehicle_category',$4,$5)`,
    [t.organizationId, t.userId, action, entityId, JSON.stringify(metadata)],
  )
}

export const washValidators = {
  create: z
    .object({
      site_id: z.string().uuid(),
      vehicle_category_id: z.string().uuid(),
      items: z
        .array(
          z.object({
            service_id: z.string().uuid(),
            quantity: z.number().int().min(1).max(100),
          }),
        )
        .min(1, "Sélectionnez au moins une prestation."),
      worker_ids: z.array(z.string().uuid()).max(50).default([]),
      // Responsable principal, facultatif. Il doit figurer parmi les laveurs
      // affectés : désigner un responsable absent de l'équipe du lavage
      // produirait une statistique que personne ne pourrait expliquer.
      principal_worker_id: z.string().uuid().nullable().optional(),
      payment_method: z.enum(PAYMENT_METHODS),
      amount_received_cents: z.number().int().min(0).max(100000000),
      cash_session_id: z.string().uuid().optional(),
      // Plaque du vehicule, facultative. Aucun format n'est impose : une
      // saisie refusee bloquerait un encaissement.
      plate: z.string().trim().max(32).nullable().optional(),
      // Nom du client, facultatif. Une etiquette de comptoir, pas une fiche :
      // ni telephone, ni historique, ni rien qui fasse un dossier client.
      customer_name: z.string().trim().max(80).nullable().optional(),
    })
    .strip(),
  cancel: z
    .object({
      reason: z.string().trim().min(3, "Indiquez le motif de l’annulation.").max(500),
    })
    .strip(),
  // Avancement operationnel du lavage. Valeurs volontairement fermees : ce
  // sont les trois etats que l'interface propose, et rien d'autre ne doit
  // pouvoir etre ecrit dans la colonne. Le message d'erreur est produit par
  // server/validation-messages.ts : « Le statut ne fait pas partie des
  // choix possibles. »
  status: z
    .object({
      status: z.enum(["pending", "in_progress", "completed", "overtime"]),
    })
    .strip(),
}

function db(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

/**
 * Les laveurs affectes a chaque lavage, nommes.
 *
 * Une seule requete pour tous les lavages demandes : la liste des taches en
 * cours affiche jusqu'a cinq cartes, et cinq requetes pour five noms
 * seraient cinq fois plus de voyages pour rien.
 *
 * Le responsable d'abord, les autres ensuite, par ordre de nom : la carte
 * affiche ce que l'utilisateur voit d'abord, et un ordre stable evite que
 * la liste change d'ordre a chaque rafraichissement.
 */
async function loadWashWorkers(
  pool: Pool,
  organizationId: string,
  washIds: string[],
): Promise<Map<string, Array<{ id: string; name: string; role: string }>>> {
  const parLavage = new Map<string, Array<{ id: string; name: string; role: string }>>()
  if (washIds.length === 0) return parLavage

  const q = await pool.query(
    `SELECT a.wash_id, w.id, w.first_name, w.last_name, a.assignment_role
       FROM wash_assignments a
       JOIN workers w ON w.id = a.worker_id
      WHERE w.organization_id=$1::uuid AND a.wash_id = ANY($2::uuid[])
      ORDER BY (a.assignment_role = 'principal') DESC, w.first_name, w.last_name`,
    [organizationId, washIds],
  )
  for (const row of q.rows) {
    const nom = [row.first_name, row.last_name].filter(Boolean).join(" ").trim()
    const liste = parLavage.get(row.wash_id) ?? []
    liste.push({ id: row.id, name: nom, role: row.assignment_role })
    parLavage.set(row.wash_id, liste)
  }
  return parLavage
}

const WASH_FIELDS = `id, reference, site_id, vehicle_category_id, customer_id, plate, status, payment_status,
  operation_status, operation_started_at, estimated_minutes, customer_name,
  total_cents, payment_method, created_by AS author_id, cancelled_by AS cancelled_by_id,
  cancelled_at, cancellation_reason, created_at, completed_at`

/**
 * Duree de repli quand aucune prestation ne dit combien de temps elle prend.
 *
 * Une tache sans horizon ne se compte pas : la barre n'avancerait jamais et
 * l'utilisateurcroirait la station bloquee. Trente minutes est la duree la
 * plus courante d'un lavage, et c'est une estimation de terrain, pas une
 * donnee comptable.
 */
const MAX_ACTIVE_WASH_TASKS = 5

const DEFAULT_ESTIMATED_MINUTES = 30

export function createApiRouter() {
  const r = Router()

  // ---------------------------------------------------------------- sites --
  r.get(
    "/sites",
    requirePermission("wash:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const pool = db()
      const q = await pool.query(
        "SELECT id, name, city, address, phone, email, description, logo_url, slug, is_active, created_at, updated_at FROM sites WHERE organization_id=$1::uuid ORDER BY created_at",
        [t.organizationId],
      )
      // `writable` dit à l'interface ce que le serveur refusera de toute façon :
      // après une rétrogradation, les stations excédentaires restent listées et
      // consultables, mais n'acceptent plus de nouvelle opération.
      const limit = await loadSiteLimitState(pool, t.organizationId)
      const writableIds =
        limit.enforced && limit.limit !== null
          ? new Set(
              q.rows.filter((row) => row.is_active).slice(0, limit.limit).map((row) => row.id),
            )
          : null
      res.json(
        q.rows.map((row) => ({
          ...row,
          writable: writableIds ? writableIds.has(row.id) : true,
        })),
      )
    }),
  )

  r.get(
    "/sites/:id",
    requirePermission("wash:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const q = await db().query("SELECT * FROM sites WHERE id=$1::uuid AND organization_id=$2::uuid", [id, t.organizationId])
      if (!q.rowCount) throw new HttpError(404, "site_not_found", "Station introuvable.")
      res.json(q.rows[0])
    }),
  )

  r.post(
    "/sites",
    requirePermission("settings:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(catalogValidators.site, req.body)
      // Le plafond se vérifie sous verrou : deux créations simultanées
      // passeraient toutes les deux un simple COUNT.
      const client = await db().connect()
      try {
        await client.query("BEGIN")
        await assertSiteCapacity(client, t.organizationId)
        const created = await client.query(
          `INSERT INTO sites(organization_id, name, city, address, phone, email, description, is_active)
           VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE($8,true)) RETURNING *`,
          [t.organizationId, input.name, input.city, input.address ?? null, input.phone ?? null, input.email ?? null, input.description ?? null, input.is_active ?? null],
        )
        await client.query("COMMIT")
        res.status(201).json(created.rows[0])
        return
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }),
  )

  r.patch(
    "/sites/:id",
    requirePermission("settings:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(catalogValidators.site.partial(), req.body)
      const oldQ = await db().query("SELECT * FROM sites WHERE id=$1::uuid AND organization_id=$2::uuid", [id, t.organizationId])
      if (!oldQ.rowCount) throw new HttpError(404, "site_not_found", "Station introuvable.")
      const merged = { ...oldQ.rows[0], ...input }
      const reactivating = oldQ.rows[0].is_active === false && merged.is_active === true
      const client = await db().connect()
      try {
        await client.query("BEGIN")
        if (reactivating) await assertSiteCapacity(client, t.organizationId)
        const q = await client.query(
          `UPDATE sites SET name=$3, city=$4, address=$5, phone=$6, email=$7, description=$8, is_active=$9, updated_at=now()
           WHERE id=$1::uuid AND organization_id=$2::uuid RETURNING *`,
          [id, t.organizationId, merged.name, merged.city, merged.address, merged.phone, merged.email, merged.description, merged.is_active],
        )
        await client.query("COMMIT")
        res.json(q.rows[0])
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }),
  )

  // DELETE /api/v1/sites/:id — refuse when operations or utility meters still reference the site.
  r.delete(
    "/sites/:id",
    requirePermission("settings:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const pool = db()
      const siteQ = await pool.query("SELECT 1 FROM sites WHERE id=$1::uuid AND organization_id=$2::uuid", [id, t.organizationId])
      if (!siteQ.rowCount) throw new HttpError(404, "site_not_found", "Station introuvable.")
      const refs = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM washes WHERE site_id=$1::uuid) +
           (SELECT COUNT(*) FROM cash_sessions WHERE site_id=$1::uuid) +
           (SELECT COUNT(*) FROM expenses WHERE site_id=$1::uuid) +
           (SELECT COUNT(*) FROM utility_meters WHERE site_id=$1::uuid) +
           (SELECT COUNT(*) FROM workers WHERE site_id=$1::uuid)::int AS ref_count`,
        [id],
      )
      if (Number(refs.rows[0].ref_count) > 0) {
        throw new HttpError(409, "site_in_use", "Des lavages, caisses, dépenses, compteurs ou travailleurs référencent cette station. Désactivez-la plutôt.")
      }
      await pool.query("DELETE FROM sites WHERE id=$1::uuid AND organization_id=$2::uuid", [id, t.organizationId])
      res.status(204).send()
    }),
  )

  // --------------------------------------------------- service categories --
  r.get(
    "/service-categories",
    requirePermission("service:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query(
        "SELECT id, name, is_active, created_at, updated_at FROM service_categories WHERE organization_id=$1::uuid ORDER BY name",
        [t.organizationId],
      )
      res.json(q.rows)
    }),
  )

  r.post(
    "/service-categories",
    requirePermission("service:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(catalogValidators.category, req.body)
      try {
        const q = await db().query(
          "INSERT INTO service_categories(organization_id, name, is_active) VALUES($1,$2,COALESCE($3,true)) RETURNING id, name, is_active, created_at, updated_at",
          [t.organizationId, input.name, input.is_active ?? null],
        )
        res.status(201).json(q.rows[0])
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new HttpError(409, "category_exists", "Une catégorie portant ce nom existe déjà.")
        }
        throw error
      }
    }),
  )

  r.patch(
    "/service-categories/:id",
    requirePermission("service:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(catalogValidators.category.partial(), req.body)
      const oldQ = await db().query("SELECT * FROM service_categories WHERE id=$1::uuid AND organization_id=$2::uuid", [id, t.organizationId])
      if (!oldQ.rowCount) throw new HttpError(404, "category_not_found", "Catégorie introuvable.")
      const merged = { ...oldQ.rows[0], ...input }
      try {
        const q = await db().query(
          "UPDATE service_categories SET name=$3, is_active=$4, updated_at=now() WHERE id=$1::uuid AND organization_id=$2::uuid RETURNING id, name, is_active, created_at, updated_at",
          [id, t.organizationId, merged.name, merged.is_active],
        )
        res.json(q.rows[0])
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new HttpError(409, "category_exists", "Une catégorie portant ce nom existe déjà.")
        }
        throw error
      }
    }),
  )

  r.delete(
    "/service-categories/:id",
    requirePermission("service:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const used = await db().query("SELECT 1 FROM services WHERE category_id=$1::uuid AND organization_id=$2::uuid LIMIT 1", [id, t.organizationId])
      if (used.rowCount) {
        throw new HttpError(409, "category_in_use", "Des prestations utilisent cette catégorie. Désactivez-la plutôt.")
      }
      const q = await db().query("DELETE FROM service_categories WHERE id=$1::uuid AND organization_id=$2::uuid", [id, t.organizationId])
      if (!q.rowCount) throw new HttpError(404, "category_not_found", "Catégorie introuvable.")
      res.status(204).send()
    }),
  )

  // --------------------------------------------------- vehicle categories --
  //
  // Une catégorie de véhicule est ce que le caissier choisit ; sa **famille**
  // est ce qui porte le tarif. Les deux vivent dans le même enregistrement
  // parce qu'une catégorie sans famille n'aurait aucun prix propre : elle
  // retomberait sur le prix de base, ce qui est justement le défaut que le
  // référentiel corrige.
  r.get(
    "/vehicle-categories",
    requirePermission("service:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query(
        "SELECT id, name, family, sort_order, is_active, created_at, updated_at FROM vehicle_categories WHERE organization_id=$1::uuid",
        [t.organizationId],
      )
      // Ordre famille → rang → nom : c'est celui du sélecteur de la caisse.
      // Trier en SQL obligerait à réécrire l'ordre des familles dans chaque
      // requête ; il est déjà dans le référentiel partagé.
      res.json(sortVehicleCategories(q.rows))
    }),
  )

  // Référentiel complet + état d'avancement de la station.
  //
  // L'écran « Catégories de véhicules » ne peut pas proposer 61 noms à la
  // saisie : il affiche cette liste, famille par famille, et n'ajoute que ce
  // que le gérant coche. `added` évite les doublons et permet de proposer
  // d'un coup « ajouter toute la famille ».
  r.get(
    "/vehicle-categories/catalog",
    requirePermission("service:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query(
        "SELECT id, name FROM vehicle_categories WHERE organization_id=$1::uuid",
        [t.organizationId],
      )
      const existing = new Map(q.rows.map((row) => [String(row.name).toLowerCase(), row.id as string]))
      const families = VEHICLE_FAMILIES.map((family) => ({
        code: family.code,
        label: family.label,
        description: family.description,
        types: family.types.map((type) => ({
          code: type.code,
          name: type.name,
          category_id: existing.get(type.name.toLowerCase()) ?? null,
          added: existing.has(type.name.toLowerCase()),
        })),
      }))
      res.json({
        families,
        total_types: VEHICLE_TYPES.length,
        total_categories: q.rowCount ?? 0,
        added_types: families.reduce(
          (total, family) => total + family.types.filter((type) => type.added).length,
          0,
        ),
      })
    }),
  )

  // Ajout en lot depuis le référentiel. Idempotent : les types déjà présents
  // sont ignorés, ce qui rend le bouton « tout ajouter » rejouable sans
  // doublon ni erreur.
  r.post(
    "/vehicle-categories/catalog",
    requirePermission("service:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(catalogValidators.vehicleCategoryImport, req.body)

      const resolved = input.types.map((value) => vehicleType(value))
      const unknown = input.types.filter((_, index) => !resolved[index])
      if (unknown.length > 0) {
        throw new HttpError(
          400,
          "invalid_vehicle_type",
          `Type de véhicule inconnu : « ${unknown[0]} ». Choisissez-le dans la liste proposée.`,
        )
      }

      let added = 0
      for (const type of resolved) {
        if (!type) continue
        const q = await db().query(
          `INSERT INTO vehicle_categories(organization_id, name, family, sort_order)
           VALUES($1,$2,$3,$4)
           ON CONFLICT (organization_id, name) DO NOTHING
           RETURNING id`,
          [t.organizationId, type.name, type.family, type.sort_order],
        )
        added += q.rowCount ?? 0
      }

      await db().query(
        `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES($1,$2,'vehicle_category.imported','vehicle_category',$3,$4)`,
        [t.organizationId, t.userId, t.organizationId, JSON.stringify({ requested: input.types.length, added })],
      )

      res.status(201).json({ requested: input.types.length, added, skipped: input.types.length - added })
    }),
  )

  r.post(
    "/vehicle-categories",
    requirePermission("service:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(catalogValidators.vehicleCategory, req.body)
      assertVehicleFamily(input.family)
      try {
        const q = await db().query(
          `INSERT INTO vehicle_categories(organization_id, name, family, sort_order, is_active)
           VALUES($1,$2,$3,COALESCE($4,0),COALESCE($5,true))
           RETURNING id, name, family, sort_order, is_active, created_at, updated_at`,
          [t.organizationId, input.name, input.family ?? null, input.sort_order ?? null, input.is_active ?? null],
        )
        await auditVehicleCategory(t, "vehicle_category.created", q.rows[0].id, {
          name: input.name,
          family: input.family ?? null,
        })
        res.status(201).json(q.rows[0])
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new HttpError(409, "category_exists", "Une catégorie portant ce nom existe déjà.")
        }
        throw error
      }
    }),
  )

  r.patch(
    "/vehicle-categories/:id",
    requirePermission("service:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(catalogValidators.vehicleCategory.partial(), req.body)
      if (input.family !== undefined) assertVehicleFamily(input.family)
      const oldQ = await db().query("SELECT * FROM vehicle_categories WHERE id=$1::uuid AND organization_id=$2::uuid", [id, t.organizationId])
      if (!oldQ.rowCount) throw new HttpError(404, "category_not_found", "Catégorie introuvable.")
      const merged = { ...oldQ.rows[0], ...input }
      try {
        const q = await db().query(
          `UPDATE vehicle_categories SET name=$3, family=$4, sort_order=$5, is_active=$6, updated_at=now()
           WHERE id=$1::uuid AND organization_id=$2::uuid
           RETURNING id, name, family, sort_order, is_active, created_at, updated_at`,
          [id, t.organizationId, merged.name, merged.family ?? null, merged.sort_order ?? 0, merged.is_active],
        )
        await auditVehicleCategory(t, "vehicle_category.updated", id, {
          before: { name: oldQ.rows[0].name, family: oldQ.rows[0].family, is_active: oldQ.rows[0].is_active },
          after: { name: merged.name, family: merged.family ?? null, is_active: merged.is_active },
        })
        res.json(q.rows[0])
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new HttpError(409, "category_exists", "Une catégorie portant ce nom existe déjà.")
        }
        throw error
      }
    }),
  )

  r.delete(
    "/vehicle-categories/:id",
    requirePermission("service:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const used = await db().query("SELECT 1 FROM washes WHERE vehicle_category_id=$1::uuid AND organization_id=$2::uuid LIMIT 1", [id, t.organizationId])
      if (used.rowCount) {
        throw new HttpError(409, "category_in_use", "Des lavages utilisent cette catégorie. Désactivez-la plutôt.")
      }
      const q = await db().query("DELETE FROM vehicle_categories WHERE id=$1::uuid AND organization_id=$2::uuid", [id, t.organizationId])
      if (!q.rowCount) throw new HttpError(404, "category_not_found", "Catégorie introuvable.")
      // Une prestation pouvait porter un tarif visant précisément cette
      // catégorie. La clé deviendrait orpheline : elle ne s'appliquerait plus
      // à rien tout en restant en base, et ferait croire à un tarif actif.
      // On la retire dans la même foulée.
      const purged = await db().query(
        `UPDATE services SET price_by_vehicle_type = price_by_vehicle_type - $2::text, updated_at=now()
         WHERE organization_id=$1::uuid AND price_by_vehicle_type ? $2::text
         RETURNING id`,
        [t.organizationId, id],
      )
      await auditVehicleCategory(t, "vehicle_category.deleted", id, {
        services_with_cleaned_price: purged.rowCount ?? 0,
      })
      res.status(204).send()
    }),
  )

  // ------------------------------------------------------------- services --
  r.get(
    "/services",
    requirePermission("service:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query(
        "SELECT id, template_id, name, description, category_id, price_cents, price_by_vehicle_type, duration_minutes, is_active, created_at, updated_at FROM services WHERE organization_id=$1::uuid ORDER BY name",
        [t.organizationId],
      )
      const pricing = await loadServicePricing(q.rows.map((row) => String(row.id)))
      res.json(q.rows.map((row) => serviceResponse(row, pricing.get(String(row.id)) ?? [])))
    }),
  )

  r.get(
    "/services/:id",
    requirePermission("service:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const q = await db().query("SELECT * FROM services WHERE id=$1::uuid AND organization_id=$2::uuid", [id, t.organizationId])
      if (!q.rowCount) throw new HttpError(404, "service_not_found", "Prestation introuvable.")
      const pricing = await loadServicePricing([id])
      res.json(serviceResponse(q.rows[0], pricing.get(id) ?? []))
    }),
  )

  r.post(
    "/services",
    requirePermission("service:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(catalogValidators.service, req.body)
      await assertVehiclePricing(input.vehicle_pricing, t.organizationId)
      await assertServiceTemplate(input.template_id)
      if (input.category_id) {
        const categoryQ = await db().query("SELECT 1 FROM service_categories WHERE id=$1::uuid AND organization_id=$2::uuid", [input.category_id, t.organizationId])
        if (!categoryQ.rowCount) throw new HttpError(400, "invalid_category", "Catégorie de prestation invalide.")
      }
      // Prestation + associations dans une seule transaction : jamais une
      // prestation sans ses catégories autorisées, ni l'inverse.
      const client = await db().connect()
      try {
        await client.query("BEGIN")
        // `price_cents` et `price_by_vehicle_type` ne sont plus des sources de
        // décision : le premier sert d'affichage (le plus bas des tarifs
        // configurés), le second est un miroir des associations pour les
        // écrans anciens. L'éligibilité et le tarif réels vivent dans
        // `service_vehicle_prices`.
        const pricing = (input.vehicle_pricing ?? []).map((entry) => ({
          vehicle_category_id: entry.vehicle_category_id,
          price_cents: entry.price_cents as number,
        }))
        const displayPrice = Math.min(...pricing.map((entry) => entry.price_cents))
        const q = await client.query(
          `INSERT INTO services(organization_id, template_id, name, description, category_id, price_cents, price_by_vehicle_type, duration_minutes, is_active)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,true)) RETURNING *`,
          [t.organizationId, input.template_id ?? null, input.name, input.description ?? null, input.category_id ?? null, displayPrice, JSON.stringify(Object.fromEntries(pricing.map((e) => [e.vehicle_category_id, e.price_cents]))), input.duration_minutes ?? null, input.is_active ?? null],
        )
        const service = q.rows[0]
        for (const entry of pricing) {
          await client.query(
            "INSERT INTO service_vehicle_prices(service_id, vehicle_category_id, price_cents) VALUES($1,$2,$3)",
            [service.id, entry.vehicle_category_id, entry.price_cents],
          )
        }
        // La trace est écrite dans la même transaction : l'écriture et sa
        // journalisation sont atomiques, et surtout aucune requête du pool
        // n'est lancée pendant qu'un client est tenu (la couche RLS ouvrirait
        // un second client et se bloquerait sur le verrou de transaction).
        await auditService(client, t, "service.created", service.id, {
          name: input.name,
          vehicle_pricing: pricing,
        })
        await client.query("COMMIT")
        res.status(201).json(serviceResponse(service, pricing))
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {})
        throw error
      } finally {
        client.release()
      }
    }),
  )

  r.patch(
    "/services/:id",
    requirePermission("service:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(catalogValidators.service.partial(), req.body)
      const oldQ = await db().query("SELECT * FROM services WHERE id=$1::uuid AND organization_id=$2::uuid", [id, t.organizationId])
      if (!oldQ.rowCount) throw new HttpError(404, "service_not_found", "Prestation introuvable.")
      if (input.template_id !== undefined) await assertServiceTemplate(input.template_id)
      if (input.category_id) {
        const categoryQ = await db().query("SELECT 1 FROM service_categories WHERE id=$1::uuid AND organization_id=$2::uuid", [input.category_id, t.organizationId])
        if (!categoryQ.rowCount) throw new HttpError(400, "invalid_category", "Catégorie de prestation invalide.")
      }

      const oldPricingQ = await db().query(
        "SELECT vehicle_category_id, price_cents FROM service_vehicle_prices WHERE service_id=$1::uuid ORDER BY created_at",
        [id],
      )
      const oldPricing = oldPricingQ.rows.map((row) => ({
        vehicle_category_id: String(row.vehicle_category_id),
        price_cents: Number(row.price_cents),
      }))
      // Les catégories déjà associées ne sont jamais effacées en silence par
      // la règle « catégorie inactive » : elles restent conservables telles
      // quelles, et l'écran signale leur état.
      const keepExisting = new Set(oldPricing.map((entry) => entry.vehicle_category_id))
      const replacesPricing = input.vehicle_pricing !== undefined
      if (input.vehicle_pricing !== undefined) {
        await assertVehiclePricing(input.vehicle_pricing, t.organizationId, keepExisting)
      }

      const pricing = replacesPricing
        ? input.vehicle_pricing!.map((entry) => ({
            vehicle_category_id: entry.vehicle_category_id,
            price_cents: entry.price_cents as number,
          }))
        : oldPricing

      const merged = { ...oldQ.rows[0], ...input }
      const displayPrice = pricing.length > 0 ? Math.min(...pricing.map((entry) => entry.price_cents)) : Number(oldQ.rows[0].price_cents)
      const client = await db().connect()
      let updated
      try {
        await client.query("BEGIN")
        const q = await client.query(
          `UPDATE services SET template_id=$3, name=$4, description=$5, category_id=$6::uuid, price_cents=$7, price_by_vehicle_type=$8, duration_minutes=$9, is_active=$10, updated_at=now()
           WHERE id=$1::uuid AND organization_id=$2::uuid RETURNING *`,
          [id, t.organizationId, merged.template_id ?? null, merged.name, merged.description ?? null, merged.category_id ?? null, displayPrice, JSON.stringify(Object.fromEntries(pricing.map((e) => [e.vehicle_category_id, e.price_cents]))), merged.duration_minutes ?? null, merged.is_active],
        )
        updated = q.rows[0]
        if (replacesPricing) {
          // L'ensemble est remplacé : les catégories décochées perdent leur
          // association (et deviennent inutilisables dans un lavage), les
          // autres reçoivent leur tarif. Rien n'est rétroactivement changé
          // dans les lavages existants : leurs prix sont des instantanés.
          const keep = new Set(pricing.map((entry) => entry.vehicle_category_id))
          for (const entry of oldPricing) {
            if (!keep.has(entry.vehicle_category_id)) {
              await client.query(
                "DELETE FROM service_vehicle_prices WHERE service_id=$1::uuid AND vehicle_category_id=$2::uuid",
                [id, entry.vehicle_category_id],
              )
            }
          }
          for (const entry of pricing) {
            await client.query(
              `INSERT INTO service_vehicle_prices(service_id, vehicle_category_id, price_cents)
               VALUES($1,$2,$3)
               ON CONFLICT (service_id, vehicle_category_id)
               DO UPDATE SET price_cents=EXCLUDED.price_cents, updated_at=now()`,
              [id, entry.vehicle_category_id, entry.price_cents],
            )
          }
        }
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {})
        throw error
      } finally {
        client.release()
      }

      // On ne journalise que ce qui a bougé : une écriture identique ne doit
      // pas noyer le journal sous des « prestation modifiée » sans effet.
      const changed: Record<string, unknown> = {}
      if (String(oldQ.rows[0].name) !== String(merged.name)) {
        changed.name_before = oldQ.rows[0].name
        changed.name_after = merged.name
      }
      if (Boolean(oldQ.rows[0].is_active) !== Boolean(merged.is_active)) {
        changed.is_active = merged.is_active
      }
      if (replacesPricing && JSON.stringify(oldPricing) !== JSON.stringify(pricing)) {
        changed.vehicle_pricing = pricing
      }
      if (Object.keys(changed).length > 0) {
        await auditService(db(), t, "service.updated", id, changed)
      }
      res.json(serviceResponse(updated, pricing))
    }),
  )

  // DELETE /api/v1/services/:id — supprimer une prestation jamais vendue.
  //
  // Trois refus, dans cet ordre :
  //   • 404 si elle n'appartient pas à la station (l'identifiant d'une autre
  //     organisation ne doit rien révéler) ;
  //   • 409 si un lavage la référence — son prix est figé dans `wash_items` et
  //     l'historique doit rester lisible, donc on désactive, on ne supprime pas ;
  //   • 400 sinon… sauf les consommables, qui sont supprimés avec elle : leur
  //     clé étrangère bloquerait sinon la suppression en erreur 500, et une
  //     recette qui ne sert plus à rien n'a pas à survivre à sa prestation.
  r.delete(
    "/services/:id",
    requirePermission("service:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const pool = db()
      const serviceQ = await pool.query(
        "SELECT name FROM services WHERE id=$1::uuid AND organization_id=$2::uuid",
        [id, t.organizationId],
      )
      if (!serviceQ.rowCount) throw new HttpError(404, "service_not_found", "Prestation introuvable.")
      const deletedName = String(serviceQ.rows[0].name)
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        const used = await client.query("SELECT 1 FROM wash_items WHERE service_id=$1::uuid LIMIT 1", [id])
        if (used.rowCount) {
          throw new HttpError(409, "service_in_use", "Des lavages référencent cette prestation. Désactivez-la plutôt.")
        }
        await client.query(
          "DELETE FROM service_consumables WHERE service_id=$1::uuid AND organization_id=$2::uuid",
          [id, t.organizationId],
        )
        await client.query("DELETE FROM services WHERE id=$1::uuid AND organization_id=$2::uuid", [id, t.organizationId])
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
      // Journalisé après le COMMIT : une suppression annulée ne doit pas
      // laisser une ligne « prestation supprimée » dans l'audit.
      await auditService(db(), t, "service.deleted", id, { name: deletedName })
      res.status(204).send()
    }),
  )

  // --------------------------------------------------------------- washes --
  r.get(
    "/washes",
    requirePermission("wash:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      // Recherche par plaque. On compare sur la cle normalisee : le caissier
      // tape "1234ab01" et doit retrouver le lavage saisi " 1234 AB 01 ".
      const plate = typeof req.query.plate === "string" ? plateKey(req.query.plate) : null
      const q = await db().query(
        `SELECT ${WASH_FIELDS} FROM washes
         WHERE organization_id=$1::uuid AND ($2::text IS NULL OR plate_key = $2::text)
         ORDER BY created_at DESC LIMIT 200`,
        [t.organizationId, plate],
      )
      // Les laveurs affectes : l'ecran des taches en cours doit dire QUI
      // s'en occupe. Le responsable vient en premier : c'est lui qu'on
      // regarde en premier.
      const washers = await loadWashWorkers(
        db(),
        t.organizationId,
        q.rows.map((row) => row.id as string),
      )
      res.json(q.rows.map((row) => ({ ...row, washers: washers.get(row.id as string) ?? [] })))
    }),
  )

  // GET /api/v1/vehicles/:plate — l'historique d'un vehicule.
  //
  // Le produit ne tient pas de fichier client : il n'y a donc rien a lire sur
  // le proprietaire. Ce qu'on expose est seulement ce que la caisse a vu
  // passer : combien de fois ce vehicule est venu, quand, et pour quel
  // montant. Les lavages annules sont comptes a part et jamais additionnes au
  // reste : une annulation n'est pas une visite facturee.
  r.get(
    "/vehicles/:plate",
    requirePermission("wash:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const raw = req.params.plate
      const key = plateKey(typeof raw === "string" ? raw : null)
      if (!key) throw new HttpError(400, "invalid_data", "Indiquez une plaque.")
      const pool = db()

      const summaryQ = await pool.query(
        `SELECT count(*) FILTER (WHERE cancelled_at IS NULL) AS visits,
                count(*) FILTER (WHERE cancelled_at IS NOT NULL) AS cancelled,
                COALESCE(sum(total_cents) FILTER (WHERE cancelled_at IS NULL), 0) AS total_cents,
                min(created_at) FILTER (WHERE cancelled_at IS NULL) AS first_visit_at,
                max(created_at) FILTER (WHERE cancelled_at IS NULL) AS last_visit_at,
                max(plate) AS plate
         FROM washes WHERE organization_id=$1::uuid AND plate_key=$2::text`,
        [t.organizationId, key],
      )
      const row = summaryQ.rows[0] ?? {}

      const washesQ = await pool.query(
        `SELECT ${WASH_FIELDS} FROM washes
         WHERE organization_id=$1::uuid AND plate_key=$2::text
         ORDER BY created_at DESC LIMIT 50`,
        [t.organizationId, key],
      )

      res.json({
        plate_key: key,
        plate: row.plate ?? null,
        visits: Number(row.visits ?? 0),
        cancelled: Number(row.cancelled ?? 0),
        total_cents: Number(row.total_cents ?? 0),
        first_visit_at: row.first_visit_at ?? null,
        last_visit_at: row.last_visit_at ?? null,
        washes: washesQ.rows,
      })
    }),
  )

  r.get(
    "/washes/:id",
    requirePermission("wash:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const pool = db()
      const washQ = await pool.query(`SELECT ${WASH_FIELDS} FROM washes WHERE id=$1::uuid AND organization_id=$2::uuid`, [id, t.organizationId])
      if (!washQ.rowCount) throw new HttpError(404, "wash_not_found", "Lavage introuvable.")
      const [items, workers, payments] = await Promise.all([
        pool.query(
          "SELECT id, service_id, service_name AS service_name_snapshot, unit_price_cents AS price_cents_snapshot, quantity, line_total_cents FROM wash_items WHERE wash_id=$1::uuid",
          [id],
        ),
        pool.query(
          `SELECT w.id, w.first_name, w.last_name, w.role FROM wash_assignments a
           JOIN workers w ON w.id = a.worker_id WHERE a.wash_id=$1::uuid`,
          [id],
        ),
        pool.query(
          "SELECT id, amount_cents, method, status, reference, created_at AS received_at FROM payments WHERE wash_id=$1::uuid ORDER BY created_at",
          [id],
        ),
      ])
      // Ce que le lavage a sorti du stock. Réservé à qui a le droit de voir le
      // stock **et** dont le forfait l'inclut : sans cette double condition,
      // la fiche de lavage — ouverte à tout caissier — contournerait d'un
      // coup les deux portes posées sur le module stock, coûts unitaires
      // compris. La clé est absente de la réponse plutôt que vide : une liste
      // vide signifie « ce lavage n'a rien consommé », ce qui est autre chose.
      //
      // On lit les mouvements réellement écrits, pas la recette : celle-ci a
      // pu changer depuis, et un lavage saisi hors forfait n'a rien déduit.
      const peutVoirLeStock =
        t.can("stock:read") && req.subscription?.capabilities["stock.manage"] === true
      const consumables = peutVoirLeStock
        ? (
            await pool.query(
              `SELECT m.id, m.product_id, m.kind, m.quantity_milli, m.created_at,
                      p.name AS product_name, p.unit
               FROM stock_movements m
               JOIN products p ON p.id = m.product_id
               WHERE m.wash_id=$1::uuid AND m.organization_id=$2::uuid
               ORDER BY m.created_at, p.name`,
              [id, t.organizationId],
            )
          ).rows
        : undefined

      res.json({
        wash: washQ.rows[0],
        items: items.rows,
        workers: workers.rows,
        payments: payments.rows,
        ...(consumables === undefined ? {} : { consumables }),
      })
    }),
  )

  // POST /api/v1/washes — idempotent creation: items are priced server-side
  // from the catalog, cash payments require an open cash session.
  r.post(
    "/washes",
    requirePermission("wash:create"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(washValidators.create, req.body)
      const pool = db()

      await withIdempotency(pool, req, res, t.organizationId, fingerprint(input), async () => {
        const client = await pool.connect()
        try {
          await client.query("BEGIN")

          const siteQ = await client.query("SELECT id FROM sites WHERE id=$1::uuid AND organization_id=$2::uuid AND is_active", [input.site_id, t.organizationId])
          if (!siteQ.rowCount) throw new HttpError(400, "invalid_site", "Station invalide.")

          const categoryQ = await client.query(
            "SELECT id, family FROM vehicle_categories WHERE id=$1::uuid AND organization_id=$2::uuid AND is_active",
            [input.vehicle_category_id, t.organizationId],
          )
          if (!categoryQ.rowCount) throw new HttpError(400, "invalid_vehicle_category", "Catégorie de véhicule invalide.")
          const serviceIds = input.items.map((item) => item.service_id)
          // Éligibilité et tarif viennent de `service_vehicle_prices`, la
          // table des associations explicites. Une seule jointure répond à
          // deux questions : la prestation est-elle **autorisée** pour la
          // catégorie du véhicule, et à **quel prix**. Aucun repli vers un
          // prix de base ou de famille : une association absente est une
          // interdiction, même si un formulaire a contourné l'interface.
          const servicesQ = await client.query(
            `SELECT s.id, s.name, s.duration_minutes, p.price_cents AS configured_price_cents
               FROM services s
               LEFT JOIN service_vehicle_prices p
                 ON p.service_id = s.id AND p.vehicle_category_id = $3::uuid
              WHERE s.organization_id=$1::uuid AND s.id = ANY($2::uuid[]) AND s.is_active`,
            [t.organizationId, serviceIds, input.vehicle_category_id],
          )
          if (servicesQ.rowCount !== new Set(serviceIds).size) {
            throw new HttpError(400, "invalid_service", "Une prestation sélectionnée est invalide ou inactive.")
          }
          const serviceById = new Map(servicesQ.rows.map((row) => [row.id as string, row]))
          // La catégorie non autorisée est refusée explicitement, service par
          // service : « indisponible », jamais « gratuite » ni « au prix de
          // base ». Une ligne sans association ne passe pas.
          for (const item of input.items) {
            const service = serviceById.get(item.service_id)!
            if (service.configured_price_cents == null) {
              throw new HttpError(
                400,
                "service_not_available_for_vehicle",
                `La prestation « ${service.name} » n'est pas disponible pour la catégorie de véhicule sélectionnée.`,
              )
            }
          }

          if (input.worker_ids.length) {
            const workersQ = await client.query(
              "SELECT id FROM workers WHERE organization_id=$1::uuid AND id = ANY($2::uuid[]) AND status='active'",
              [t.organizationId, input.worker_ids],
            )
            if (workersQ.rowCount !== new Set(input.worker_ids).size) {
              throw new HttpError(400, "invalid_worker", "Un travailleur sélectionné est invalide ou inactif.")
            }
          }

          const totalCents = input.items.reduce((total, item) => {
            const service = serviceById.get(item.service_id)!
            return total + Number(service.configured_price_cents) * item.quantity
          }, 0)
          if (input.amount_received_cents > totalCents) {
            throw new HttpError(400, "amount_exceeds_total", "Le montant reçu dépasse le total du lavage.")
          }

          // Duree estimee du lavage : la somme des durees des prestations.
          // Elle est figee ici, a l'ecriture, et c'est elle que la barre de
          // progression suivra. Une prestation sans duree connue ne compte
          // pas plutot que de compter faux ; si rien n'est connu, on prend
          // une duree de repli, car une tache sans horizon ne se compte pas.
          const estimatedMinutes =
            input.items.reduce((total, item) => {
              const service = serviceById.get(item.service_id)!
              const minutes = Number(service.duration_minutes ?? 0)
              return total + (Number.isFinite(minutes) && minutes > 0 ? minutes * item.quantity : 0)
            }, 0) || DEFAULT_ESTIMATED_MINUTES

          const isCash = input.payment_method === "cash" && input.amount_received_cents > 0
          let cashSessionId: string | null = null
          if (isCash) {
            if (!input.cash_session_id) {
              throw new HttpError(400, "cash_session_required", "Une session de caisse ouverte est requise pour un paiement en espèces.")
            }
            const sessionQ = await client.query(
              "SELECT id FROM cash_sessions WHERE id=$1::uuid AND organization_id=$2::uuid AND site_id=$3::uuid AND status='open' FOR UPDATE",
              [input.cash_session_id, t.organizationId, input.site_id],
            )
            if (!sessionQ.rowCount) {
              throw new HttpError(400, "cash_session_invalid", "Session de caisse introuvable, fermée ou d'une autre station.")
            }
            cashSessionId = sessionQ.rows[0].id
          }

          const paymentStatus = resolvePaymentStatus(totalCents, input.amount_received_cents)

          await assertSiteWritable(client, t.organizationId, input.site_id)
          
          const activeCountQ = await client.query(
            `SELECT COUNT(*)::int as cnt FROM washes 
             WHERE organization_id=$1::uuid AND site_id=$2::uuid 
             AND status != 'cancelled' 
             AND operation_status IN ('pending','in_progress','overtime')`,
            [t.organizationId, input.site_id],
          )
          const activeCount = activeCountQ.rows[0]?.cnt || 0
          let queuePos: number | null = null
          if (activeCount >= MAX_ACTIVE_WASH_TASKS) {
            const maxQueueQ = await client.query(
              `SELECT COALESCE(MAX(queue_position), 0) as maxq FROM washes 
               WHERE organization_id=$1::uuid AND site_id=$2::uuid`,
              [t.organizationId, input.site_id],
            )
            queuePos = (maxQueueQ.rows[0]?.maxq || 0) + 1
          }
          
          const washQ = await client.query(
            `INSERT INTO washes(organization_id, site_id, vehicle_category_id, status, payment_status, operation_status, estimated_minutes, customer_name, total_cents, payment_method, created_by, plate, plate_key, reference, queue_position)
             VALUES($1,$2,$3,'completed',$4,'pending',$5,$6,$7,$8,$9,$10,$11,
               'LAV-' || to_char(now(),'YYYYMMDD') || '-' || upper(substr(md5(random()::text),1,6)), $12)
             RETURNING ${WASH_FIELDS}`,
             [
               t.organizationId,
               input.site_id,
               input.vehicle_category_id,
               paymentStatus,
               estimatedMinutes,
               input.customer_name ?? null,
               totalCents,
               input.payment_method,
               t.userId,
               plateDisplay(input.plate ?? null),
               plateKey(input.plate ?? null),
               queuePos,
             ],
          )
          const wash = washQ.rows[0]

          for (const item of input.items) {
            const service = serviceById.get(item.service_id)!
            // Instantané : ce prix est celui du jour, gravé dans la ligne. Un
            // changement de tarif ultérieur ne le réécrit jamais.
            const unitPrice = Number(service.configured_price_cents)
            await client.query(
              "INSERT INTO wash_items(wash_id, service_id, service_name, quantity, unit_price_cents, line_total_cents) VALUES($1,$2,$3,$4,$5,$6)",
              [wash.id, item.service_id, service.name, item.quantity, unitPrice, unitPrice * item.quantity],
            )
          }
          // Ce que le lavage a consommé sort du stock dans la même
          // transaction : si le lavage échoue, rien n'est déduit. Jamais
          // bloquant — le produit a réellement été utilisé.
          //
          // Le suivi du stock appartient au forfait Pro. Sans lui, on ne
          // déduit rien : écrire dans un stock que le client ne peut ni
          // consulter ni corriger reviendrait à le fausser en silence. Une
          // station rétrogradée retrouve donc son stock figé là où il était,
          // à inventorier. Et en aucun cas l'absence de forfait n'empêche
          // d'enregistrer le lavage : c'est le métier même de Starter.
          if (req.subscription?.capabilities["stock.manage"]) {
            await consumeForWash(client, t.organizationId, wash.id, input.items, t.userId)
          }

          const principal = input.principal_worker_id ?? null
          if (principal && !input.worker_ids.includes(principal)) {
            throw new HttpError(
              400,
              "invalid_principal",
              "Le responsable principal doit faire partie des laveurs affectés à ce lavage.",
            )
          }
          for (const workerId of new Set(input.worker_ids)) {
            await client.query(
              "INSERT INTO wash_assignments(wash_id, worker_id, assignment_role, assigned_by) VALUES($1,$2,$3,$4)",
              [wash.id, workerId, workerId === principal ? "principal" : "participant", t.userId],
            )
          }

          if (input.amount_received_cents > 0) {
            await client.query(
              "INSERT INTO payments(organization_id, wash_id, method, amount_cents, status) VALUES($1,$2,$3,$4,$5)",
              [t.organizationId, wash.id, input.payment_method, input.amount_received_cents, initialPaymentStatus(input.payment_method)],
            )
          }
          if (isCash && cashSessionId) {
            await client.query(
              `INSERT INTO cash_movements(organization_id, cash_session_id, type, amount_cents, source, description, wash_id, created_by)
               VALUES($1,$2,'entry',$3,'wash',$4,$5,$6)`,
              [t.organizationId, cashSessionId, input.amount_received_cents, `Encaissement lavage ${wash.reference}`, wash.id, t.userId],
            )
          }

          await client.query(
            "INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id) VALUES($1,$2,'wash.created','wash',$3)",
            [t.organizationId, t.userId, wash.id],
          )
          await client.query("COMMIT")
          return { status: 201, body: wash }
        } catch (error) {
          await client.query("ROLLBACK")
          throw error
        } finally {
          client.release()
        }
      })
    }),
  )

  // PATCH /api/v1/washes/:id/status — fait avancer l'avancement operationnel.
  //
  // Ce que la route touche est strictement distinct de la comptabilite. Un
  // lavage enregistre est deja `status = 'completed'` : il est entre, il est
  // paye, il est dans la caisse. Cette route ne bouge que
  // `operation_status`, qui dit ou en est la voiture — en attente, en cours,
  // terminee. Aucun montant, aucun mouvement de caisse, aucune ecriture de
  // stock n'est concerne : c'est un tableau de bord de terrain, pas une
  // ecriture comptable.
  //
  // Un lavage annule ne se fait pas avancer : il est annule, c'est tout.
  r.patch(
    "/washes/:id/status",
    requirePermission("wash:status"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(washValidators.status, req.body)
      const pool = db()
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        const washQ = await client.query(
          "SELECT id, reference, status, operation_status, site_id FROM washes WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
          [id, t.organizationId],
        )
        if (!washQ.rowCount) throw new HttpError(404, "wash_not_found", "Lavage introuvable.")
        if (washQ.rows[0].status === "cancelled") {
          throw new HttpError(409, "wash_cancelled", "Ce lavage est annulé : son avancement ne se change plus.")
        }
        if (washQ.rows[0].operation_status === input.status) {
          await client.query("COMMIT")
          res.json(washQ.rows[0])
          return
        }

        const q = await client.query(
          `UPDATE washes
              SET operation_status=$3,
                  operation_started_at = CASE
                    WHEN $3 = 'pending' THEN NULL
                    WHEN $3 = 'in_progress' THEN COALESCE(operation_started_at, now())
                    ELSE operation_started_at
                  END,
                  completed_at = CASE WHEN $3 = 'completed' THEN COALESCE(completed_at, now()) ELSE completed_at END
            WHERE id=$1::uuid AND organization_id=$2::uuid RETURNING ${WASH_FIELDS}`,
          [id, t.organizationId, input.status],
        )
        await client.query(
          "INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata) VALUES($1,$2,'wash.status_changed','wash',$3,$4)",
          [
            t.organizationId,
            t.userId,
            id,
            JSON.stringify({ from: washQ.rows[0].operation_status, to: input.status }),
          ],
        )
        // If completing, create notification
        if (input.status === "completed") {
          try {
            await client.query(
              `INSERT INTO notifications(organization_id, site_id, type, title, message, entity_type, entity_id)
               VALUES($1,$2,'WASH_COMPLETED',$3,$4,'wash',$5)`,
              [
                t.organizationId,
                washQ.rows[0].site_id,
                "Lavage terminé",
                `Le lavage ${washQ.rows[0].reference} est terminé.`,
                id,
              ],
            )
          } catch {
            // Notifications are best-effort and must not block the wash update.
          }
        }
        await client.query("COMMIT")
        res.json(q.rows[0])
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }),
  )

  // POST /api/v1/washes/:id/cancel — soft cancellation with mandatory reason.
  r.post(
    "/washes/:id/cancel",
    requirePermission("wash:cancel"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(washValidators.cancel, req.body)
      const pool = db()
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        const washQ = await client.query(
          "SELECT id, reference, status FROM washes WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
          [id, t.organizationId],
        )
        if (!washQ.rowCount) throw new HttpError(404, "wash_not_found", "Lavage introuvable.")
        if (washQ.rows[0].status === "cancelled") {
          throw new HttpError(409, "wash_already_cancelled", "Ce lavage est déjà annulé.")
        }

        // Reverse the cash entry when the originating session is still open.
        const movementQ = await client.query(
          `SELECT m.cash_session_id, m.amount_cents FROM cash_movements m
           JOIN cash_sessions s ON s.id = m.cash_session_id
           WHERE m.wash_id=$1::uuid AND m.type='entry' AND s.status='open'`,
          [id],
        )
        for (const movement of movementQ.rows) {
          await client.query(
            `INSERT INTO cash_movements(organization_id, cash_session_id, type, amount_cents, source, description, wash_id, created_by)
             VALUES($1,$2,'exit',$3,'wash_cancellation',$4,$5,$6)`,
            [t.organizationId, movement.cash_session_id, movement.amount_cents, `Annulation lavage ${washQ.rows[0].reference}`, id, t.userId],
          )
        }

        const hadPayments = await client.query("SELECT 1 FROM payments WHERE wash_id=$1::uuid LIMIT 1", [id])
        await client.query("UPDATE payments SET status='refunded' WHERE wash_id=$1::uuid", [id])

        // Le lavage n'a pas eu lieu : ce qu'il avait consommé revient au
        // stock, par contrepassation et non par suppression.
        //
        // Volontairement non soumise au forfait, contrairement à la
        // déduction : s'il n'y a rien à contrepasser, l'appel ne fait rien.
        // S'il y a quelque chose, c'est qu'une consommation a bien eu lieu,
        // et la laisser en place fausserait un stock déjà écrit.
        await reverseWashConsumption(client, t.organizationId, id, t.userId)

        const q = await client.query(
          `UPDATE washes SET status='cancelled', payment_status=CASE WHEN $4 THEN 'refunded' ELSE payment_status END,
             cancelled_at=now(), cancelled_by=$3, cancellation_reason=$5
           WHERE id=$1::uuid AND organization_id=$2::uuid RETURNING ${WASH_FIELDS}`,
          [id, t.organizationId, t.userId, Boolean(hadPayments.rowCount), input.reason],
        )
        await client.query(
          "INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata) VALUES($1,$2,'wash.cancelled','wash',$3,$4)",
          [t.organizationId, t.userId, id, JSON.stringify({ reason: input.reason })],
        )
        await client.query("COMMIT")
        res.json(q.rows[0])
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }),
  )

  return r
}
