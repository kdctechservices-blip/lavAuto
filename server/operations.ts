import { Router } from "express"
import { z } from "zod"
import type { Pool } from "pg"
import { getPool } from "./db.ts"
import { asyncRoute, body, tenant, parseId, requirePermission } from "./http.ts"
import { HttpError } from "./auth.ts"
import { fingerprint, withIdempotency } from "./idempotency.ts"
import { assertSiteWritable } from "./plan-limits.ts"
import { utilityIndexValueSchema } from "./utilities.ts"
import { analyzeClosingUtilityReadings, recordClosingUtilityReadings } from "./utility-analysis.ts"

const closingUtilityReadingSchema = z.object({
  meter_id: z.string().uuid(),
  index_value: utilityIndexValueSchema,
  anomaly_comment: z.string().trim().max(500).optional(),
  photo: z.object({
    mime_type: z.enum(["image/jpeg", "image/webp"]),
    data_base64: z.string().min(4).max(400004),
  }).strip().optional(),
}).strip()

export const operationValidators = {
  openSession: z
    .object({
      site_id: z.string().uuid(),
      opening_amount_cents: z.number().int().min(0).max(100000000),
    })
    .strip(),
  movement: z
    .object({
      type: z.enum(["entry", "exit"]),
      amount_cents: z.number().int().positive().max(100000000),
      description: z.string().trim().max(500).nullable().optional(),
    })
    .strip(),
  closeSession: z
    .object({
      counted_amount_cents: z.number().int().min(0).max(100000000),
      discrepancy_reason: z.string().trim().max(500).nullable().optional(),
      utility_readings: z.array(closingUtilityReadingSchema).max(2).optional(),
    })
    .strip(),
  utilityPreview: z
    .object({ utility_readings: z.array(closingUtilityReadingSchema).max(2).optional() })
    .strip(),
  expense: z
    .object({
      category: z.enum(["supply", "salary", "maintenance", "utilities", "rent", "tax", "marketing", "other"]),
      amount_cents: z.number().int().positive().max(100000000),
      payment_method: z.enum(["cash", "orange_money", "mtn_momo", "moov_money", "wave", "other"]),
      site_id: z.string().uuid().optional(),
      beneficiary: z.string().trim().max(200).optional(),
      description: z.string().trim().max(1000).optional(),
      reference: z.string().trim().max(120).optional(),
      cash_session_id: z.string().uuid().optional(),
    })
    .strip(),
  expensePatch: z
    .object({
      category: z.enum(["supply", "salary", "maintenance", "utilities", "rent", "tax", "marketing", "other"]).optional(),
      amount_cents: z.number().int().positive().max(100000000).optional(),
      payment_method: z.enum(["cash", "orange_money", "mtn_momo", "moov_money", "wave", "other"]).optional(),
      site_id: z.string().uuid().optional(),
      beneficiary: z.string().trim().max(200).nullable().optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      reference: z.string().trim().max(120).nullable().optional(),
      cash_session_id: z.string().uuid().optional(),
    })
    .strip(),
}

function db(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

/**
 * Cash session projection: the theoretical balance is opening + entries − exits,
 * and the discrepancy compares the counted amount against it.
 */
const SESSION_SELECT = `
  SELECT cs.id, cs.organization_id, cs.site_id, cs.opened_by, cs.closed_by,
    cs.opening_amount_cents, cs.status, cs.opened_at, cs.closed_at, cs.discrepancy_reason,
    cs.closing_amount_cents AS counted_amount_cents,
    (cs.opening_amount_cents + COALESCE(m.entries,0) - COALESCE(m.exits,0))::int AS theoretical_balance_cents,
    CASE WHEN cs.closing_amount_cents IS NULL THEN NULL
         ELSE (cs.closing_amount_cents - (cs.opening_amount_cents + COALESCE(m.entries,0) - COALESCE(m.exits,0)))::int
    END AS discrepancy_cents
  FROM cash_sessions cs
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(amount_cents) FILTER (WHERE type='entry'),0)::int AS entries,
           COALESCE(SUM(amount_cents) FILTER (WHERE type='exit'),0)::int AS exits
    FROM cash_movements WHERE cash_session_id = cs.id
  ) m ON true`

const EXPENSE_FIELDS =
  "id, site_id, category, amount_cents, payment_method, cash_session_id, description, beneficiary, reference, status, expense_date, purchase_id, utility_reading_id, created_at"

export function createOperationsRouter() {
  const r = Router()

  // -------------------------------------------------------- cash sessions --
  r.get(
    "/cash-sessions",
    requirePermission("cash_session:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const status = typeof req.query.status === "string" && ["open", "closed"].includes(req.query.status) ? req.query.status : null
      const q = await db().query(
        `${SESSION_SELECT} WHERE cs.organization_id=$1::uuid AND ($2::text IS NULL OR cs.status=$2) ORDER BY cs.opened_at DESC LIMIT 100`,
        [t.organizationId, status],
      )
      res.json(q.rows)
    }),
  )

  r.get(
    "/cash-sessions/current",
    requirePermission("cash_session:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const siteId = typeof req.query.site_id === "string" && req.query.site_id ? parseId(req.query.site_id) : null
      const q = await db().query(
        `${SESSION_SELECT} WHERE cs.organization_id=$1::uuid AND cs.status='open' AND ($2::uuid IS NULL OR cs.site_id=$2::uuid)
         ORDER BY cs.opened_at DESC LIMIT 1`,
        [t.organizationId, siteId],
      )
      res.json(q.rows[0] ?? null)
    }),
  )

  r.post(
    "/cash-sessions/open",
    requirePermission("cash_session:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(operationValidators.openSession, req.body)
      const pool = db()

      await withIdempotency(pool, req, res, t.organizationId, fingerprint({ op: "cash-session-open", ...input }), async () => {
        const client = await pool.connect()
        try {
          await client.query("BEGIN")
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1 || $2))", [t.organizationId, input.site_id])

          const siteQ = await client.query("SELECT id FROM sites WHERE id=$1::uuid AND organization_id=$2::uuid AND is_active", [input.site_id, t.organizationId])
          if (!siteQ.rowCount) throw new HttpError(400, "invalid_site", "Station invalide.")

          const openQ = await client.query(
            "SELECT 1 FROM cash_sessions WHERE organization_id=$1::uuid AND site_id=$2::uuid AND status='open' LIMIT 1",
            [t.organizationId, input.site_id],
          )
          if (openQ.rowCount) {
            throw new HttpError(409, "cash_session_already_open", "Une session de caisse est déjà ouverte pour cette station.")
          }

          await assertSiteWritable(client, t.organizationId, input.site_id)
          const insertQ = await client.query(
            "INSERT INTO cash_sessions(organization_id, site_id, opened_by, opening_amount_cents) VALUES($1,$2,$3,$4) RETURNING id",
            [t.organizationId, input.site_id, t.userId, input.opening_amount_cents],
          )
          const sessionQ = await client.query(`${SESSION_SELECT} WHERE cs.id=$1::uuid`, [insertQ.rows[0].id])
          await client.query("COMMIT")
          return { status: 201, body: sessionQ.rows[0] }
        } catch (error) {
          await client.query("ROLLBACK")
          throw error
        } finally {
          client.release()
        }
      })
    }),
  )

  r.get(
    "/cash-sessions/:id",
    requirePermission("cash_session:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const q = await db().query(`${SESSION_SELECT} WHERE cs.id=$1::uuid AND cs.organization_id=$2::uuid`, [id, t.organizationId])
      if (!q.rowCount) throw new HttpError(404, "cash_session_not_found", "Session introuvable.")
      res.json(q.rows[0])
    }),
  )

  r.get(
    "/cash-sessions/:id/movements",
    requirePermission("cash_session:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const sessionQ = await db().query("SELECT 1 FROM cash_sessions WHERE id=$1::uuid AND organization_id=$2::uuid", [id, t.organizationId])
      if (!sessionQ.rowCount) throw new HttpError(404, "cash_session_not_found", "Session introuvable.")
      const q = await db().query(
        "SELECT id, type, amount_cents, source, description, wash_id, created_at FROM cash_movements WHERE cash_session_id=$1::uuid ORDER BY created_at DESC",
        [id],
      )
      res.json(q.rows)
    }),
  )

  r.post(
    "/cash-sessions/:id/movements",
    requirePermission("cash_session:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(operationValidators.movement, req.body)
      const pool = db()

      await withIdempotency(pool, req, res, t.organizationId, fingerprint({ op: "cash-movement", session: id, ...input }), async () => {
        const client = await pool.connect()
        try {
          await client.query("BEGIN")
          const sessionQ = await client.query(
            "SELECT id, status FROM cash_sessions WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
            [id, t.organizationId],
          )
          if (!sessionQ.rowCount) throw new HttpError(404, "cash_session_not_found", "Session introuvable.")
          if (sessionQ.rows[0].status !== "open") {
            throw new HttpError(409, "cash_session_closed", "Cette session de caisse est clôturée.")
          }
          const q = await client.query(
            `INSERT INTO cash_movements(organization_id, cash_session_id, type, amount_cents, source, description, created_by)
             VALUES($1,$2,$3,$4,'manual',$5,$6)
             RETURNING id, type, amount_cents, source, description, wash_id, created_at`,
            [t.organizationId, id, input.type, input.amount_cents, input.description || null, t.userId],
          )
          await client.query("COMMIT")
          return { status: 201, body: q.rows[0] }
        } catch (error) {
          await client.query("ROLLBACK")
          throw error
        } finally {
          client.release()
        }
      })
    }),
  )

  r.post(
    "/cash-sessions/:id/utility-preview",
    requirePermission("cash_session:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(operationValidators.utilityPreview, req.body)
      const pool = db()
      const client = await pool.connect()
      try {
        const sessionQ = await client.query(
          "SELECT id, site_id, status FROM cash_sessions WHERE id=$1::uuid AND organization_id=$2::uuid",
          [id, t.organizationId],
        )
        if (!sessionQ.rowCount) throw new HttpError(404, "cash_session_not_found", "Session introuvable.")
        if (sessionQ.rows[0].status !== "open") {
          throw new HttpError(409, "cash_session_closed", "Cette session de caisse est déjà clôturée.")
        }
        const dateQ = await client.query("SELECT CURRENT_DATE::text AS reading_date")
        const readingDate = String(dateQ.rows[0].reading_date).slice(0, 10)
        const readings = await analyzeClosingUtilityReadings(
          client,
          t.organizationId,
          String(sessionQ.rows[0].site_id),
          readingDate,
          input.utility_readings ?? [],
          { forUpdate: false, requireComments: false },
        )
        res.json({ reading_date: readingDate, readings })
      } finally {
        client.release()
      }
    }),
  )

  r.post(
    "/cash-sessions/:id/close",
    requirePermission("cash_session:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(operationValidators.closeSession, req.body)
      const pool = db()
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        const lockQ = await client.query(
          "SELECT id FROM cash_sessions WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
          [id, t.organizationId],
        )
        if (!lockQ.rowCount) throw new HttpError(404, "cash_session_not_found", "Session introuvable.")
        const sessionQ = await client.query(`${SESSION_SELECT} WHERE cs.id=$1::uuid`, [id])
        const session = sessionQ.rows[0]
        if (session.status !== "open") {
          throw new HttpError(409, "cash_session_closed", "Cette session de caisse est déjà clôturée.")
        }

        const theoretical = Number(session.theoretical_balance_cents)
        const discrepancy = input.counted_amount_cents - theoretical
        if (discrepancy !== 0 && !input.discrepancy_reason?.trim()) {
          throw new HttpError(400, "discrepancy_reason_required", "Justifiez l’écart avant de clôturer la session.")
        }

        const dateQ = await client.query("SELECT CURRENT_DATE::text AS reading_date")
        const closingReadings = await recordClosingUtilityReadings(
          client,
          t.organizationId,
          t.userId,
          String(session.site_id),
          id,
          String(dateQ.rows[0].reading_date).slice(0, 10),
          input.utility_readings ?? [],
        )

        await client.query(
          `UPDATE cash_sessions SET status='closed', closed_by=$3, closed_at=now(),
             closing_amount_cents=$4, expected_amount_cents=$5, discrepancy_reason=$6
           WHERE id=$1::uuid AND organization_id=$2::uuid`,
          [id, t.organizationId, t.userId, input.counted_amount_cents, theoretical, discrepancy !== 0 ? input.discrepancy_reason?.trim() || null : null],
        )
        await client.query(
          "INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata) VALUES($1,$2,'cash_session.closed','cash_session',$3,$4)",
          [t.organizationId, t.userId, id, JSON.stringify({
            counted_amount_cents: input.counted_amount_cents,
            discrepancy_cents: discrepancy,
            utility_reading_ids: closingReadings.map((reading) => reading.id),
            utility_readings_created: closingReadings.filter((reading) => reading.created).length,
          })],
        )
        const closedQ = await client.query(`${SESSION_SELECT} WHERE cs.id=$1::uuid`, [id])
        await client.query("COMMIT")
        res.json(closedQ.rows[0])
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }),
  )

  // ------------------------------------------------------------- expenses --
  r.get(
    "/expenses",
    requirePermission("expense:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query(
        `SELECT ${EXPENSE_FIELDS} FROM expenses WHERE organization_id=$1::uuid ORDER BY created_at DESC LIMIT 200`,
        [t.organizationId],
      )
      res.json(q.rows)
    }),
  )

  r.post(
    "/expenses",
    requirePermission("expense:create"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(operationValidators.expense, req.body)
      const pool = db()

      await withIdempotency(pool, req, res, t.organizationId, fingerprint({ op: "expense", ...input }), async () => {
        const client = await pool.connect()
        try {
          await client.query("BEGIN")

          let siteId: string | null = input.site_id ?? null
          if (siteId) {
            const siteQ = await client.query("SELECT 1 FROM sites WHERE id=$1::uuid AND organization_id=$2::uuid", [siteId, t.organizationId])
            if (!siteQ.rowCount) throw new HttpError(400, "invalid_site", "Station invalide.")
          }

          let cashSessionId: string | null = null
          if (input.payment_method === "cash") {
            if (!input.cash_session_id) {
              throw new HttpError(400, "cash_session_required", "Une session de caisse ouverte est requise pour une dépense en espèces.")
            }
            const sessionQ = await client.query(
              "SELECT id, site_id, status FROM cash_sessions WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
              [input.cash_session_id, t.organizationId],
            )
            if (!sessionQ.rowCount || sessionQ.rows[0].status !== "open") {
              throw new HttpError(400, "cash_session_invalid", "Session de caisse introuvable ou clôturée.")
            }
            cashSessionId = sessionQ.rows[0].id
            if (!siteId) siteId = sessionQ.rows[0].site_id
          }

          await assertSiteWritable(client, t.organizationId, siteId)
          const q = await client.query(
            `INSERT INTO expenses(organization_id, site_id, category, amount_cents, payment_method, cash_session_id, description, beneficiary, reference, created_by)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${EXPENSE_FIELDS}`,
            [
              t.organizationId,
              siteId,
              input.category,
              input.amount_cents,
              input.payment_method,
              cashSessionId,
              input.description || null,
              input.beneficiary || null,
              input.reference || null,
              t.userId,
            ],
          )
          const expense = q.rows[0]

          if (cashSessionId) {
            await client.query(
              `INSERT INTO cash_movements(organization_id, cash_session_id, type, amount_cents, source, description, expense_id, created_by)
               VALUES($1,$2,'exit',$3,'expense',$4,$5,$6)`,
              [t.organizationId, cashSessionId, input.amount_cents, input.description || `Dépense ${input.category}`, expense.id, t.userId],
            )
          }

          await client.query(
            "INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id) VALUES($1,$2,'expense.created','expense',$3)",
            [t.organizationId, t.userId, expense.id],
          )
          await client.query("COMMIT")
          return { status: 201, body: expense }
        } catch (error) {
          await client.query("ROLLBACK")
          throw error
        } finally {
          client.release()
        }
      })
    }),
  )

  // PATCH /api/v1/expenses/:id — editable only while the cash session is open.
  r.patch(
    "/expenses/:id",
    requirePermission("expense:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(operationValidators.expensePatch, req.body)
      const client = await db().connect()
      try {
        await client.query("BEGIN")
        const oldQ = await client.query(
          "SELECT * FROM expenses WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
          [id, t.organizationId],
        )
        if (!oldQ.rowCount) throw new HttpError(404, "expense_not_found", "Dépense introuvable.")
        const old = oldQ.rows[0]

        // Une dépense née d'un achat n'est pas modifiable ici. Elle est le
        // reflet comptable d'une marchandise entrée en stock : en changer le
        // montant à cet écran désolidariserait l'argent de ce qu'il a payé,
        // sans que rien ne le signale. La correction passe par l'annulation
        // de l'achat, qui reprend aussi la marchandise.
        if (old.purchase_id) {
          throw new HttpError(
            409,
            "expense_from_purchase",
            "Cette dépense provient d'un achat. Pour la corriger, annulez l'achat correspondant : la marchandise sera reprise en même temps.",
          )
        }
        // Le montant ou le paiement d'une facture peuvent être corrigés tant
        // que la caisse est ouverte. En revanche, la déplacer de station ou
        // la reclasser casserait son rattachement au compteur CIE/SODECI.
        if (old.utility_reading_id &&
          ((input.category !== undefined && input.category !== "utilities") ||
           (input.site_id !== undefined && input.site_id !== old.site_id))) {
          throw new HttpError(409, "expense_from_utility", "Cette dépense reste rattachée à son relevé CIE/SODECI : sa catégorie et sa station ne peuvent pas être changées ici.")
        }

        // A closed cash session is an accounting cut-off: its movements are frozen.
        if (old.cash_session_id) {
          const sessionQ = await client.query(
            "SELECT status FROM cash_sessions WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
            [old.cash_session_id, t.organizationId],
          )
          if (!sessionQ.rowCount || sessionQ.rows[0].status !== "open") {
            throw new HttpError(409, "expense_locked", "La session de caisse de cette dépense est clôturée. Elle n'est plus modifiable.")
          }
        }

        if (input.site_id) {
          const siteQ = await client.query("SELECT 1 FROM sites WHERE id=$1::uuid AND organization_id=$2::uuid", [input.site_id, t.organizationId])
          if (!siteQ.rowCount) throw new HttpError(400, "invalid_site", "Station invalide.")
        }

        // Resolving the cash session to attach (kept when unchanged).
        let cashSessionId: string | null = old.cash_session_id ?? null
        const wantsCash = input.payment_method === "cash" || (input.payment_method === undefined && old.payment_method === "cash")
        if (wantsCash) {
          const sessionId = input.cash_session_id ?? old.cash_session_id ?? null
          if (!sessionId) {
            throw new HttpError(400, "cash_session_required", "Une session de caisse ouverte est requise pour une dépense en espèces.")
          }
          const sessionQ = await client.query(
            "SELECT status FROM cash_sessions WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
            [sessionId, t.organizationId],
          )
          if (!sessionQ.rowCount || sessionQ.rows[0].status !== "open") {
            throw new HttpError(400, "cash_session_invalid", "Session de caisse introuvable ou clôturée.")
          }
          cashSessionId = sessionId
        } else {
          cashSessionId = null
        }

        const merged = { ...old, ...input, cash_session_id: cashSessionId }
        const q = await client.query(
          `UPDATE expenses SET site_id=$3, category=$4, amount_cents=$5, payment_method=$6, cash_session_id=$7,
             description=$8, beneficiary=$9, reference=$10
           WHERE id=$1::uuid AND organization_id=$2::uuid RETURNING ${EXPENSE_FIELDS}`,
          [
            id,
            t.organizationId,
            merged.site_id ?? null,
            merged.category,
            merged.amount_cents,
            merged.payment_method,
            merged.cash_session_id,
            merged.description || null,
            merged.beneficiary || null,
            merged.reference || null,
          ],
        )
        const expense = q.rows[0]

        // Keep the cash drawer in sync with the new amount / payment method.
        const movementQ = await client.query(
          `SELECT id FROM cash_movements
           WHERE expense_id=$1::uuid OR (expense_id IS NULL AND cash_session_id=$2::uuid AND source='expense' AND amount_cents=$3::int AND description=$4)
           FOR UPDATE`,
          [id, old.cash_session_id, old.amount_cents, old.description || `Dépense ${old.category}`],
        )
        const movement = movementQ.rows[0] ?? null
        if (cashSessionId) {
          if (movement) {
            await client.query(
              "UPDATE cash_movements SET cash_session_id=$2, amount_cents=$3, expense_id=$4 WHERE id=$1::uuid",
              [movement.id, cashSessionId, merged.amount_cents, id],
            )
          } else {
            await client.query(
              `INSERT INTO cash_movements(organization_id, cash_session_id, type, amount_cents, source, description, expense_id, created_by)
               VALUES($1,$2,'exit',$3,'expense',$4,$5,$6)`,
              [t.organizationId, cashSessionId, merged.amount_cents, merged.description || `Dépense ${merged.category}`, id, t.userId],
            )
          }
        } else if (movement) {
          await client.query("DELETE FROM cash_movements WHERE id=$1::uuid", [movement.id])
        }

        await client.query(
          "INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata) VALUES($1,$2,'expense.updated','expense',$3,$4)",
          [t.organizationId, t.userId, id, JSON.stringify({ amount_cents: { from: old.amount_cents, to: merged.amount_cents } })],
        )
        await client.query("COMMIT")
        res.json(expense)
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }),
  )

  // DELETE /api/v1/expenses/:id — reverses the cash movement when the session is still open.
  r.delete(
    "/expenses/:id",
    requirePermission("expense:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const client = await db().connect()
      try {
        await client.query("BEGIN")
        const oldQ = await client.query(
          "SELECT * FROM expenses WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
          [id, t.organizationId],
        )
        if (!oldQ.rowCount) throw new HttpError(404, "expense_not_found", "Dépense introuvable.")
        const old = oldQ.rows[0]

        // Une dépense née d'un achat n'est pas modifiable ici. Elle est le
        // reflet comptable d'une marchandise entrée en stock : en changer le
        // montant à cet écran désolidariserait l'argent de ce qu'il a payé,
        // sans que rien ne le signale. La correction passe par l'annulation
        // de l'achat, qui reprend aussi la marchandise.
        if (old.purchase_id) {
          throw new HttpError(
            409,
            "expense_from_purchase",
            "Cette dépense provient d'un achat. Pour la corriger, annulez l'achat correspondant : la marchandise sera reprise en même temps.",
          )
        }

        if (old.cash_session_id) {
          const sessionQ = await client.query(
            "SELECT status FROM cash_sessions WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
            [old.cash_session_id, t.organizationId],
          )
          if (!sessionQ.rowCount || sessionQ.rows[0].status !== "open") {
            throw new HttpError(409, "expense_locked", "La session de caisse de cette dépense est clôturée. Elle n'est plus supprimable.")
          }
          await client.query(
            `DELETE FROM cash_movements
             WHERE id IN (
               SELECT id FROM cash_movements
               WHERE expense_id=$1::uuid OR (expense_id IS NULL AND cash_session_id=$2::uuid AND source='expense' AND amount_cents=$3::int AND description=$4)
             )`,
            [id, old.cash_session_id, old.amount_cents, old.description || `Dépense ${old.category}`],
          )
        }

        await client.query("DELETE FROM expenses WHERE id=$1::uuid AND organization_id=$2::uuid", [id, t.organizationId])
        await client.query(
          "INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id) VALUES($1,$2,'expense.deleted','expense',$3)",
          [t.organizationId, t.userId, id],
        )
        await client.query("COMMIT")
        res.status(204).send()
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
