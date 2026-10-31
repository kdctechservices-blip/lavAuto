import { Router } from "express"
import { z } from "zod"
import type { Pool } from "pg"
import { getPool, SERVICE_ELIGIBILITY_TRANSCRIPTION_SQL } from "./db.ts"
import { asyncRoute, body, tenant, requirePermission } from "./http.ts"
import { HttpError } from "./auth.ts"
import { TRIAL_DAYS, invalidateSubscriptionCache } from "./entitlements.ts"
import {
  DEFAULT_SERVICE_CATEGORY_NAMES,
  DEFAULT_VEHICLE_CATEGORIES,
  needsDefaultVehicleCategories,
  serviceCategoryName,
} from "./default-catalog.ts"

/** Wizard stages, in order. "review" is the confirmation screen. */
export const ONBOARDING_STAGES = ["station", "services", "workers", "plan", "review"] as const
type Stage = (typeof ONBOARDING_STAGES)[number]

const workerRoleSchema = z.enum(["car_washer", "moto_washer", "versatile_washer", "team_lead", "custom"])

export const onboardingValidators = {
  station: z
    .object({
      name: z.string().trim().min(2, "Le nom de la station est obligatoire (2 caractères minimum)."),
      city: z.string().trim().min(1, "La ville ou commune est obligatoire."),
      phone: z.string().trim().max(30).optional().or(z.literal("")),
      email: z.string().trim().max(200).optional().or(z.literal("")),
      address: z.string().trim().max(300).optional().or(z.literal("")),
      description: z.string().trim().max(1000).optional().or(z.literal("")),
      logo_url: z.string().trim().max(500).optional().or(z.literal("")),
    })
    .strip(),
  services: z
    .object({
      selected: z
        .array(
          z.object({
            template_id: z.string().uuid().optional(),
            name: z.string().trim().min(1).max(120),
            price_cents: z.number().int().min(0).max(100000000).nullable(),
          }),
        )
        .default([]),
      custom: z
        .array(
          z.object({
            name: z.string().trim().min(1).max(120),
            category: z.string().trim().max(100).optional(),
            price_cents: z.number().int().min(0).max(100000000).nullable(),
          }),
        )
        .default([]),
    })
    .strip()
    .refine((v) => v.selected.length + v.custom.length >= 1, {
      message: "Sélectionnez ou créez au moins un service.",
    }),
  workers: z
    .object({
      workers: z
        .array(
          z
            .object({
              first_name: z.string().trim().min(1).max(100),
              last_name: z.string().trim().min(1).max(100),
              phone: z.string().trim().max(30).optional().or(z.literal("")),
              district: z.string().trim().max(120).optional().or(z.literal("")),
              role: workerRoleSchema,
              custom_role: z.string().trim().max(100).optional().or(z.literal("")),
              joined_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
            })
            .strip()
            .refine((w) => w.role !== "custom" || Boolean(w.custom_role), {
              message: "Précisez la fonction personnalisée.",
            }),
        )
        .default([]),
    })
    .strip(),
  plan: z.object({ plan: z.string().trim().min(1) }).strip(),
}

const progressUpdateSchema = z
  .object({
    stage: z.enum(["station", "services", "workers", "plan"]),
    data: z.unknown(),
    plan_code: z.string().trim().min(1).optional().nullable(),
    draft: z.boolean().optional().default(false),
  })
  .strip()

function db(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

async function ensureProgressRow(pool: Pool, organizationId: string) {
  await pool.query(
    "INSERT INTO onboarding_progress (organization_id, current_stage) VALUES ($1::uuid, 'station') ON CONFLICT (organization_id) DO NOTHING",
    [organizationId],
  )
}

interface ProgressRow {
  current_stage: string
  station_data: Record<string, unknown> | null
  services_data: Record<string, unknown> | null
  workers_data: Record<string, unknown> | null
  plan_code: string | null
  completed_at: string | null
}

async function getProgress(pool: Pool, organizationId: string): Promise<ProgressRow> {
  await ensureProgressRow(pool, organizationId)
  const q = await pool.query(
    "SELECT current_stage, station_data, services_data, workers_data, plan_code, completed_at FROM onboarding_progress WHERE organization_id=$1::uuid",
    [organizationId],
  )
  return q.rows[0] as ProgressRow
}

function nextStage(stage: Stage): Stage {
  const index = ONBOARDING_STAGES.indexOf(stage)
  return ONBOARDING_STAGES[Math.min(index + 1, ONBOARDING_STAGES.length - 1)]
}

const PLAN_FIELDS =
  "id, code, name, description, price_cents, billing_cycle, max_users, max_workers, max_sites, max_services, features, sort_order"

export function createOnboardingRouter() {
  const r = Router()

  // GET /api/v1/plans — public plan catalog (within the authenticated app).
  r.get(
    "/plans",
    asyncRoute(async (req, res) => {
      tenant(req)
      const q = await db().query(`SELECT ${PLAN_FIELDS} FROM plans ORDER BY sort_order, price_cents`)
      res.json(q.rows)
    }),
  )

  // GET /api/v1/service-catalog — service templates offered during onboarding.
  r.get(
    "/service-catalog",
    asyncRoute(async (req, res) => {
      tenant(req)
      const q = await db().query(
        `SELECT id, category, name, price_cents, duration_minutes, description, sort_order
           FROM service_catalog WHERE is_active = true ORDER BY sort_order, name`,
      )
      res.json(q.rows)
    }),
  )

  // GET /api/v1/onboarding/status — drives the OnboardingGate route guard.
  r.get(
    "/onboarding/status",
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const pool = db()
      const progress = await getProgress(pool, t.organizationId)
      const orgQ = await pool.query("SELECT name, onboarding_completed FROM organizations WHERE id=$1::uuid", [t.organizationId])
      const org = orgQ.rows[0] ?? { name: "Mon organisation", onboarding_completed: false }
      const completed = Boolean(org.onboarding_completed || progress.completed_at)

      const siteQ = await pool.query(
        "SELECT id, name, phone, email, address, city, description, logo_url, slug FROM sites WHERE organization_id=$1::uuid ORDER BY created_at LIMIT 1",
        [t.organizationId],
      )

      const started = Boolean(
        progress.station_data || progress.services_data || progress.workers_data || progress.plan_code ||
        progress.current_stage !== "station",
      )

      res.json({
        state: completed ? "completed" : started ? "in_progress" : "not_started",
        current_stage: progress.current_stage,
        org_name: org.name,
        station: siteQ.rows[0] ?? undefined,
      })
    }),
  )

  // GET /api/v1/onboarding/progress — resume the wizard at the saved stage.
  r.get(
    "/onboarding/progress",
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const progress = await getProgress(db(), t.organizationId)
      res.json(progress)
    }),
  )

  // PUT /api/v1/onboarding/progress — persist one wizard stage ({stage, data, plan_code, draft}).
  r.put(
    "/onboarding/progress",
    requirePermission("settings:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const pool = db()
      const input = body(progressUpdateSchema, req.body)
      await ensureProgressRow(pool, t.organizationId)

      const columnByStage: Record<string, string> = {
        station: "station_data",
        services: "services_data",
        workers: "workers_data",
      }

      let planCode: string | null = null
      let stageData: unknown = null

      if (input.stage === "plan") {
        const data = body(onboardingValidators.plan, input.data)
        planCode = input.plan_code || data.plan
        const planQ = await pool.query("SELECT code FROM plans WHERE code=$1", [planCode])
        if (!planQ.rowCount) throw new HttpError(400, "invalid_plan", "Ce forfait n'existe pas.")
      } else {
        stageData = body(onboardingValidators[input.stage], input.data)
      }

      // Save & quit keeps the user on the same stage; a normal save advances.
      const newStage = input.draft ? input.stage : nextStage(input.stage)

      if (input.stage === "plan") {
        await pool.query(
          "UPDATE onboarding_progress SET plan_code=$2, current_stage=$3, draft=$4, updated_at=now() WHERE organization_id=$1::uuid",
          [t.organizationId, planCode, newStage, input.draft],
        )
      } else {
        await pool.query(
          `UPDATE onboarding_progress SET ${columnByStage[input.stage]}=$2::jsonb, current_stage=$3, draft=$4, updated_at=now() WHERE organization_id=$1::uuid`,
          [t.organizationId, JSON.stringify(stageData), newStage, input.draft],
        )
      }

      const progress = await getProgress(pool, t.organizationId)
      res.json(progress)
    }),
  )

  // GET /api/v1/onboarding/summary — review screen + billing/team pages.
  r.get(
    "/onboarding/summary",
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const pool = db()
      const progress = await getProgress(pool, t.organizationId)
      const orgQ = await pool.query("SELECT name, onboarding_completed FROM organizations WHERE id=$1::uuid", [t.organizationId])
      const org = orgQ.rows[0] ?? { name: "Mon organisation", onboarding_completed: false }

      const subscriptionQ = await pool.query(
        `SELECT s.status, s.current_period_end, ${PLAN_FIELDS.split(", ").map((f) => `p.${f}`).join(", ")}
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.organization_id=$1::uuid`,
        [t.organizationId],
      )

      let plan = null
      let subscriptionStatus = "none"
      let subscriptionPeriodEnd = null
      if (subscriptionQ.rowCount) {
        const { status, current_period_end, ...planRow } = subscriptionQ.rows[0]
        plan = planRow
        subscriptionStatus = status
        subscriptionPeriodEnd = current_period_end
      } else if (progress.plan_code) {
        const planQ = await pool.query(`SELECT ${PLAN_FIELDS} FROM plans WHERE code=$1`, [progress.plan_code])
        plan = planQ.rows[0] ?? null
        subscriptionStatus = "pending"
      }

      res.json({
        station: progress.station_data,
        services: progress.services_data,
        workers: progress.workers_data,
        plan,
        subscription_status: subscriptionStatus,
        subscription_period_end: subscriptionPeriodEnd,
        completed: Boolean(org.onboarding_completed || progress.completed_at),
        org_name: org.name,
      })
    }),
  )

  // POST /api/v1/onboarding/confirm — materialize the saved wizard data:
  // site, services, workers and subscription, then mark onboarding complete.
  r.post(
    "/onboarding/confirm",
    requirePermission("settings:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const pool = db()

      const orgQ = await pool.query("SELECT onboarding_completed FROM organizations WHERE id=$1::uuid", [t.organizationId])
      if (orgQ.rows[0]?.onboarding_completed) {
        res.json({ completed: true, already_completed: true })
        return
      }

      const progress = await getProgress(pool, t.organizationId)
      const station = onboardingValidators.station.safeParse(progress.station_data)
      if (!station.success) {
        throw new HttpError(409, "onboarding_incomplete", "Renseignez d'abord les informations de la station.")
      }
      const services = onboardingValidators.services.safeParse(progress.services_data ?? { selected: [], custom: [] })
      const workers = onboardingValidators.workers.safeParse(progress.workers_data ?? { workers: [] })
      const planCode = progress.plan_code ?? "starter"

      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1::text))", [t.organizationId])

        const planQ = await client.query("SELECT id, price_cents FROM plans WHERE code=$1", [planCode])
        if (!planQ.rowCount) throw new HttpError(400, "invalid_plan", "Ce forfait n'existe pas.")
        const plan = planQ.rows[0]

        // 1. Station (site) — reuse the existing one when confirm is retried.
        const existingSite = await client.query(
          "SELECT id FROM sites WHERE organization_id=$1::uuid ORDER BY created_at LIMIT 1",
          [t.organizationId],
        )
        const s = station.data
        if (existingSite.rowCount) {
          await client.query(
            `UPDATE sites SET name=$2, city=$3, address=$4, phone=$5, email=$6, description=$7, logo_url=$8, updated_at=now()
             WHERE id=$1::uuid`,
            [existingSite.rows[0].id, s.name, s.city, s.address || null, s.phone || null, s.email || null, s.description || null, s.logo_url || null],
          )
        } else {
          await client.query(
            `INSERT INTO sites(organization_id, name, city, address, phone, email, description, logo_url)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [t.organizationId, s.name, s.city, s.address || null, s.phone || null, s.email || null, s.description || null, s.logo_url || null],
          )
        }

        // 1 bis. Catégories de véhicules — sans elles, la caisse ne peut
        // enregistrer aucun lavage : le sélecteur de l'écran « Nouveau lavage »
        // reste vide, et la station est configurée mais incapable d'encaisser.
        // On n'initialise que si la liste est vide : une station qui a supprimé
        // ses catégories ne les voit pas revenir.
        const categoryQ = await client.query(
          "SELECT count(*)::int AS n FROM vehicle_categories WHERE organization_id=$1::uuid",
          [t.organizationId],
        )
        if (needsDefaultVehicleCategories(Number(categoryQ.rows[0]?.n ?? 0))) {
          // Un représentant par famille, avec sa famille et son rang : sans
          // eux, le sélecteur de la caisse afficherait 9 lignes en vrac et la
          // tarification par famille n'aurait aucune prise sur ces catégories.
          for (const category of DEFAULT_VEHICLE_CATEGORIES) {
            await client.query(
              `INSERT INTO vehicle_categories(organization_id, name, family, sort_order)
               VALUES($1, $2, $3, $4)
               ON CONFLICT (organization_id, name) DO NOTHING`,
              [t.organizationId, category.name, category.family, category.sort_order],
            )
          }
        }

        // 1 ter. Catégories de prestations — même raisonnement que pour les
        // véhicules : une page de catégories vide à la sortie de l'assistant
        // laisse un référentiel inutilisé et des prestations « sans
        // catégorie ». On les crée une fois, et on ne les recrée pas si la
        // station a délibérément vidé sa liste.
        const serviceCategoryQ = await client.query(
          "SELECT count(*)::int AS n FROM service_categories WHERE organization_id=$1::uuid",
          [t.organizationId],
        )
        const serviceCategoryByName = new Map<string, string>()
        if (Number(serviceCategoryQ.rows[0]?.n ?? 0) === 0) {
          for (const name of DEFAULT_SERVICE_CATEGORY_NAMES) {
            const inserted = await client.query(
              `INSERT INTO service_categories(organization_id, name)
               VALUES($1,$2)
               ON CONFLICT (organization_id, name) DO NOTHING
               RETURNING id`,
              [t.organizationId, name],
            )
            if (inserted.rowCount) serviceCategoryByName.set(name.toLowerCase(), inserted.rows[0].id)
          }
        } else {
          // La station a déjà son référentiel : on s'y rattache par le nom.
          const existing = await client.query(
            "SELECT id, name FROM service_categories WHERE organization_id=$1::uuid",
            [t.organizationId],
          )
          for (const row of existing.rows) {
            serviceCategoryByName.set(String(row.name).toLowerCase(), row.id)
          }
        }

        // 2. Services — create missing ones by name (idempotent on retry).
        //
        // Chacun reçoit la catégorie de son modèle : le classement existait
        // déjà dans `service_catalog` et l'écran d'assistant le montrait, il
        // n'y avait aucune raison de le perdre à l'enregistrement.
        if (services.success) {
          const templateIds = services.data.selected
            .map((item) => item.template_id)
            .filter((id): id is string => Boolean(id))
          // Le modèle fournit plus que sa catégorie : sa durée et sa
          // description suivent jusqu'à la prestation de la station. Sans la
          // durée, tous les lavages recevaient la même heure de fin estimée.
          const templates = new Map<
            string,
            { category: string; duration_minutes: number | null; description: string | null }
          >()
          if (templateIds.length > 0) {
            const catalogQ = await client.query(
              "SELECT id, category, duration_minutes, description FROM service_catalog WHERE id = ANY($1::uuid[])",
              [templateIds],
            )
            for (const row of catalogQ.rows) {
              templates.set(String(row.id), {
                category: String(row.category),
                duration_minutes:
                  row.duration_minutes == null ? null : Number(row.duration_minutes),
                description: row.description == null ? null : String(row.description),
              })
            }
          }

          const allServices = [
            ...services.data.selected.map((item) => {
              const template = item.template_id ? templates.get(item.template_id) : undefined
              return {
                name: item.name,
                price_cents: item.price_cents ?? 0,
                categoryName: serviceCategoryName(template?.category),
                duration_minutes: template?.duration_minutes ?? null,
                description: template?.description ?? null,
                template_id: item.template_id ?? null,
              }
            }),
            ...services.data.custom.map((item) => ({
              name: item.name,
              price_cents: item.price_cents ?? 0,
              categoryName: serviceCategoryName(item.category),
              duration_minutes: null,
              description: null,
              template_id: null,
            })),
          ]
          for (const service of allServices) {
            const categoryId =
              serviceCategoryByName.get(service.categoryName.toLowerCase()) ?? null
            await client.query(
              `INSERT INTO services(organization_id, template_id, name, price_cents, category_id, duration_minutes, description)
               SELECT $1, $7::uuid, $2, $3, $4, $5, $6
               WHERE NOT EXISTS (SELECT 1 FROM services WHERE organization_id=$1::uuid AND lower(name)=lower($2))`,
              [
                t.organizationId,
                service.name,
                service.price_cents,
                categoryId,
                service.duration_minutes,
                service.description,
                service.template_id,
              ],
            )
          }
          // Éligibilité explicite : l'assistant ne saisit pas de prix par
          // catégorie, ses prestations sont donc ouvertes aux catégories
          // connues de la station, au prix annoncé. Le gérant pourra ensuite
          // restreindre et différencier depuis le formulaire Prestations.
          await client.query(SERVICE_ELIGIBILITY_TRANSCRIPTION_SQL)
        }

        // 3. Workers — same idempotent insert by (first_name, last_name).
        if (workers.success) {
          for (const worker of workers.data.workers) {
            await client.query(
              `INSERT INTO workers(organization_id, first_name, last_name, phone, district, role, custom_role, joined_at)
               SELECT $1,$2,$3,$4,$5,$6,$7,$8
               WHERE NOT EXISTS (
                 SELECT 1 FROM workers WHERE organization_id=$1::uuid AND lower(first_name)=lower($2) AND lower(last_name)=lower($3)
               )`,
              [
                t.organizationId,
                worker.first_name,
                worker.last_name,
                worker.phone || null,
                worker.district || null,
                worker.role,
                worker.role === "custom" ? worker.custom_role || null : null,
                worker.joined_at || null,
              ],
            )
          }
        }

        // 4. Abonnement — tout forfait choisi ouvre un essai de TRIAL_DAYS
        // jours à compter de la validation de l'onboarding, sans carte
        // bancaire. Passé ce délai, l'espace passe en lecture seule tant
        // qu'un paiement n'a pas été validé (voir server/entitlements.ts).
        //
        // Le déclenchement ne dépend **pas** du prix. Il en dépendait quand un
        // forfait à 0 F existait ; depuis que les trois sont payants, un test
        // sur `price_cents === 0` aurait supprimé l'essai pour tout le monde,
        // sans erreur ni trace — exactement le genre de régression muette qui
        // ne se voit qu'au premier client perdu.
        await client.query(
          `INSERT INTO subscriptions(organization_id, plan_id, status, current_period_end, plan_changed_at)
           VALUES($1,$2,'trialing', now() + ($3 || ' days')::interval, now())
           ON CONFLICT (organization_id) DO UPDATE SET plan_id=EXCLUDED.plan_id, status=EXCLUDED.status, current_period_end=EXCLUDED.current_period_end, plan_changed_at=now(), updated_at=now()`,
          [t.organizationId, plan.id, String(TRIAL_DAYS)],
        )
        invalidateSubscriptionCache(t.organizationId)

        // 5. Mark onboarding complete.
        await client.query(
          "UPDATE onboarding_progress SET completed_at=now(), current_stage='review', draft=false, updated_at=now() WHERE organization_id=$1::uuid",
          [t.organizationId],
        )
        await client.query("UPDATE organizations SET onboarding_completed=true, updated_at=now() WHERE id=$1::uuid", [t.organizationId])
        await client.query(
          "INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id) VALUES($1,$2,'onboarding.completed','organization',$3)",
          [t.organizationId, t.userId, t.organizationId],
        )

        await client.query("COMMIT")
        res.status(201).json({ completed: true })
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
