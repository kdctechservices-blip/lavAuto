import { Router } from "express"
import { z } from "zod"
import type { Pool, PoolClient } from "pg"
import { getPool } from "./db.ts"
import { asyncRoute, body, tenant, parseId, requirePermission } from "./http.ts"
import { HttpError } from "./auth.ts"

const workerRoleSchema = z.enum(["car_washer", "moto_washer", "versatile_washer", "team_lead", "custom"])
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide (AAAA-MM-JJ).")

export const workerValidators = {
  create: z
    .object({
      first_name: z.string().trim().min(1, "Le prénom est obligatoire.").max(100),
      last_name: z.string().trim().min(1, "Le nom est obligatoire.").max(100),
      phone: z.string().trim().max(30).nullable().optional(),
      district: z.string().trim().max(120).nullable().optional(),
      role: workerRoleSchema,
      custom_role: z.string().trim().min(2).max(100).nullable().optional(),
      joined_at: dateSchema.nullable().optional(),
    })
    .strip()
    .refine((w) => w.role !== "custom" || Boolean(w.custom_role), {
      message: "Précisez la fonction personnalisée.",
    }),
  patch: z
    .object({
      first_name: z.string().trim().min(1).max(100).optional(),
      last_name: z.string().trim().min(1).max(100).optional(),
      phone: z.string().trim().max(30).nullable().optional(),
      district: z.string().trim().max(120).nullable().optional(),
      status: z.enum(["active", "inactive"]).optional(),
      role: workerRoleSchema.optional(),
      custom_role: z.string().trim().max(100).nullable().optional(),
      joined_at: dateSchema.nullable().optional(),
    })
    .strip(),
}

/** Enforce the plan's max_workers before adding or reactivating one (advisory-locked per org). */
export async function assertWorkerCapacity(client: PoolClient, organizationId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [organizationId])
  const q = await client.query(
    `SELECT p.max_workers, COUNT(w.id)::int AS active_count
     FROM organizations o
     LEFT JOIN subscriptions s ON s.organization_id = o.id
     LEFT JOIN plans p ON p.id = s.plan_id
     LEFT JOIN workers w ON w.organization_id = o.id AND w.status = 'active'
     WHERE o.id = $1 GROUP BY p.max_workers`,
    [organizationId],
  )
  const row = q.rows[0]
  if (row?.max_workers != null && Number(row.active_count) >= Number(row.max_workers)) {
    throw new HttpError(409, "plan_worker_limit", "Le nombre maximal de travailleurs de votre forfait est atteint.")
  }
}

function db(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

const WORKER_FIELDS =
  "id, organization_id, site_id, first_name, last_name, phone, district, role, custom_role, status, joined_at, created_at, updated_at"

export function createTeamRouter() {
  const r = Router()

  // GET /api/v1/workers — field workers of the organization (no login account needed).
  r.get(
    "/workers",
    requirePermission("worker:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query(
        `SELECT ${WORKER_FIELDS} FROM workers WHERE organization_id=$1::uuid ORDER BY status, first_name, last_name`,
        [t.organizationId],
      )
      res.json(q.rows)
    }),
  )

  // GET /api/v1/workers/:id
  r.get(
    "/workers/:id",
    requirePermission("worker:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const q = await db().query(`SELECT ${WORKER_FIELDS} FROM workers WHERE id=$1::uuid AND organization_id=$2::uuid`, [id, t.organizationId])
      if (!q.rowCount) throw new HttpError(404, "worker_not_found", "Travailleur introuvable.")
      res.json(q.rows[0])
    }),
  )

  // POST /api/v1/workers
  r.post(
    "/workers",
    requirePermission("worker:create"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(workerValidators.create, req.body)
      const client = await db().connect()
      try {
        await client.query("BEGIN")
        await assertWorkerCapacity(client, t.organizationId)
        const q = await client.query(
          `INSERT INTO workers(organization_id, first_name, last_name, phone, district, role, custom_role, joined_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${WORKER_FIELDS}`,
          [
            t.organizationId,
            input.first_name,
            input.last_name,
            input.phone || null,
            input.district || null,
            input.role,
            input.role === "custom" ? input.custom_role || null : null,
            input.joined_at || null,
          ],
        )
        await client.query("COMMIT")
        res.status(201).json(q.rows[0])
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }),
  )

  // PATCH /api/v1/workers/:id — partial update, including status toggling.
  r.patch(
    "/workers/:id",
    requirePermission("worker:update"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(workerValidators.patch, req.body)
      const client = await db().connect()
      try {
        await client.query("BEGIN")
        const oldQ = await client.query(`SELECT ${WORKER_FIELDS} FROM workers WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE`, [id, t.organizationId])
        if (!oldQ.rowCount) throw new HttpError(404, "worker_not_found", "Travailleur introuvable.")
        const current = oldQ.rows[0]

        // Reactivating a worker counts against the plan limit.
        if (input.status === "active" && current.status === "inactive") {
          await assertWorkerCapacity(client, t.organizationId)
        }

        const merged = { ...current, ...input }
        if (merged.role !== "custom") merged.custom_role = null
        if (merged.role === "custom" && !merged.custom_role) {
          throw new HttpError(400, "invalid_data", "Précisez la fonction personnalisée.")
        }

        const q = await client.query(
          `UPDATE workers SET first_name=$3, last_name=$4, phone=$5, district=$6, role=$7, custom_role=$8, status=$9, joined_at=$10, updated_at=now()
           WHERE id=$1::uuid AND organization_id=$2::uuid RETURNING ${WORKER_FIELDS}`,
          [
            id,
            t.organizationId,
            merged.first_name,
            merged.last_name,
            merged.phone,
            merged.district,
            merged.role,
            merged.custom_role,
            merged.status,
            merged.joined_at,
          ],
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

  // DELETE /api/v1/workers/:id — hard delete unless the worker appears in wash history.
  r.delete(
    "/workers/:id",
    requirePermission("worker:delete"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const used = await db().query("SELECT 1 FROM wash_assignments WHERE worker_id=$1::uuid LIMIT 1", [id])
      if (used.rowCount) {
        throw new HttpError(409, "worker_in_use", "Des lavages assignent ce travailleur. Désactivez-le plutôt.")
      }
      const q = await db().query("DELETE FROM workers WHERE id=$1::uuid AND organization_id=$2::uuid", [id, t.organizationId])
      if (!q.rowCount) throw new HttpError(404, "worker_not_found", "Travailleur introuvable.")
      res.status(204).send()
    }),
  )

  // GET /api/v1/users — login accounts of the organization.
  r.get(
    "/users",
    requirePermission("user:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query(
        `SELECT u.id, u.first_name, u.last_name, u.email, m.role, u.status, u.created_at, u.updated_at
         FROM organization_members m JOIN users u ON u.id = m.user_id
         WHERE m.organization_id=$1::uuid ORDER BY m.created_at`,
        [t.organizationId],
      )
      res.json(q.rows)
    }),
  )

  return r
}
