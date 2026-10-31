import type { Pool, PoolClient } from "pg"

import { env } from "./env.ts"
import { HttpError } from "./auth.ts"
import { redactBody } from "./monitoring.ts"

type Queryable = Pick<Pool | PoolClient, "query">

export interface StatementEntryInput {
  lineNumber: number
  providerReference: string | null
  merchantReference: string | null
  amountCents: number
  currency: string
  status: string
  occurredAt: Date | null
  raw: unknown
}

export interface ReconciliationActor {
  operatorId: string | null
  email: string
}

const SUCCESS_STATUSES = new Set([
  "paid", "success", "successful", "succeeded", "complete", "completed",
  "accepted", "confirmed", "paye", "reussi", "valide",
])

function normalizedKey(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

function normalizedStatus(value: string): string {
  return normalizedKey(value)
}

function normalizedReference(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim().toUpperCase()
  return text || null
}

function field(record: Record<string, unknown>, names: string[]): unknown {
  const entries = Object.entries(record)
  for (const name of names) {
    const wanted = normalizedKey(name)
    const found = entries.find(([key]) => normalizedKey(key) === wanted)
    if (found && found[1] !== null && found[1] !== undefined && String(found[1]).trim() !== "") return found[1]
  }
  return undefined
}

function parseAmount(value: unknown, cents: boolean): number {
  if (typeof value === "number") {
    const result = cents ? value : value * 100
    if (!Number.isSafeInteger(Math.round(result))) throw new Error("Montant invalide.")
    return Math.round(result)
  }
  let text = String(value ?? "").trim().replace(/(?:fcfa|xof|f\.?)/gi, "").replace(/[\s\u00a0']/g, "")
  if (!text) throw new Error("Montant manquant.")
  const comma = text.lastIndexOf(",")
  const dot = text.lastIndexOf(".")
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? "," : "."
    const grouping = decimal === "," ? /\./g : /,/g
    text = text.replace(grouping, "").replace(decimal, ".")
  } else if (comma >= 0) {
    text = /,\d{1,2}$/.test(text) ? text.replace(",", ".") : text.replace(/,/g, "")
  } else if (dot >= 0 && !/\.\d{1,2}$/.test(text)) {
    text = text.replace(/\./g, "")
  }
  const amount = Number(text)
  if (!Number.isFinite(amount)) throw new Error(`Montant illisible : ${String(value)}`)
  const result = cents ? amount : amount * 100
  if (!Number.isSafeInteger(Math.round(result))) throw new Error("Montant trop précis ou trop grand.")
  return Math.round(result)
}

function parseDate(value: unknown): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

/** Normalise les noms de colonnes courants des exports CinetPay/PayDunya/Wave. */
export function normalizeStatementEntry(record: Record<string, unknown>, lineNumber: number): StatementEntryInput {
  const centsValue = field(record, ["amount_cents", "amount cents", "cents"])
  const amountValue = centsValue ?? field(record, ["amount", "montant", "value"])
  if (amountValue === undefined) throw new Error(`Ligne ${lineNumber} : montant manquant.`)
  const amountCents = parseAmount(amountValue, centsValue !== undefined)
  if (amountCents <= 0) throw new Error(`Ligne ${lineNumber} : le montant doit être positif.`)
  const merchant = normalizedReference(field(record, [
    "merchant_reference", "payment_reference", "client_reference", "wp_reference", "reference", "merchant transaction id",
  ]))
  const provider = normalizedReference(field(record, [
    "provider_reference", "provider_transaction_id", "transaction_id", "operator_reference", "provider id",
  ]))
  if (!merchant && !provider) throw new Error(`Ligne ${lineNumber} : référence manquante.`)
  return {
    lineNumber,
    providerReference: provider,
    merchantReference: merchant,
    amountCents,
    currency: String(field(record, ["currency", "devise"]) ?? "XOF").trim().toUpperCase(),
    status: String(field(record, ["status", "state", "payment_status"]) ?? "paid").trim(),
    occurredAt: parseDate(field(record, ["paid_at", "occurred_at", "date", "created_at"])),
    raw: redactBody(record),
  }
}

/** Parseur CSV avec guillemets, BOM, virgule, point-virgule ou tabulation. */
export function parseStatementCsv(text: string): Record<string, unknown>[] {
  const clean = text.replace(/^\uFEFF/, "")
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? ""
  const candidates = [";", ",", "\t"]
  const delimiter = candidates
    .map((value) => ({ value, count: firstLine.split(value).length - 1 }))
    .sort((a, b) => b.count - a.count)[0]?.value ?? ";"
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index]
    if (char === '"') {
      if (quoted && clean[index + 1] === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (char === delimiter && !quoted) {
      row.push(cell)
      cell = ""
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && clean[index + 1] === "\n") index += 1
      row.push(cell)
      if (row.some((value) => value.trim() !== "")) rows.push(row)
      row = []
      cell = ""
    } else {
      cell += char
    }
  }
  row.push(cell)
  if (row.some((value) => value.trim() !== "")) rows.push(row)
  if (quoted) throw new Error("CSV invalide : guillemet non fermé.")
  if (rows.length < 2) throw new Error("Le relevé CSV doit contenir un en-tête et au moins une ligne.")
  const headers = rows[0].map((header) => header.trim())
  if (headers.some((header) => !header)) throw new Error("Le relevé CSV contient une colonne sans nom.")
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])))
}

export function normalizeStatementEntries(records: Array<Record<string, unknown>>): StatementEntryInput[] {
  if (records.length === 0) throw new Error("Le relevé ne contient aucune ligne.")
  if (records.length > 2000) throw new Error("Un lot est limité à 2 000 lignes.")
  return records.map((record, index) => normalizeStatementEntry(record, index + 2))
}

interface PaymentMatch {
  id: string
  payment_intent_id: string | null
  organization_name: string
  amount_cents: string | number
  payment_reference: string | null
  reconciled_at: string | null
  reconciliation_batch_id: string | null
}

interface IntentMatch {
  id: string
  reference: string
  organization_name: string
  amount_cents: string | number
  status: string
}

function providerChannels(provider: string): string[] {
  switch (provider) {
    case "wave": return ["wave"]
    case "orange":
    case "orange_money": return ["orange_money"]
    case "mtn":
    case "mtn_momo": return ["mtn_momo"]
    case "moov":
    case "moov_money": return ["moov_money"]
    case "bank":
    case "bank_transfer": return ["bank_transfer"]
    case "cinetpay":
    case "paydunya": return ["orange_money", "mtn_momo", "moov_money", "wave"]
    default: return []
  }
}

async function insertDiscrepancy(
  client: PoolClient,
  batchId: string,
  input: {
    entryId?: string | null
    paymentId?: string | null
    intentId?: string | null
    kind: string
    reference?: string | null
    organizationName?: string | null
    expected?: number | null
    actual?: number | null
    details: string
  },
) {
  await client.query(
    `INSERT INTO reconciliation_discrepancies
       (batch_id, statement_entry_id, payment_id, payment_intent_id, kind, reference,
        organization_name, expected_amount_cents, actual_amount_cents, details)
     VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10)`,
    [
      batchId, input.entryId ?? null, input.paymentId ?? null, input.intentId ?? null,
      input.kind, input.reference ?? null, input.organizationName ?? null,
      input.expected ?? null, input.actual ?? null, input.details,
    ],
  )
}

/**
 * Rapproche un lot sans jamais activer un abonnement ni modifier un montant.
 * La preuve d'un paiement sur le relevé et son activation restent deux décisions
 * distinctes : une anomalie est toujours présentée à un humain.
 */
export async function reconcileStatement(
  pool: Pool,
  input: {
    provider: string
    sourceName?: string | null
    periodStart: Date
    periodEnd: Date
    entries: StatementEntryInput[]
    actor: ReconciliationActor
    triggerKind?: "manual" | "scheduled"
  },
) {
  if (input.periodStart >= input.periodEnd) {
    throw new HttpError(400, "invalid_period", "La période de rapprochement est invalide.")
  }
  const run = await pool.query<{ id: string }>(
    "INSERT INTO reconciliation_runs(trigger_kind, status) VALUES($1,'running') RETURNING id",
    [input.triggerKind ?? "manual"],
  )
  const runId = run.rows[0].id
  const client = await pool.connect()
  let batchId: string
  try {
    await client.query("BEGIN")
    const batch = await client.query<{ id: string }>(
      `INSERT INTO reconciliation_batches
         (provider, source_name, period_start, period_end, total_rows, created_by, created_by_email)
       VALUES($1,$2,$3::timestamptz,$4::timestamptz,$5,$6::uuid,$7) RETURNING id`,
      [
        input.provider, input.sourceName ?? null, input.periodStart.toISOString(),
        input.periodEnd.toISOString(), input.entries.length, input.actor.operatorId, input.actor.email,
      ],
    )
    batchId = batch.rows[0].id
    let matched = 0
    let discrepancies = 0
    let ignored = 0
    const channels = providerChannels(input.provider)

    for (const entry of input.entries) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO provider_statement_entries
           (batch_id, line_number, provider_reference, merchant_reference, amount_cents,
            currency, provider_status, occurred_at, raw)
         VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::jsonb) RETURNING id`,
        [
          batchId, entry.lineNumber, entry.providerReference, entry.merchantReference,
          entry.amountCents, entry.currency, entry.status,
          entry.occurredAt?.toISOString() ?? null, JSON.stringify(entry.raw),
        ],
      )
      const entryId = inserted.rows[0].id
      if (!SUCCESS_STATUSES.has(normalizedStatus(entry.status))) {
        ignored += 1
        continue
      }

      const payments = await client.query<PaymentMatch>(
        `SELECT p.id, p.payment_intent_id, p.organization_name, p.amount_cents,
                p.payment_reference, p.reconciled_at, p.reconciliation_batch_id
           FROM subscription_payments p
           LEFT JOIN payment_intents i ON i.id = p.payment_intent_id
          WHERE p.reverses_id IS NULL AND p.amount_cents > 0 AND (
            ($1::text IS NOT NULL AND (
              upper(p.payment_reference) = $1 OR upper(i.reference) = $1 OR upper(i.declared_reference) = $1
            )) OR
            ($2::text IS NOT NULL AND (
              upper(p.payment_reference) = $2 OR upper(i.provider_transaction_id) = $2
            ))
          )
            -- Les identifiants ne sont uniques qu'au sein d'un agrégateur :
            -- une référence Wave ne doit jamais marquer un paiement Orange.
            AND (cardinality($3::text[]) = 0 OR p.channel = ANY($3::text[]))
          LIMIT 3`,
        [entry.merchantReference, entry.providerReference, channels],
      )

      if (payments.rows.length > 1) {
        discrepancies += 1
        await insertDiscrepancy(client, batchId, {
          entryId, kind: "duplicate_reference", reference: entry.merchantReference ?? entry.providerReference,
          actual: entry.amountCents,
          details: "Plusieurs encaissements du registre portent cette référence. Aucun n'a été marqué automatiquement.",
        })
        continue
      }

      const payment = payments.rows[0]
      if (payment) {
        const expected = Number(payment.amount_cents)
        if (expected !== entry.amountCents) {
          discrepancies += 1
          await insertDiscrepancy(client, batchId, {
            entryId, paymentId: payment.id, intentId: payment.payment_intent_id,
            kind: "amount_mismatch", reference: entry.merchantReference ?? entry.providerReference,
            organizationName: payment.organization_name, expected, actual: entry.amountCents,
            details: "La référence correspond, mais le montant du relevé diffère du registre.",
          })
          continue
        }
        if (!payment.reconciled_at) {
          await client.query(
            `UPDATE subscription_payments SET reconciled_at = now(), reconciliation_batch_id = $2::uuid
             WHERE id = $1::uuid AND reconciled_at IS NULL`,
            [payment.id, batchId],
          )
        }
        matched += 1
        continue
      }

      const intents = await client.query<IntentMatch>(
        `SELECT i.id, i.reference, i.amount_cents, i.status, o.name AS organization_name
           FROM payment_intents i JOIN organizations o ON o.id = i.organization_id
          WHERE ($1::text IS NOT NULL AND (upper(i.reference) = $1 OR upper(i.declared_reference) = $1))
             OR ($2::text IS NOT NULL AND upper(i.provider_transaction_id) = $2)
          LIMIT 2`,
        [entry.merchantReference, entry.providerReference],
      )
      const intent = intents.rows[0]
      discrepancies += 1
      await insertDiscrepancy(client, batchId, {
        entryId, intentId: intent?.id ?? null, kind: "missing_in_register",
        reference: entry.merchantReference ?? entry.providerReference,
        organizationName: intent?.organization_name ?? null,
        expected: intent ? Number(intent.amount_cents) : null, actual: entry.amountCents,
        details: intent
          ? `Le relevé correspond à l'intention ${intent.reference} (${intent.status}), mais aucun encaissement n'est inscrit. Vérifiez puis activez manuellement si nécessaire.`
          : "Cette ligne payée du relevé ne correspond à aucun encaissement ni intention du registre.",
      })
    }

    // L'absence réciproque n'est contrôlée que pour les canaux couverts par le
    // relevé. Un virement ou du cash ne doit pas devenir un faux écart Wave.
    if (channels.length > 0) {
      const missing = await client.query<PaymentMatch>(
        `SELECT p.id, p.payment_intent_id, p.organization_name, p.amount_cents,
                p.payment_reference, p.reconciled_at, p.reconciliation_batch_id
           FROM subscription_payments p
          WHERE p.reverses_id IS NULL AND p.amount_cents > 0
            AND p.occurred_at >= $2::timestamptz AND p.occurred_at < $3::timestamptz
            AND p.channel = ANY($4::text[]) AND p.reconciled_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM reconciliation_discrepancies d
              WHERE d.batch_id = $1::uuid AND d.payment_id = p.id)`,
        [batchId, input.periodStart.toISOString(), input.periodEnd.toISOString(), channels],
      )
      for (const payment of missing.rows) {
        discrepancies += 1
        await insertDiscrepancy(client, batchId, {
          paymentId: payment.id, intentId: payment.payment_intent_id, kind: "missing_in_statement",
          reference: payment.payment_reference, organizationName: payment.organization_name,
          expected: Number(payment.amount_cents),
          details: "Cet encaissement du registre n'apparaît pas dans le relevé pour la période et le canal concernés.",
        })
      }
    }

    await client.query(
      `UPDATE reconciliation_batches SET status = $2, matched_rows = $3,
         discrepancy_rows = $4, ignored_rows = $5 WHERE id = $1::uuid`,
      [batchId, discrepancies > 0 ? "attention" : "matched", matched, discrepancies, ignored],
    )
    await client.query("COMMIT")
    await pool.query(
      "UPDATE reconciliation_runs SET status = 'success', batch_id = $2::uuid, finished_at = now() WHERE id = $1::uuid",
      [runId, batchId],
    )
    return { batch_id: batchId, matched_rows: matched, discrepancy_rows: discrepancies, ignored_rows: ignored }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    await pool.query(
      "UPDATE reconciliation_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1::uuid",
      [runId, error instanceof Error ? error.message.slice(0, 1000) : "Erreur inconnue"],
    )
    throw error
  } finally {
    client.release()
  }
}

export async function listReconciliationBatches(pool: Queryable) {
  const [batches, runs] = await Promise.all([
    pool.query(
      `SELECT b.*,
         (SELECT count(*)::int FROM reconciliation_discrepancies d
           WHERE d.batch_id = b.id AND d.status = 'open') AS open_discrepancies
       FROM reconciliation_batches b ORDER BY b.created_at DESC LIMIT 50`,
    ),
    pool.query("SELECT * FROM reconciliation_runs ORDER BY started_at DESC LIMIT 20"),
  ])
  return { batches: batches.rows, runs: runs.rows }
}

export async function getReconciliationBatch(pool: Queryable, id: string) {
  const [batch, entries, discrepancies] = await Promise.all([
    pool.query("SELECT * FROM reconciliation_batches WHERE id = $1::uuid", [id]),
    pool.query(
      `SELECT id, line_number, provider_reference, merchant_reference, amount_cents,
              currency, provider_status, occurred_at FROM provider_statement_entries
       WHERE batch_id = $1::uuid ORDER BY line_number`,
      [id],
    ),
    pool.query(
      `SELECT d.*, o.email AS resolved_by_email FROM reconciliation_discrepancies d
       LEFT JOIN platform_operators o ON o.id = d.resolved_by
       WHERE d.batch_id = $1::uuid ORDER BY d.status, d.created_at, d.id`,
      [id],
    ),
  ])
  if (!batch.rows[0]) return null
  return { batch: batch.rows[0], entries: entries.rows, discrepancies: discrepancies.rows }
}

export function reconciliationConfiguration() {
  return {
    enabled: env.RECONCILIATION_ENABLED,
    provider: env.RECONCILIATION_PROVIDER || null,
    configured: Boolean(env.RECONCILIATION_STATEMENT_URL && env.RECONCILIATION_PROVIDER),
    lookback_hours: env.RECONCILIATION_LOOKBACK_HOURS,
  }
}

/** Lit le relevé planifié puis applique exactement le même moteur qu'un import. */
export async function runScheduledReconciliation(
  pool: Pool,
  options: { now?: Date; fetchImpl?: typeof fetch; force?: boolean } = {},
) {
  if (!env.RECONCILIATION_ENABLED || !env.RECONCILIATION_STATEMENT_URL || !env.RECONCILIATION_PROVIDER) return null
  const now = options.now ?? new Date()
  const periodEnd = now
  const periodStart = new Date(now.getTime() - env.RECONCILIATION_LOOKBACK_HOURS * 3_600_000)
  if (!options.force) {
    const recent = await pool.query<{ batch_id: string | null }>(
      `SELECT batch_id FROM reconciliation_runs
       WHERE trigger_kind = 'scheduled' AND status = 'success' AND started_at >= $1::timestamptz
       ORDER BY started_at DESC LIMIT 1`,
      [periodStart.toISOString()],
    )
    if (recent.rows[0]) return { status: "skipped" as const, batch_id: recent.rows[0].batch_id }
  }
  let reconciliationStarted = false
  try {
    const url = new URL(env.RECONCILIATION_STATEMENT_URL)
    url.searchParams.set("from", periodStart.toISOString())
    url.searchParams.set("to", periodEnd.toISOString())
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: {
        Accept: "application/json, text/csv;q=0.9",
        ...(env.RECONCILIATION_STATEMENT_TOKEN
          ? { Authorization: `Bearer ${env.RECONCILIATION_STATEMENT_TOKEN}` }
          : {}),
      },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) throw new Error(`Le relevé distant a répondu ${response.status}.`)
    const text = await response.text()
    let records: Array<Record<string, unknown>>
    const contentType = response.headers.get("content-type") ?? ""
    if (contentType.includes("json") || /^\s*(?:\[|\{)/.test(text)) {
      const payload = JSON.parse(text) as unknown
      const entries = Array.isArray(payload)
        ? payload
        : (payload as { entries?: unknown; data?: unknown }).entries ?? (payload as { data?: unknown }).data
      if (!Array.isArray(entries)) throw new Error("La réponse JSON ne contient pas de tableau entries ou data.")
      records = entries as Array<Record<string, unknown>>
    } else {
      records = parseStatementCsv(text)
    }
    reconciliationStarted = true
    const result = await reconcileStatement(pool, {
      provider: env.RECONCILIATION_PROVIDER,
      sourceName: url.hostname,
      periodStart,
      periodEnd,
      entries: normalizeStatementEntries(records),
      actor: { operatorId: null, email: "system@reconciliation" },
      triggerKind: "scheduled",
    })
    return { status: "success" as const, ...result }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erreur inconnue"
    // reconcileStatement a déjà tracé son propre échec ; seules la lecture et
    // la normalisation du relevé distant doivent créer une ligne ici.
    if (!reconciliationStarted) {
      await pool.query(
        "INSERT INTO reconciliation_runs(trigger_kind, status, error, finished_at) VALUES('scheduled','failed',$1,now())",
        [message.slice(0, 1000)],
      )
    }
    return { status: "failed" as const, error: message }
  }
}
