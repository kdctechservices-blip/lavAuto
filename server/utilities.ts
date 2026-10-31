import { Router } from "express"
import { z } from "zod"
import type { Pool, PoolClient } from "pg"
import { getPool } from "./db.ts"
import { HttpError } from "./auth.ts"
import { asyncRoute, body, parseId, requirePermission, tenant } from "./http.ts"
import { fingerprint, withIdempotency } from "./idempotency.ts"
import { assertSiteWritable } from "./plan-limits.ts"

export const UTILITY_PROVIDERS = ["cie", "sodeci"] as const
export type UtilityProvider = (typeof UTILITY_PROVIDERS)[number]

const PROVIDER_LABEL: Record<UtilityProvider, string> = { cie: "CIE", sodeci: "SODECI" }
const PAYMENT_METHODS = ["cash", "orange_money", "mtn_momo", "moov_money", "wave", "other"] as const

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format AAAA-MM-JJ.")
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`)
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  }, "Cette date n'existe pas.")

function hasAtMostThreeDecimals(value: number): boolean {
  const scaled = value * 1000
  // Tolérance uniquement pour la représentation binaire (0,1 + 0,2), très
  // inférieure au demi-millième qui modifierait réellement la valeur.
  return Math.abs(scaled - Math.round(scaled)) <= Math.max(1, Math.abs(scaled)) * Number.EPSILON * 4
}

export const utilityIndexValueSchema = z
  .number()
  .finite()
  .min(0)
  .max(1_000_000_000)
  .refine(hasAtMostThreeDecimals, "Trois décimales maximum.")

const invoiceSchema = z
  .object({
    amount_cents: z.number().int().positive().max(100000000),
    expense_date: calendarDate,
    payment_method: z.enum(PAYMENT_METHODS),
    reference: z.string().trim().max(120).optional(),
    cash_session_id: z.string().uuid().optional(),
  })
  .strip()

export const utilityValidators = {
  meter: z
    .object({
      site_id: z.string().uuid(),
      provider: z.enum(UTILITY_PROVIDERS),
      meter_number: z.string().trim().min(2).max(80),
    })
    .strip(),
  reading: z
    .object({
      reading_date: calendarDate,
      index_value: utilityIndexValueSchema,
      notes: z.string().trim().max(500).optional(),
      invoice: invoiceSchema.optional(),
    })
    .strip(),
  invoice: invoiceSchema,
}

export type UtilityInvoiceInput = z.infer<typeof invoiceSchema>

interface UtilityMeterRow {
  id: string
  organization_id: string
  site_id: string
  provider: UtilityProvider
  meter_number: string
  is_active: boolean
}

interface UtilityExpense {
  id: string
  amount_cents: number
  expense_date: string
  payment_method: string
  reference: string | null
  status: string
}

function db(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505"
}

export function indexToMilli(value: number): number {
  return Math.round(value * 1000)
}

function assertNotFuture(value: string, label: string) {
  if (value > new Date().toISOString().slice(0, 10)) {
    throw new HttpError(400, "future_date", `${label} ne peut pas être dans le futur.`)
  }
}

function monthBounds(month: string): { start: string; end: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new HttpError(400, "invalid_month", "Mois attendu au format AAAA-MM.")
  }
  const start = `${month}-01`
  const date = new Date(`${start}T00:00:00.000Z`)
  date.setUTCMonth(date.getUTCMonth() + 1)
  return { start, end: date.toISOString().slice(0, 10) }
}

function dateOnly(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

function mapReading(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    meter_id: String(row.meter_id),
    cash_session_id: row.cash_session_id ? String(row.cash_session_id) : null,
    reading_date: dateOnly(row.reading_date),
    index_milli: Number(row.index_milli),
    consumption_milli: row.consumption_milli == null ? null : Number(row.consumption_milli),
    notes: row.notes ?? null,
    anomaly_comment: row.anomaly_comment ?? null,
    has_photo: Boolean(row.has_photo),
    created_at: row.created_at,
    expense: row.expense_id
      ? {
          id: String(row.expense_id),
          amount_cents: Number(row.amount_cents),
          expense_date: dateOnly(row.expense_date),
          payment_method: String(row.payment_method),
          reference: row.invoice_reference == null ? null : String(row.invoice_reference),
          status: String(row.expense_status),
        }
      : null,
  }
}

const READING_SELECT = `
  SELECT ordered.id, ordered.meter_id, ordered.cash_session_id, ordered.reading_date, ordered.index_milli::text,
         (ordered.index_milli - ordered.previous_index_milli)::text AS consumption_milli,
         ordered.notes, ordered.anomaly_comment, (p.reading_id IS NOT NULL) AS has_photo, ordered.created_at,
         e.id AS expense_id, e.amount_cents, e.expense_date, e.payment_method,
         e.reference AS invoice_reference, e.status AS expense_status
  FROM (
    SELECT r.*, LAG(r.index_milli) OVER (PARTITION BY r.meter_id ORDER BY r.reading_date) AS previous_index_milli
    FROM utility_readings r
    WHERE r.organization_id=$1::uuid
  ) ordered
  LEFT JOIN expenses e ON e.utility_reading_id=ordered.id
  LEFT JOIN utility_reading_photos p ON p.reading_id=ordered.id`

async function readingForResponse(client: PoolClient, organizationId: string, readingId: string) {
  const q = await client.query(`${READING_SELECT} WHERE ordered.id=$2::uuid`, [organizationId, readingId])
  if (!q.rowCount) throw new HttpError(404, "reading_not_found", "Relevé introuvable.")
  return mapReading(q.rows[0])
}

async function lockedMeter(client: PoolClient, organizationId: string, meterId: string): Promise<UtilityMeterRow> {
  const q = await client.query(
    `SELECT id, organization_id, site_id, provider, meter_number, is_active
     FROM utility_meters WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE`,
    [meterId, organizationId],
  )
  if (!q.rowCount) throw new HttpError(404, "meter_not_found", "Compteur introuvable.")
  if (!q.rows[0].is_active) throw new HttpError(409, "meter_inactive", "Ce compteur n'est plus actif.")
  return q.rows[0] as UtilityMeterRow
}

/**
 * Vérifie la chronologie avant l'écriture. Un relevé peut être ajouté à une
 * date passée, mais son index doit rester entre ses deux voisins. La
 * consommation étant calculée avec LAG, les voisins sont ensuite recalculés.
 */
export async function assertChronology(
  client: PoolClient,
  meterId: string,
  readingDate: string,
  indexMilli: number,
) {
  const [previous, next] = await Promise.all([
    client.query(
      "SELECT index_milli::text FROM utility_readings WHERE meter_id=$1::uuid AND reading_date<$2::date ORDER BY reading_date DESC LIMIT 1",
      [meterId, readingDate],
    ),
    client.query(
      "SELECT index_milli::text FROM utility_readings WHERE meter_id=$1::uuid AND reading_date>$2::date ORDER BY reading_date LIMIT 1",
      [meterId, readingDate],
    ),
  ])
  if (previous.rowCount && Number(previous.rows[0].index_milli) > indexMilli) {
    throw new HttpError(400, "index_regresses", "Le nouvel index est inférieur au relevé précédent. Vérifiez la date ou la valeur saisie.")
  }
  if (next.rowCount && Number(next.rows[0].index_milli) < indexMilli) {
    throw new HttpError(400, "index_exceeds_next", "Le nouvel index dépasse le relevé suivant. Vérifiez la date ou la valeur saisie.")
  }
}

/** Crée la dépense de la facture réelle et, en espèces, sa sortie de caisse. */
async function createUtilityExpense(
  client: PoolClient,
  input: UtilityInvoiceInput,
  meter: UtilityMeterRow,
  reading: { id: string; reading_date: string },
  organizationId: string,
  userId: string,
): Promise<UtilityExpense> {
  let cashSessionId: string | null = null
  if (input.payment_method === "cash") {
    if (!input.cash_session_id) {
      throw new HttpError(400, "cash_session_required", "Sélectionnez une caisse ouverte pour régler cette facture en espèces.")
    }
    const session = await client.query(
      "SELECT id, site_id, status FROM cash_sessions WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
      [input.cash_session_id, organizationId],
    )
    if (!session.rowCount || session.rows[0].status !== "open") {
      throw new HttpError(400, "cash_session_invalid", "Session de caisse introuvable ou clôturée.")
    }
    if (session.rows[0].site_id !== meter.site_id) {
      throw new HttpError(400, "cash_session_wrong_site", "La caisse sélectionnée appartient à une autre station.")
    }
    cashSessionId = String(session.rows[0].id)
  }

  const provider = PROVIDER_LABEL[meter.provider]
  const description = `Facture ${provider} — compteur ${meter.meter_number}, relevé du ${reading.reading_date}`
  const q = await client.query(
    `INSERT INTO expenses(organization_id, site_id, category, amount_cents, payment_method,
       cash_session_id, description, beneficiary, reference, expense_date, utility_reading_id, created_by)
     VALUES($1,$2,'utilities',$3,$4,$5,$6,$7,$8,$9::date,$10,$11)
     RETURNING id, amount_cents, expense_date, payment_method, reference, status`,
    [
      organizationId,
      meter.site_id,
      input.amount_cents,
      input.payment_method,
      cashSessionId,
      description,
      provider,
      input.reference || null,
      input.expense_date,
      reading.id,
      userId,
    ],
  )
  const expense = q.rows[0] as UtilityExpense

  if (cashSessionId) {
    await client.query(
      `INSERT INTO cash_movements(organization_id, cash_session_id, type, amount_cents, source, description, expense_id, created_by)
       VALUES($1,$2,'exit',$3,'expense',$4,$5,$6)`,
      [organizationId, cashSessionId, input.amount_cents, description, expense.id, userId],
    )
  }
  return expense
}

export function createUtilitiesRouter() {
  const r = Router()

  // Vue mensuelle : consommation entre relevés, factures par date de dépense.
  r.get(
    "/utilities",
    requirePermission("expense:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const month = typeof req.query.month === "string" ? req.query.month : new Date().toISOString().slice(0, 7)
      const { start, end } = monthBounds(month)
      const siteId = req.query.site_id === undefined || req.query.site_id === "" ? null : parseId(req.query.site_id as string)
      const pool = db()

      const [metersQ, readingsQ, invoicesQ] = await Promise.all([
        pool.query(
          `SELECT m.id, m.site_id, s.name AS site_name, m.provider, m.meter_number, m.is_active, m.created_at,
                  latest.reading_date AS latest_reading_date, latest.index_milli::text AS latest_index_milli
           FROM utility_meters m
           JOIN sites s ON s.id=m.site_id AND s.organization_id=m.organization_id
           LEFT JOIN LATERAL (
             SELECT r.reading_date, r.index_milli FROM utility_readings r
             WHERE r.meter_id=m.id ORDER BY r.reading_date DESC LIMIT 1
           ) latest ON true
           WHERE m.organization_id=$1::uuid AND ($2::uuid IS NULL OR m.site_id=$2::uuid)
           ORDER BY s.name, m.provider`,
          [t.organizationId, siteId],
        ),
        pool.query(
          `${READING_SELECT}
           JOIN utility_meters m ON m.id=ordered.meter_id
           WHERE ordered.reading_date>=$2::date AND ordered.reading_date<$3::date
             AND ($4::uuid IS NULL OR m.site_id=$4::uuid)
           ORDER BY ordered.meter_id, ordered.reading_date DESC`,
          [t.organizationId, start, end, siteId],
        ),
        pool.query(
          `SELECT r.meter_id, SUM(e.amount_cents)::int AS invoiced_cents
           FROM expenses e
           JOIN utility_readings r ON r.id=e.utility_reading_id
           WHERE e.organization_id=$1::uuid AND e.expense_date>=$2::date AND e.expense_date<$3::date
             AND e.status<>'cancelled' AND ($4::uuid IS NULL OR e.site_id=$4::uuid)
           GROUP BY r.meter_id`,
          [t.organizationId, start, end, siteId],
        ),
      ])

      const readingsByMeter = new Map<string, ReturnType<typeof mapReading>[]>()
      for (const row of readingsQ.rows) {
        const reading = mapReading(row)
        const list = readingsByMeter.get(reading.meter_id) ?? []
        list.push(reading)
        readingsByMeter.set(reading.meter_id, list)
      }
      const invoicedByMeter = new Map(invoicesQ.rows.map((row) => [String(row.meter_id), Number(row.invoiced_cents)]))

      const meters = metersQ.rows.map((row) => {
        const readings = readingsByMeter.get(String(row.id)) ?? []
        return {
          id: String(row.id),
          site_id: String(row.site_id),
          site_name: String(row.site_name),
          provider: row.provider,
          meter_number: row.meter_number,
          is_active: row.is_active,
          latest_reading: row.latest_reading_date
            ? { reading_date: dateOnly(row.latest_reading_date), index_milli: Number(row.latest_index_milli) }
            : null,
          month_consumption_milli: readings.reduce((sum, reading) => sum + (reading.consumption_milli ?? 0), 0),
          month_invoiced_cents: invoicedByMeter.get(String(row.id)) ?? 0,
          readings,
        }
      })
      const totals = {
        electricity_milli: meters.filter((m) => m.provider === "cie").reduce((sum, m) => sum + m.month_consumption_milli, 0),
        water_milli: meters.filter((m) => m.provider === "sodeci").reduce((sum, m) => sum + m.month_consumption_milli, 0),
        invoiced_cents: meters.reduce((sum, m) => sum + m.month_invoiced_cents, 0),
      }
      res.json({ month, totals, meters })
    }),
  )

  r.get(
    "/utility-readings/:id/photo",
    requirePermission("expense:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const readingId = parseId(req.params.id)
      const q = await db().query(
        `SELECT p.mime_type, p.photo_data
         FROM utility_reading_photos p
         JOIN utility_readings r ON r.id=p.reading_id AND r.organization_id=p.organization_id
         WHERE p.reading_id=$1::uuid AND p.organization_id=$2::uuid`,
        [readingId, t.organizationId],
      )
      if (!q.rowCount) throw new HttpError(404, "utility_photo_not_found", "Aucune photo n'est jointe à ce relevé.")
      const row = q.rows[0]
      const raw = row.photo_data
      const data = Buffer.isBuffer(raw)
        ? raw
        : raw instanceof Uint8Array
          ? Buffer.from(raw)
          : Buffer.from(String(raw).replace(/^\\x/, ""), "hex")
      const extension = row.mime_type === "image/webp" ? "webp" : "jpg"
      res.setHeader("Content-Type", String(row.mime_type))
      res.setHeader("Content-Length", String(data.length))
      res.setHeader("Content-Disposition", `inline; filename="releve-${readingId}.${extension}"`)
      res.setHeader("Cache-Control", "private, max-age=300")
      res.setHeader("X-Content-Type-Options", "nosniff")
      res.send(data)
    }),
  )

  r.post(
    "/utility-meters",
    requirePermission("expense:create"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(utilityValidators.meter, req.body)
      const pool = db()
      await withIdempotency(pool, req, res, t.organizationId, fingerprint({ op: "utility-meter", ...input }), async () => {
        const client = await pool.connect()
        try {
          await client.query("BEGIN")
          const site = await client.query("SELECT 1 FROM sites WHERE id=$1::uuid AND organization_id=$2::uuid", [input.site_id, t.organizationId])
          if (!site.rowCount) throw new HttpError(400, "invalid_site", "Station invalide.")
          await assertSiteWritable(client, t.organizationId, input.site_id)
          const q = await client.query(
            `INSERT INTO utility_meters(organization_id, site_id, provider, meter_number, created_by)
             VALUES($1,$2,$3,$4,$5) RETURNING id, site_id, provider, meter_number, is_active, created_at`,
            [t.organizationId, input.site_id, input.provider, input.meter_number, t.userId],
          )
          await client.query(
            "INSERT INTO audit_logs(organization_id,actor_user_id,action,entity_type,entity_id) VALUES($1,$2,'utility_meter.created','utility_meter',$3)",
            [t.organizationId, t.userId, q.rows[0].id],
          )
          await client.query("COMMIT")
          return { status: 201, body: q.rows[0] }
        } catch (error) {
          await client.query("ROLLBACK")
          if (isUniqueViolation(error)) {
            throw new HttpError(409, "meter_exists", "Ce fournisseur a déjà un compteur dans cette station.")
          }
          throw error
        } finally {
          client.release()
        }
      })
    }),
  )

  r.post(
    "/utility-meters/:id/readings",
    requirePermission("expense:create"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const meterId = parseId(req.params.id)
      const input = body(utilityValidators.reading, req.body)
      assertNotFuture(input.reading_date, "La date du relevé")
      if (input.invoice) assertNotFuture(input.invoice.expense_date, "La date de la facture")
      const indexMilli = indexToMilli(input.index_value)
      const pool = db()

      await withIdempotency(pool, req, res, t.organizationId, fingerprint({ op: "utility-reading", meterId, ...input }), async () => {
        const client = await pool.connect()
        try {
          await client.query("BEGIN")
          const meter = await lockedMeter(client, t.organizationId, meterId)
          await assertSiteWritable(client, t.organizationId, meter.site_id)
          await assertChronology(client, meterId, input.reading_date, indexMilli)
          const inserted = await client.query(
            `INSERT INTO utility_readings(organization_id, meter_id, reading_date, index_milli, notes, created_by)
             VALUES($1,$2,$3::date,$4,$5,$6) RETURNING id, reading_date::text`,
            [t.organizationId, meterId, input.reading_date, indexMilli, input.notes || null, t.userId],
          )
          const reading = { id: String(inserted.rows[0].id), reading_date: String(inserted.rows[0].reading_date) }
          if (input.invoice) await createUtilityExpense(client, input.invoice, meter, reading, t.organizationId, t.userId)
          await client.query(
            `INSERT INTO audit_logs(organization_id,actor_user_id,action,entity_type,entity_id,metadata)
             VALUES($1,$2,'utility_reading.created','utility_reading',$3,$4::jsonb)`,
            [t.organizationId, t.userId, reading.id, JSON.stringify({ meter_id: meterId, reading_date: input.reading_date, index_milli: indexMilli, invoiced: Boolean(input.invoice) })],
          )
          const response = await readingForResponse(client, t.organizationId, reading.id)
          await client.query("COMMIT")
          return { status: 201, body: response }
        } catch (error) {
          await client.query("ROLLBACK")
          if (isUniqueViolation(error)) throw new HttpError(409, "reading_exists", "Un relevé existe déjà à cette date pour ce compteur.")
          throw error
        } finally {
          client.release()
        }
      })
    }),
  )

  // Rattachement d'une facture à un relevé déjà enregistré, sans double emploi.
  r.post(
    "/utility-readings/:id/invoice",
    requirePermission("expense:create"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const readingId = parseId(req.params.id)
      const input = body(utilityValidators.invoice, req.body)
      assertNotFuture(input.expense_date, "La date de la facture")
      const pool = db()

      await withIdempotency(pool, req, res, t.organizationId, fingerprint({ op: "utility-invoice", readingId, ...input }), async () => {
        const client = await pool.connect()
        try {
          await client.query("BEGIN")
          const readingQ = await client.query(
            `SELECT r.id, r.meter_id, r.reading_date FROM utility_readings r
             WHERE r.id=$1::uuid AND r.organization_id=$2::uuid FOR UPDATE`,
            [readingId, t.organizationId],
          )
          if (!readingQ.rowCount) throw new HttpError(404, "reading_not_found", "Relevé introuvable.")
          const existing = await client.query("SELECT id FROM expenses WHERE utility_reading_id=$1::uuid", [readingId])
          if (existing.rowCount) throw new HttpError(409, "invoice_already_recorded", "Cette facture est déjà comptabilisée dans les dépenses.")
          const meter = await lockedMeter(client, t.organizationId, String(readingQ.rows[0].meter_id))
          await assertSiteWritable(client, t.organizationId, meter.site_id)
          const expense = await createUtilityExpense(client, input, meter, readingQ.rows[0], t.organizationId, t.userId)
          await client.query(
            `INSERT INTO audit_logs(organization_id,actor_user_id,action,entity_type,entity_id,metadata)
             VALUES($1,$2,'utility_invoice.recorded','utility_reading',$3,$4::jsonb)`,
            [t.organizationId, t.userId, readingId, JSON.stringify({ expense_id: expense.id, amount_cents: expense.amount_cents, expense_date: input.expense_date })],
          )
          const response = await readingForResponse(client, t.organizationId, readingId)
          await client.query("COMMIT")
          return { status: 201, body: response }
        } catch (error) {
          await client.query("ROLLBACK")
          if (isUniqueViolation(error)) throw new HttpError(409, "invoice_already_recorded", "Cette facture est déjà comptabilisée dans les dépenses.")
          throw error
        } finally {
          client.release()
        }
      })
    }),
  )

  return r
}
