import type { Router } from "express"
import { z } from "zod"

import { HttpError } from "./auth.ts"
import { asyncRoute, body, parseId } from "./http.ts"
import { adminDb } from "./platform-admin.ts"
import { logConsoleAction } from "./console-auth.ts"
import {
  getReconciliationBatch,
  listReconciliationBatches,
  normalizeStatementEntries,
  parseStatementCsv,
  reconcileStatement,
  reconciliationConfiguration,
  runScheduledReconciliation,
} from "./reconciliation.ts"

function periodBoundary(value: string, end: boolean): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const exact = new Date(value)
    if (Number.isNaN(exact.getTime())) throw new HttpError(400, "invalid_period", "Date de période invalide.")
    return exact
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) throw new HttpError(400, "invalid_period", "Date de période invalide.")
  // Les dates du formulaire sont inclusives ; l'API SQL travaille avec une
  // borne supérieure exclusive afin d'inclure toute la journée de fin.
  if (end) date.setUTCDate(date.getUTCDate() + 1)
  return date
}

export function registerReconciliationRoutes(r: Router): void {
  r.get(
    "/reconciliation",
    asyncRoute(async (_req, res) => {
      const data = await listReconciliationBatches(adminDb())
      res.json({ ...data, configuration: reconciliationConfiguration() })
    }),
  )

  r.post(
    "/reconciliation/batches",
    asyncRoute(async (req, res) => {
      const input = body(
        z.object({
          provider: z.string().trim().toLowerCase().min(2).max(40),
          source_name: z.string().trim().max(200).optional(),
          from: z.string().trim().min(10).max(40),
          to: z.string().trim().min(10).max(40),
          entries: z.array(z.record(z.string(), z.unknown())).max(2000).optional(),
          csv: z.string().max(900_000).optional(),
        }).strip().refine((value) => Boolean(value.entries?.length) !== Boolean(value.csv), {
          message: "Fournissez soit un tableau entries, soit un CSV.",
        }),
        req.body,
      )
      let entries
      try {
        const records = input.entries ?? parseStatementCsv(input.csv!)
        entries = normalizeStatementEntries(records)
      } catch (error) {
        throw new HttpError(400, "invalid_statement", error instanceof Error ? error.message : "Relevé illisible.")
      }
      const pool = adminDb()
      const result = await reconcileStatement(pool, {
        provider: input.provider,
        sourceName: input.source_name ?? (input.csv ? "import.csv" : "import.json"),
        periodStart: periodBoundary(input.from, false),
        periodEnd: periodBoundary(input.to, true),
        entries,
        actor: { operatorId: req.operator!.operatorId, email: req.operator!.email },
      })
      await logConsoleAction(pool, req.operator!, "reconciliation.batch_imported", null, null, {
        batch_id: result.batch_id,
        provider: input.provider,
        matched_rows: result.matched_rows,
        discrepancy_rows: result.discrepancy_rows,
        ignored_rows: result.ignored_rows,
      })
      res.status(201).json(result)
    }),
  )

  r.post(
    "/reconciliation/run",
    asyncRoute(async (req, res) => {
      const configuration = reconciliationConfiguration()
      if (!configuration.enabled || !configuration.configured) {
        throw new HttpError(409, "reconciliation_not_configured", "Le connecteur planifié de relevé n'est pas configuré.")
      }
      const result = await runScheduledReconciliation(adminDb(), { force: true })
      await logConsoleAction(adminDb(), req.operator!, "reconciliation.connector_run", null, null, {
        status: result?.status ?? "skipped",
        batch_id: result && "batch_id" in result ? result.batch_id : null,
      })
      res.json(result)
    }),
  )

  r.get(
    "/reconciliation/batches/:id",
    asyncRoute(async (req, res) => {
      const result = await getReconciliationBatch(adminDb(), parseId(req.params.id))
      if (!result) throw new HttpError(404, "reconciliation_not_found", "Ce lot de rapprochement est introuvable.")
      res.json(result)
    }),
  )

  r.post(
    "/reconciliation/discrepancies/:id/resolve",
    asyncRoute(async (req, res) => {
      const id = parseId(req.params.id)
      const input = body(
        z.object({ note: z.string().trim().min(5).max(1000) }).strip(),
        req.body,
      )
      const pool = adminDb()
      const updated = await pool.query(
        `UPDATE reconciliation_discrepancies SET status = 'resolved', resolution_note = $2,
           resolved_by = $3::uuid, resolved_at = now()
         WHERE id = $1::uuid AND status = 'open'
         RETURNING id, batch_id, kind, status, resolution_note, resolved_at`,
        [id, input.note, req.operator!.operatorId],
      )
      if (!updated.rowCount) {
        const existing = await pool.query("SELECT status FROM reconciliation_discrepancies WHERE id = $1::uuid", [id])
        if (!existing.rowCount) throw new HttpError(404, "discrepancy_not_found", "Cet écart est introuvable.")
        throw new HttpError(409, "discrepancy_resolved", "Cet écart est déjà résolu.")
      }
      await logConsoleAction(pool, req.operator!, "reconciliation.discrepancy_resolved", null, null, {
        discrepancy_id: id,
        batch_id: updated.rows[0].batch_id,
        kind: updated.rows[0].kind,
        note: input.note,
      })
      res.json({ discrepancy: updated.rows[0] })
    }),
  )
}
