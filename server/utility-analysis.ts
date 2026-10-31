import type { PoolClient } from "pg"
import { HttpError } from "./auth.ts"
import {
  assertChronology,
  indexToMilli,
  UTILITY_PROVIDERS,
  type UtilityProvider,
} from "./utilities.ts"

const PROVIDER_LABEL: Record<UtilityProvider, string> = { cie: "CIE", sodeci: "SODECI" }
const BASELINE_DAYS = 7
const BASELINE_MIN_READINGS = 7
const BASELINE_MIN_WASHES = 5
const ANOMALY_THRESHOLD = 0.3
export const UTILITY_PHOTO_MAX_BYTES = 300_000

export interface UtilityPhotoInput {
  mime_type: "image/jpeg" | "image/webp"
  data_base64: string
}

export interface ClosingUtilityReadingInput {
  meter_id: string
  index_value: number
  anomaly_comment?: string
  photo?: UtilityPhotoInput
}

export type UtilityAlertCode =
  | "consumption_without_wash"
  | "zero_consumption_with_washes"
  | "high_per_wash"
  | "low_per_wash"

export interface UtilityAlert {
  code: UtilityAlertCode
  message: string
}

export interface UtilityBaseline {
  consumption_milli: number
  wash_count: number
  ratio_per_wash: number
  reading_count: number
}

export interface UtilityPeriodInsight {
  reading_id: string | null
  meter_id: string
  meter_number: string
  provider: UtilityProvider
  reading_date: string
  period_start: string
  period_end: string
  period_days: number
  index_milli: number
  previous_index_milli: number | null
  consumption_milli: number | null
  wash_count: number
  ratio_per_wash: number | null
  baseline: UtilityBaseline | null
  alerts: UtilityAlert[]
  anomaly_comment: string | null
  has_photo: boolean
}

interface UtilityPeriodRow {
  reading_id: string | null
  meter_id: string
  meter_number: string
  provider: UtilityProvider
  reading_date: unknown
  index_milli: string | number
  previous_index_milli: string | number | null
  previous_reading_date: unknown | null
  anomaly_comment?: string | null
  has_photo?: boolean
}

interface UtilityMeterRow {
  id: string
  organization_id: string
  site_id: string
  provider: UtilityProvider
  meter_number: string
  is_active: boolean
}

function dateOnly(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

export function addUtilityDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function dayDifference(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86400000)
}

function periodStart(row: UtilityPeriodRow): string {
  return row.previous_reading_date
    ? addUtilityDays(dateOnly(row.previous_reading_date), 1)
    : dateOnly(row.reading_date)
}

function ratioPerWash(provider: UtilityProvider, consumptionMilli: number, washCount: number): number | null {
  if (washCount <= 0) return null
  // Les index SODECI sont en m³ : leurs millièmes sont numériquement des litres.
  return provider === "cie" ? consumptionMilli / 1000 / washCount : consumptionMilli / washCount
}

function sumWashCount(washes: Record<string, number>, start: string, end: string): number {
  let total = 0
  for (const [date, count] of Object.entries(washes)) {
    if (date >= start && date <= end) total += count
  }
  return total
}

function makePeriod(row: UtilityPeriodRow, washes: Record<string, number>): UtilityPeriodInsight {
  const readingDate = dateOnly(row.reading_date)
  const start = periodStart(row)
  const previous = row.previous_index_milli == null ? null : Number(row.previous_index_milli)
  const index = Number(row.index_milli)
  const consumption = previous == null ? null : index - previous
  const washCount = sumWashCount(washes, start, readingDate)
  return {
    reading_id: row.reading_id ? String(row.reading_id) : null,
    meter_id: String(row.meter_id),
    meter_number: String(row.meter_number),
    provider: row.provider,
    reading_date: readingDate,
    period_start: start,
    period_end: readingDate,
    period_days: Math.max(1, dayDifference(start, readingDate) + 1),
    index_milli: index,
    previous_index_milli: previous,
    consumption_milli: consumption,
    wash_count: washCount,
    ratio_per_wash: consumption == null ? null : ratioPerWash(row.provider, consumption, washCount),
    baseline: null,
    alerts: [],
    anomaly_comment: row.anomaly_comment?.trim() || null,
    has_photo: Boolean(row.has_photo),
  }
}

/** Référence mobile : périodes closes pendant les sept jours précédant la période courante. */
function baselineFor(period: UtilityPeriodInsight, history: UtilityPeriodInsight[]): UtilityBaseline | null {
  const start = addUtilityDays(period.period_start, -BASELINE_DAYS)
  const hasFourteenDaysHistory = history.some((candidate) =>
    candidate.meter_id === period.meter_id && candidate.reading_date <= addUtilityDays(period.period_start, -14),
  )
  if (!hasFourteenDaysHistory) return null
  const eligible = history.filter((candidate) =>
    candidate.meter_id === period.meter_id &&
    candidate.reading_date >= start &&
    candidate.reading_date < period.period_start &&
    candidate.consumption_milli != null,
  )
  if (eligible.length < BASELINE_MIN_READINGS) return null
  const consumption = eligible.reduce((sum, candidate) => sum + Number(candidate.consumption_milli), 0)
  const washCount = eligible.reduce((sum, candidate) => sum + candidate.wash_count, 0)
  if (consumption <= 0 || washCount < BASELINE_MIN_WASHES) return null
  const ratio = ratioPerWash(period.provider, consumption, washCount)
  if (ratio == null || ratio <= 0) return null
  return {
    consumption_milli: consumption,
    wash_count: washCount,
    ratio_per_wash: ratio,
    reading_count: eligible.length,
  }
}

export function utilityAlerts(period: UtilityPeriodInsight): UtilityAlert[] {
  if (period.consumption_milli == null) return []
  const alerts: UtilityAlert[] = []
  const duration = period.period_days > 1 ? ` sur la période de ${period.period_days} jours` : ""
  if (period.consumption_milli > 0 && period.wash_count === 0) {
    alerts.push({
      code: "consumption_without_wash",
      message: `Consommation mesurée sans lavage terminé${duration}. Vérifiez une fuite, un essai ou un usage non enregistré.`,
    })
  }
  if (period.consumption_milli === 0 && period.wash_count > 0) {
    alerts.push({
      code: "zero_consumption_with_washes",
      message: `Consommation nulle avec ${period.wash_count} lavage${period.wash_count > 1 ? "s" : ""}${duration}. Vérifiez l'index et le compteur.`,
    })
  }
  if (period.baseline && period.ratio_per_wash != null && period.baseline.ratio_per_wash > 0) {
    const variation = period.ratio_per_wash / period.baseline.ratio_per_wash - 1
    if (variation > ANOMALY_THRESHOLD) {
      alerts.push({
        code: "high_per_wash",
        message: `Consommation par lavage en hausse de ${Math.round(variation * 100)} % par rapport à la moyenne mobile sur sept jours.`,
      })
    } else if (variation < -ANOMALY_THRESHOLD) {
      alerts.push({
        code: "low_per_wash",
        message: `Consommation par lavage en baisse de ${Math.round(Math.abs(variation) * 100)} % par rapport à la moyenne mobile sur sept jours. Vérifiez le relevé.`,
      })
    }
  }
  return alerts
}

function enrichPeriod(period: UtilityPeriodInsight, history: UtilityPeriodInsight[]): UtilityPeriodInsight {
  const enriched = { ...period, baseline: baselineFor(period, history) }
  enriched.alerts = utilityAlerts(enriched)
  return enriched
}

async function periodRows(
  client: PoolClient,
  organizationId: string,
  siteId: string,
  fromDate: string,
  toDate: string,
): Promise<UtilityPeriodRow[]> {
  const q = await client.query(
    `SELECT * FROM (
       SELECT r.id AS reading_id, r.meter_id, m.meter_number, m.provider,
              r.reading_date, r.index_milli,
              LAG(r.index_milli) OVER (PARTITION BY r.meter_id ORDER BY r.reading_date) AS previous_index_milli,
              LAG(r.reading_date) OVER (PARTITION BY r.meter_id ORDER BY r.reading_date) AS previous_reading_date,
              r.anomaly_comment,
              EXISTS(SELECT 1 FROM utility_reading_photos p WHERE p.reading_id=r.id) AS has_photo
       FROM utility_readings r
       JOIN utility_meters m ON m.id=r.meter_id
       WHERE r.organization_id=$1::uuid AND m.site_id=$2::uuid AND r.reading_date<=$3::date
     ) ordered
     WHERE reading_date>=$4::date
     ORDER BY reading_date, provider`,
    [organizationId, siteId, toDate, fromDate],
  )
  return q.rows as UtilityPeriodRow[]
}

async function dailyWashCounts(
  client: PoolClient,
  organizationId: string,
  siteId: string,
  startDate: string,
  endDate: string,
): Promise<Record<string, number>> {
  const q = await client.query(
    `SELECT COALESCE(completed_at, created_at)::date AS wash_date, COUNT(*)::int AS wash_count
     FROM washes
     WHERE organization_id=$1::uuid AND site_id=$2::uuid
       AND status='completed' AND operation_status='completed'
       AND COALESCE(completed_at, created_at)>=$3::date
       AND COALESCE(completed_at, created_at)<($4::date + INTERVAL '1 day')
     GROUP BY COALESCE(completed_at, created_at)::date`,
    [organizationId, siteId, startDate, endDate],
  )
  return Object.fromEntries(q.rows.map((row) => [dateOnly(row.wash_date), Number(row.wash_count)]))
}

function earliestPeriodStart(rows: UtilityPeriodRow[], fallback: string): string {
  return rows.reduce((earliest, row) => {
    const start = periodStart(row)
    return start < earliest ? start : earliest
  }, fallback)
}

/**
 * Analyse sans écrire. En clôture, les compteurs sont verrouillés et un avis
 * devient obligatoire dès qu'une anomalie est détectée. L'aperçu emploie le
 * même calcul, mais laisse justement l'utilisateur ajouter ce commentaire.
 */
export async function analyzeClosingUtilityReadings(
  client: PoolClient,
  organizationId: string,
  siteId: string,
  readingDate: string,
  inputs: ClosingUtilityReadingInput[],
  options: { forUpdate: boolean; requireComments: boolean },
): Promise<UtilityPeriodInsight[]> {
  const metersQ = await client.query(
    `SELECT id, organization_id, site_id, provider, meter_number, is_active
     FROM utility_meters
     WHERE organization_id=$1::uuid AND site_id=$2::uuid AND is_active
     ORDER BY provider ${options.forUpdate ? "FOR UPDATE" : ""}`,
    [organizationId, siteId],
  )
  const meters = metersQ.rows as UtilityMeterRow[]
  const meterById = new Map(meters.map((meter) => [String(meter.id), meter]))
  const inputByMeter = new Map<string, ClosingUtilityReadingInput>()
  for (const input of inputs) {
    if (inputByMeter.has(input.meter_id)) {
      throw new HttpError(400, "duplicate_utility_meter", "Un compteur ne peut être relevé qu'une fois à la clôture.")
    }
    if (!meterById.has(input.meter_id)) {
      throw new HttpError(400, "invalid_utility_meter", "Un compteur transmis n'appartient pas à la station de cette caisse.")
    }
    inputByMeter.set(input.meter_id, input)
  }
  if (!meters.length) return []

  const currentRows: UtilityPeriodRow[] = []
  const missing: string[] = []
  for (const meter of meters) {
    const meterId = String(meter.id)
    const input = inputByMeter.get(meterId)
    const existing = await client.query(
      `SELECT id, index_milli::text, anomaly_comment,
              EXISTS(SELECT 1 FROM utility_reading_photos p WHERE p.reading_id=utility_readings.id) AS has_photo
       FROM utility_readings WHERE meter_id=$1::uuid AND reading_date=$2::date`,
      [meterId, readingDate],
    )
    if (existing.rowCount) {
      const indexMilli = Number(existing.rows[0].index_milli)
      if (input && indexToMilli(input.index_value) !== indexMilli) {
        throw new HttpError(409, "daily_reading_exists", `Le relevé ${PROVIDER_LABEL[meter.provider]} du jour existe déjà avec un autre index.`)
      }
      const previous = await client.query(
        `SELECT index_milli::text, reading_date FROM utility_readings
         WHERE meter_id=$1::uuid AND reading_date<$2::date ORDER BY reading_date DESC LIMIT 1`,
        [meterId, readingDate],
      )
      currentRows.push({
        reading_id: String(existing.rows[0].id),
        meter_id: meterId,
        meter_number: meter.meter_number,
        provider: meter.provider,
        reading_date: readingDate,
        index_milli: indexMilli,
        previous_index_milli: previous.rowCount ? String(previous.rows[0].index_milli) : null,
        previous_reading_date: previous.rowCount ? previous.rows[0].reading_date : null,
        anomaly_comment: input?.anomaly_comment?.trim() || existing.rows[0].anomaly_comment,
        has_photo: Boolean(existing.rows[0].has_photo || input?.photo),
      })
      continue
    }
    if (!input) {
      missing.push(PROVIDER_LABEL[meter.provider])
      continue
    }
    const previous = await client.query(
      `SELECT index_milli::text, reading_date FROM utility_readings
       WHERE meter_id=$1::uuid AND reading_date<$2::date ORDER BY reading_date DESC LIMIT 1`,
      [meterId, readingDate],
    )
    currentRows.push({
      reading_id: null,
      meter_id: meterId,
      meter_number: meter.meter_number,
      provider: meter.provider,
      reading_date: readingDate,
      index_milli: indexToMilli(input.index_value),
      previous_index_milli: previous.rowCount ? String(previous.rows[0].index_milli) : null,
      previous_reading_date: previous.rowCount ? previous.rows[0].reading_date : null,
      anomaly_comment: input.anomaly_comment?.trim() || null,
      has_photo: Boolean(input.photo),
    })
  }
  if (missing.length) {
    throw new HttpError(400, "utility_readings_required", `Relevez les index du jour avant de clôturer la caisse : ${missing.join(", ")}.`)
  }

  for (const row of currentRows) {
    if (!row.reading_id) {
      await assertChronology(client, String(row.meter_id), readingDate, Number(row.index_milli))
    }
  }

  const historyRows = await periodRows(client, organizationId, siteId, addUtilityDays(readingDate, -21), readingDate)
  const allRows = [...historyRows, ...currentRows.filter((row) => !row.reading_id)]
  const washStart = earliestPeriodStart(allRows, addUtilityDays(readingDate, -21))
  const washes = await dailyWashCounts(client, organizationId, siteId, washStart, readingDate)
  const history = historyRows.map((row) => makePeriod(row, washes))
  const analyses = currentRows.map((row) => enrichPeriod(makePeriod(row, washes), history))

  if (options.requireComments) {
    const uncommented = analyses.filter((analysis) => analysis.alerts.length > 0 && !analysis.anomaly_comment)
    if (uncommented.length) {
      throw new HttpError(
        400,
        "utility_anomaly_comment_required",
        `Une anomalie doit être vérifiée et commentée avant la clôture : ${uncommented.map((analysis) => PROVIDER_LABEL[analysis.provider]).join(", ")}.`,
      )
    }
  }
  return analyses
}

function decodeUtilityPhoto(photo: UtilityPhotoInput): Buffer {
  if (photo.data_base64.length > UTILITY_PHOTO_MAX_BYTES * 4 / 3 + 4) {
    throw new HttpError(400, "utility_photo_too_large", "La photo compressée ne doit pas dépasser 300 Ko.")
  }
  if (photo.data_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(photo.data_base64)) {
    throw new HttpError(400, "invalid_utility_photo", "Le justificatif photo est invalide.")
  }
  const data = Buffer.from(photo.data_base64, "base64")
  if (data.length > UTILITY_PHOTO_MAX_BYTES) {
    throw new HttpError(400, "utility_photo_too_large", "La photo compressée ne doit pas dépasser 300 Ko.")
  }
  if (!data.length || data.toString("base64") !== photo.data_base64) {
    throw new HttpError(400, "invalid_utility_photo", "Le justificatif photo est invalide.")
  }
  const jpeg = data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
  const webp = data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP"
  if ((photo.mime_type === "image/jpeg" && !jpeg) || (photo.mime_type === "image/webp" && !webp)) {
    throw new HttpError(400, "invalid_utility_photo", "Le contenu de la photo ne correspond pas à son format.")
  }
  return data
}

async function saveUtilityPhoto(
  client: PoolClient,
  organizationId: string,
  userId: string,
  readingId: string,
  photo: UtilityPhotoInput,
) {
  const data = decodeUtilityPhoto(photo)
  await client.query(
    `INSERT INTO utility_reading_photos(organization_id, reading_id, mime_type, byte_size, photo_data, created_by)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (reading_id) DO UPDATE SET
       mime_type=EXCLUDED.mime_type, byte_size=EXCLUDED.byte_size,
       photo_data=EXCLUDED.photo_data, created_by=EXCLUDED.created_by, created_at=now()`,
    [organizationId, readingId, photo.mime_type, data.length, data, userId],
  )
}

/** Enregistre les relevés et leurs justificatifs dans la transaction de clôture. */
export async function recordClosingUtilityReadings(
  client: PoolClient,
  organizationId: string,
  userId: string,
  siteId: string,
  cashSessionId: string,
  readingDate: string,
  inputs: ClosingUtilityReadingInput[],
) {
  const analyses = await analyzeClosingUtilityReadings(
    client,
    organizationId,
    siteId,
    readingDate,
    inputs,
    { forUpdate: true, requireComments: true },
  )
  const inputByMeter = new Map(inputs.map((input) => [input.meter_id, input]))
  const results: { id: string; meter_id: string; index_milli: number; created: boolean }[] = []

  for (const analysis of analyses) {
    const input = inputByMeter.get(analysis.meter_id)
    let readingId = analysis.reading_id
    if (readingId) {
      if (input?.anomaly_comment?.trim()) {
        await client.query(
          "UPDATE utility_readings SET anomaly_comment=$2 WHERE id=$1::uuid AND organization_id=$3::uuid",
          [readingId, input.anomaly_comment.trim(), organizationId],
        )
      }
      if (input?.photo) await saveUtilityPhoto(client, organizationId, userId, readingId, input.photo)
      if (input?.anomaly_comment?.trim() || input?.photo) {
        await client.query(
          `INSERT INTO audit_logs(organization_id,actor_user_id,action,entity_type,entity_id,metadata)
           VALUES($1,$2,'utility_reading.reviewed','utility_reading',$3,$4::jsonb)`,
          [organizationId, userId, readingId, JSON.stringify({ cash_session_id: cashSessionId, alerts: analysis.alerts.map((alert) => alert.code), has_photo: analysis.has_photo })],
        )
      }
      results.push({ id: readingId, meter_id: analysis.meter_id, index_milli: analysis.index_milli, created: false })
      continue
    }

    const inserted = await client.query(
      `INSERT INTO utility_readings(organization_id, meter_id, cash_session_id, reading_date, index_milli, notes, anomaly_comment, created_by)
       VALUES($1,$2,$3,$4::date,$5,'Relevé quotidien à la clôture de caisse',$6,$7) RETURNING id`,
      [organizationId, analysis.meter_id, cashSessionId, readingDate, analysis.index_milli, analysis.anomaly_comment, userId],
    )
    readingId = String(inserted.rows[0].id)
    if (input?.photo) await saveUtilityPhoto(client, organizationId, userId, readingId, input.photo)
    await client.query(
      `INSERT INTO audit_logs(organization_id,actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,$2,'utility_reading.created','utility_reading',$3,$4::jsonb)`,
      [organizationId, userId, readingId, JSON.stringify({
        meter_id: analysis.meter_id,
        cash_session_id: cashSessionId,
        reading_date: readingDate,
        index_milli: analysis.index_milli,
        consumption_milli: analysis.consumption_milli,
        ratio_per_wash: analysis.ratio_per_wash,
        alerts: analysis.alerts.map((alert) => alert.code),
        has_photo: Boolean(input?.photo),
        source: "cash_close",
      })],
    )
    results.push({ id: readingId, meter_id: analysis.meter_id, index_milli: analysis.index_milli, created: true })
  }
  return results
}

function aggregatePeriods(provider: UtilityProvider, periods: UtilityPeriodInsight[]) {
  const measured = periods.filter((period) => period.consumption_milli != null)
  if (!measured.length) return { consumption_milli: null, wash_count: 0, ratio_per_wash: null }
  const consumption = measured.reduce((sum, period) => sum + Number(period.consumption_milli), 0)
  const washCount = measured.reduce((sum, period) => sum + period.wash_count, 0)
  return {
    consumption_milli: consumption,
    wash_count: washCount,
    ratio_per_wash: ratioPerWash(provider, consumption, washCount),
  }
}

function trendPercent(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous <= 0) return null
  return Math.round((current / previous - 1) * 1000) / 10
}

/** Synthèse sur sept jours, précédée de sa semaine de comparaison. */
export async function getUtilityInsights(
  client: PoolClient,
  organizationId: string,
  siteId: string,
  endDate: string,
) {
  const startDate = addUtilityDays(endDate, -6)
  const previousStartDate = addUtilityDays(startDate, -7)
  const historyFromDate = addUtilityDays(previousStartDate, -14)
  const metersQ = await client.query(
    `SELECT id, provider, meter_number FROM utility_meters
     WHERE organization_id=$1::uuid AND site_id=$2::uuid AND is_active ORDER BY provider`,
    [organizationId, siteId],
  )
  const rows = await periodRows(client, organizationId, siteId, historyFromDate, endDate)
  const washStart = earliestPeriodStart(rows, startDate)
  const washes = await dailyWashCounts(client, organizationId, siteId, washStart < startDate ? washStart : startDate, endDate)
  const periods = rows.map((row) => makePeriod(row, washes))
  const annotated = periods.map((period) =>
    period.reading_date >= startDate ? enrichPeriod(period, periods) : period,
  )
  const current = annotated.filter((period) => period.reading_date >= startDate)
  const previous = annotated.filter((period) => period.reading_date >= previousStartDate && period.reading_date < startDate)

  const providers = (metersQ.rows as { id: string; provider: UtilityProvider; meter_number: string }[]).map((meter) => {
    const currentProvider = current.filter((period) => period.meter_id === String(meter.id))
    const previousProvider = previous.filter((period) => period.meter_id === String(meter.id))
    const currentTotal = aggregatePeriods(meter.provider, currentProvider)
    const previousTotal = aggregatePeriods(meter.provider, previousProvider)
    const coveredDates = new Set(currentProvider.map((period) => period.reading_date))
    return {
      meter_id: String(meter.id),
      provider: meter.provider,
      meter_number: meter.meter_number,
      consumption_milli: currentTotal.consumption_milli,
      daily_average_milli: currentTotal.consumption_milli == null ? null : currentTotal.consumption_milli / 7,
      wash_count: currentTotal.wash_count,
      ratio_per_wash: currentTotal.ratio_per_wash,
      previous_consumption_milli: previousTotal.consumption_milli,
      previous_ratio_per_wash: previousTotal.ratio_per_wash,
      consumption_trend_percent: trendPercent(currentTotal.consumption_milli, previousTotal.consumption_milli),
      ratio_trend_percent: trendPercent(currentTotal.ratio_per_wash, previousTotal.ratio_per_wash),
      alert_count: currentProvider.filter((period) => period.alerts.length > 0).length,
      reading_count: currentProvider.length,
      missing_days: Math.max(0, 7 - coveredDates.size),
      multi_day_periods: currentProvider.filter((period) => period.period_days > 1).length,
    }
  })

  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addUtilityDays(startDate, index)
    return {
      date,
      wash_count: washes[date] ?? 0,
      readings: UTILITY_PROVIDERS.map((provider) => current.find((period) => period.reading_date === date && period.provider === provider) ?? null),
    }
  })
  return { start_date: startDate, end_date: endDate, providers, days }
}
