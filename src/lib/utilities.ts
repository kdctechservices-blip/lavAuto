import { formatNumber, LOCALE } from "@/lib/format"

export type UtilityProvider = "cie" | "sodeci"

export interface UtilityExpense {
  id: string
  amount_cents: number
  expense_date: string
  payment_method: string
  reference: string | null
  status: string
}

export interface UtilityReading {
  id: string
  meter_id: string
  cash_session_id: string | null
  reading_date: string
  index_milli: number
  consumption_milli: number | null
  notes: string | null
  anomaly_comment: string | null
  has_photo: boolean
  created_at: string
  expense: UtilityExpense | null
}

export interface UtilityMeter {
  id: string
  site_id: string
  site_name: string
  provider: UtilityProvider
  meter_number: string
  is_active: boolean
  latest_reading: { reading_date: string; index_milli: number } | null
  month_consumption_milli: number
  month_invoiced_cents: number
  readings: UtilityReading[]
}

export interface UtilitiesOverview {
  month: string
  totals: {
    electricity_milli: number
    water_milli: number
    invoiced_cents: number
  }
  meters: UtilityMeter[]
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
  baseline: {
    consumption_milli: number
    wash_count: number
    ratio_per_wash: number
    reading_count: number
  } | null
  alerts: UtilityAlert[]
  anomaly_comment: string | null
  has_photo: boolean
}

export interface UtilityPreview {
  reading_date: string
  readings: UtilityPeriodInsight[]
}

export interface UtilityProviderInsight {
  meter_id: string
  provider: UtilityProvider
  meter_number: string
  consumption_milli: number | null
  daily_average_milli: number | null
  wash_count: number
  ratio_per_wash: number | null
  previous_consumption_milli: number | null
  previous_ratio_per_wash: number | null
  consumption_trend_percent: number | null
  ratio_trend_percent: number | null
  alert_count: number
  reading_count: number
  missing_days: number
  multi_day_periods: number
}

export interface UtilityInsights {
  start_date: string
  end_date: string
  providers: UtilityProviderInsight[]
  days: {
    date: string
    wash_count: number
    readings: (UtilityPeriodInsight | null)[]
  }[]
}

export interface UtilityPhotoInput {
  mime_type: "image/jpeg" | "image/webp"
  data_base64: string
}

export const UTILITY_PROVIDER_META: Record<
  UtilityProvider,
  { label: string; resource: string; unit: string }
> = {
  cie: { label: "CIE", resource: "Électricité", unit: "kWh" },
  sodeci: { label: "SODECI", resource: "Eau", unit: "m³" },
}

/** Les millièmes stockés deviennent une quantité lisible, sans tarif estimé. */
export function formatUtilityQuantity(milli: number | null, provider: UtilityProvider): string {
  if (milli == null || !Number.isFinite(milli)) return "Relevé initial"
  const value = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 3 }).format(milli / 1000)
  return `${value.replace(/[\u202f\u00a0]/g, " ")} ${UTILITY_PROVIDER_META[provider].unit}`
}

export function formatUtilityIndex(milli: number): string {
  return formatNumber(milli / 1000, milli % 1000 === 0 ? 0 : 3)
}

/** Accepte la virgule ou le point, avec au maximum trois décimales. */
export function parseUtilityIndex(value: string): number | null {
  const normalized = value.trim().replace(/[\u202f\u00a0\s]/g, "").replace(",", ".")
  if (!/^\d+(?:\.\d{1,3})?$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) && parsed <= 1_000_000_000 ? parsed : null
}

export function currentUtilityMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

export function currentUtilityDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function formatUtilityRatio(value: number | null, provider: UtilityProvider): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return provider === "cie"
    ? `${formatNumber(value, 2)} kWh/lavage`
    : `${formatNumber(value, 0)} L/lavage`
}

export function formatUtilityLitres(milli: number | null): string {
  if (milli == null || !Number.isFinite(milli)) return "—"
  return `${formatNumber(milli, 0)} L`
}

export function formatUtilityTrend(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "Pas de comparaison"
  const prefix = value > 0 ? "+" : ""
  return `${prefix}${formatNumber(value, 1)} % par lavage`
}
