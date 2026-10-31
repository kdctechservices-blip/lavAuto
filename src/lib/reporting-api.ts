export interface ReportSummary {
  total_washes: number
  completed_washes: number
  revenue_cents: number
  /** Encaissements mobile money encore à confirmer sur la période. */
  pending_cents: number
  /** `null` lorsque le rôle n'a pas le droit de voir les données financières. */
  expenses_cents: number | null
  net_cents: number | null
  paid_washes: number
  /** Lavages non réglés ou partiellement réglés. */
  unpaid_washes: number
}

export interface SeriesReportRow {
  /** Début de la période (jour, lundi de la semaine ou 1er du mois). */
  date: string
  /** Fin de la période couverte par le point. */
  period_end: string
  wash_count: number
  revenue_cents: number
  expenses_cents: number | null
}

export interface ServiceReportRow {
  name: string
  wash_count: number
  quantity: number
  amount_cents: number
}

export interface PaymentMethodReportRow {
  method: string
  payment_count: number
  amount_cents: number
  /** Part confirmée (espèces encaissées, mobile money vérifié). */
  verified_cents: number
  /** Part encore à confirmer auprès de l'opérateur. */
  pending_cents: number
}

export interface WorkerReportRow {
  worker_id: string
  name: string
  role: string
  wash_count: number
  /** Chiffre d'affaires attribué, réparti à parts égales en cas d'équipe. */
  amount_cents: number
}

export type ReportGranularity = "day" | "week" | "month"

/**
 * Une ligne par station active, toujours calculée même lorsqu'un filtre de
 * station est posé : c'est la vue consolidée du propriétaire multi-sites.
 */
export interface SiteReportRow {
  site_id: string
  site_name: string
  city: string
  wash_count: number
  revenue_cents: number
  /** `null` sans le droit de voir les données financières. */
  expenses_cents: number | null
  net_cents: number | null
}

export interface ExpenseCategoryReportRow {
  category: string
  expense_count: number
  amount_cents: number
}

/** Période tronquée par le serveur (essai gratuit terminé). */
export interface ReportRestriction {
  reason: string
  requested_from: string
  window_days: number
  message: string
}

export interface ReportResponse {
  /** Le rôle connecté a-t-il accès aux dépenses et à la marge ? */
  financial_access: boolean
  period: { from: string; to: string; granularity: ReportGranularity }
  granularity: ReportGranularity
  restriction?: ReportRestriction | null
  summary: ReportSummary
  series: SeriesReportRow[]
  top_services: ServiceReportRow[]
  top_workers: WorkerReportRow[]
  payment_methods: PaymentMethodReportRow[]
  expense_categories: ExpenseCategoryReportRow[]
  /** Station sur laquelle le rapport est filtré, `null` si consolidé. */
  site: { id: string; name: string } | null
  by_site: SiteReportRow[]
}
