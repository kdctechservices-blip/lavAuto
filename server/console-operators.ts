import { randomBytes } from "node:crypto"
import { Router } from "express"
import type { Pool, PoolClient } from "pg"
import { z } from "zod"

import { HttpError, hashPassword } from "./auth.ts"
import { asyncRoute, body, parseId } from "./http.ts"
import {
  CONSOLE_OPERATOR_ROLES,
  consoleDb,
  logConsoleAction,
  type ConsoleOperatorRole,
} from "./console-auth.ts"

/** Représentation publique : jamais de hash ni de mot de passe provisoire. */
const OPERATOR_SELECT = `o.id, o.email, o.full_name, o.role, o.status, o.managed_by,
  o.last_login_at, o.created_at, o.updated_at,
  (SELECT count(*)::int FROM platform_operator_sessions s
    WHERE s.operator_id = o.id AND s.expires_at > now()) AS active_sessions`

interface OperatorRow {
  id: string
  email: string
  full_name: string
  role: ConsoleOperatorRole
  status: "active" | "disabled"
  managed_by: "bootstrap" | "console"
  last_login_at: string | null
  created_at: string
  updated_at: string
  active_sessions: number
}

async function findOperator(pool: Pool | PoolClient, id: string, forUpdate = false) {
  const q = await pool.query<OperatorRow>(
    `SELECT ${OPERATOR_SELECT} FROM platform_operators o WHERE o.id = $1::uuid${forUpdate ? " FOR UPDATE OF o" : ""}`,
    [id],
  )
  return q.rows[0] ?? null
}

function temporaryPassword(): string {
  // Assez long pour être transmis une seule fois, sans reprendre le secret
  // PLATFORM_ADMIN_PASSWORD partagé par les comptes d'amorçage.
  return `WPC-${randomBytes(18).toString("base64url")}`
}

async function lockOperators(client: PoolClient) {
  // Toutes les décisions « dernier admin » partagent le même verrou. Deux
  // opérateurs ne peuvent donc pas se rétrograder simultanément et laisser la
  // Console sans administrateur.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('console-operators'))")
}

const reasonSchema = z.string().trim().min(5, "Un motif d'au moins 5 caractères est obligatoire.").max(300)

export function createConsoleOperatorRouter() {
  const r = Router()

  r.get(
    "/",
    asyncRoute(async (_req, res) => {
      const q = await consoleDb().query<OperatorRow>(
        `SELECT ${OPERATOR_SELECT} FROM platform_operators o
         ORDER BY CASE o.status WHEN 'active' THEN 0 ELSE 1 END,
                  CASE o.role WHEN 'admin' THEN 0 ELSE 1 END,
                  lower(o.email)`,
      )
      res.json({ operators: q.rows })
    }),
  )

  r.post(
    "/",
    asyncRoute(async (req, res) => {
      const input = body(
        z.object({
          email: z.string().trim().toLowerCase().email().max(254),
          full_name: z.string().trim().min(2).max(120),
          role: z.enum(CONSOLE_OPERATOR_ROLES),
        }).strip(),
        req.body,
      )
      const operator = req.operator!
      const pool = consoleDb()
      const client = await pool.connect()
      const password = temporaryPassword()
      try {
        await client.query("BEGIN")
        await lockOperators(client)
        const existing = await client.query("SELECT 1 FROM platform_operators WHERE email = $1", [input.email])
        if (existing.rowCount) {
          throw new HttpError(409, "operator_exists", "Un opérateur utilise déjà cette adresse e-mail.")
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO platform_operators(email, password_hash, full_name, status, role, managed_by)
           VALUES($1,$2,$3,'active',$4,'console') RETURNING id`,
          [input.email, await hashPassword(password), input.full_name, input.role],
        )
        await logConsoleAction(client, operator, "operator.created", null, null, {
          target_operator_id: inserted.rows[0].id,
          target_email: input.email,
          role: input.role,
        })
        await client.query("COMMIT")
        const created = await findOperator(pool, inserted.rows[0].id)
        res.status(201).json({ operator: created, temporary_password: password })
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {})
        throw error
      } finally {
        client.release()
      }
    }),
  )

  r.patch(
    "/:id",
    asyncRoute(async (req, res) => {
      const id = parseId(req.params.id)
      const input = body(
        z.object({
          full_name: z.string().trim().min(2).max(120).optional(),
          role: z.enum(CONSOLE_OPERATOR_ROLES).optional(),
          status: z.enum(["active", "disabled"]).optional(),
          reason: reasonSchema.optional(),
        }).strip().refine(
          (value) => value.full_name !== undefined || value.role !== undefined || value.status !== undefined,
          { message: "Indiquez une modification." },
        ),
        req.body,
      )
      const actor = req.operator!
      const pool = consoleDb()
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        await lockOperators(client)
        const target = await findOperator(client, id, true)
        if (!target) throw new HttpError(404, "operator_not_found", "Cet opérateur est introuvable.")

        const nextRole = input.role ?? target.role
        const nextStatus = input.status ?? target.status
        const accessChanges = nextRole !== target.role || nextStatus !== target.status
        if (accessChanges && !input.reason) {
          throw new HttpError(400, "reason_required", "Un motif est obligatoire pour modifier un accès.")
        }
        if (id === actor.operatorId && (nextRole !== "admin" || nextStatus !== "active")) {
          throw new HttpError(409, "self_modification", "Vous ne pouvez pas retirer votre propre accès administrateur.")
        }

        const losesActiveAdmin = target.role === "admin" && target.status === "active" &&
          (nextRole !== "admin" || nextStatus !== "active")
        if (losesActiveAdmin) {
          const others = await client.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM platform_operators
             WHERE role = 'admin' AND status = 'active' AND id <> $1::uuid`,
            [id],
          )
          if (Number(others.rows[0]?.count ?? 0) === 0) {
            throw new HttpError(409, "last_console_admin", "La Console doit conserver au moins un administrateur actif.")
          }
        }

        await client.query(
          `UPDATE platform_operators
              SET full_name = $2, role = $3, status = $4, updated_at = now()
            WHERE id = $1::uuid`,
          [id, input.full_name ?? target.full_name, nextRole, nextStatus],
        )
        if (nextStatus === "disabled") {
          await client.query("DELETE FROM platform_operator_sessions WHERE operator_id = $1::uuid", [id])
        }
        await logConsoleAction(client, actor, "operator.updated", null, null, {
          target_operator_id: id,
          target_email: target.email,
          before: { full_name: target.full_name, role: target.role, status: target.status },
          after: { full_name: input.full_name ?? target.full_name, role: nextRole, status: nextStatus },
          reason: input.reason ?? null,
        })
        await client.query("COMMIT")
        res.json({ operator: await findOperator(pool, id) })
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {})
        throw error
      } finally {
        client.release()
      }
    }),
  )

  r.post(
    "/:id/reset-password",
    asyncRoute(async (req, res) => {
      const id = parseId(req.params.id)
      const input = body(z.object({ reason: reasonSchema }).strip(), req.body)
      const actor = req.operator!
      const pool = consoleDb()
      const client = await pool.connect()
      const password = temporaryPassword()
      try {
        await client.query("BEGIN")
        await lockOperators(client)
        const target = await findOperator(client, id, true)
        if (!target) throw new HttpError(404, "operator_not_found", "Cet opérateur est introuvable.")
        await client.query(
          "UPDATE platform_operators SET password_hash = $2, updated_at = now() WHERE id = $1::uuid",
          [id, await hashPassword(password)],
        )
        const revoked = await client.query("DELETE FROM platform_operator_sessions WHERE operator_id = $1::uuid", [id])
        await logConsoleAction(client, actor, "operator.password_reset", null, null, {
          target_operator_id: id,
          target_email: target.email,
          sessions_revoked: revoked.rowCount ?? 0,
          reason: input.reason,
        })
        await client.query("COMMIT")
        res.json({ operator_id: id, temporary_password: password, sessions_revoked: revoked.rowCount ?? 0 })
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {})
        throw error
      } finally {
        client.release()
      }
    }),
  )

  r.post(
    "/:id/revoke-sessions",
    asyncRoute(async (req, res) => {
      const id = parseId(req.params.id)
      const input = body(z.object({ reason: reasonSchema }).strip(), req.body)
      const actor = req.operator!
      const pool = consoleDb()
      const target = await findOperator(pool, id)
      if (!target) throw new HttpError(404, "operator_not_found", "Cet opérateur est introuvable.")
      const revoked = await pool.query("DELETE FROM platform_operator_sessions WHERE operator_id = $1::uuid", [id])
      await logConsoleAction(pool, actor, "operator.sessions_revoked", null, null, {
        target_operator_id: id,
        target_email: target.email,
        sessions_revoked: revoked.rowCount ?? 0,
        reason: input.reason,
      })
      res.json({ operator_id: id, sessions_revoked: revoked.rowCount ?? 0 })
    }),
  )

  return r
}
