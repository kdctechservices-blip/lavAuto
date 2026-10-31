export type ConsoleSubscriptionStatus = "trialing" | "active" | "expired" | "cancelled" | "none"

export interface ConsoleOrganization {
  id: string
  name: string
  created_at: string
  owner_email: string | null
  owner_phone: string | null
  member_count: number
  site_count: number
  plan_code: string | null
  plan_name: string | null
  plan_price_cents: number
  status: ConsoleSubscriptionStatus
  stored_status: string | null
  read_only: boolean
  current_period_end: string | null
  plan_changed_at: string | null
  days_remaining: number | null
  past_due: boolean
  days_past_due: number
  /** Suppression programmée — l'accès est déjà coupé. */
  pending_deletion: boolean
  deletion_requested_at: string | null
  deletion_scheduled_for: string | null
  deletion_reason: string | null
  /** Surveillance : dernière activité réelle de la station. */
  last_wash_at: string | null
  idle_days: number | null
  dormant: boolean
}

export interface ConsoleMember {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  user_status: string
  role: string
  membership_status: string
  created_at: string
  last_seen_at: string | null
}

export interface ConsolePlan {
  code: string
  name: string
  price_cents: number
  billing_cycle: string
  max_users: number | null
  max_workers: number | null
  max_sites: number | null
}

export interface ConsolePaymentIntent {
  reference: string
  organization_id: string
  organization_name: string
  plan_code: string
  plan_name: string
  months: number
  amount_cents: number
  status: string
  declared_at: string | null
  transaction_reference: string | null
  paid_with: string | null
  created_at: string
  expires_at: string
}

export interface ConsoleUpgradeRequest {
  id: string
  organization_id: string
  organization_name: string
  plan_code: string | null
  requested_at: string
  contact_email: string | null
  contact_phone: string | null
  note: string | null
}

export interface ConsoleAuditEntry {
  id: string
  operator_email: string
  action: string
  organization_id: string | null
  organization_name: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export const STATUS_LABELS: Record<ConsoleSubscriptionStatus, string> = {
  trialing: "Essai",
  active: "Actif",
  expired: "Essai échu",
  cancelled: "Résilié",
  none: "Sans abonnement",
}

export const ROLE_LABELS: Record<string, string> = {
  owner: "Propriétaire",
  manager: "Gérant",
  cashier: "Caissier",
  washer: "Agent de lavage",
}

/** Libellés du journal de la console. */
export const ACTION_LABELS: Record<string, string> = {
  "organization.deletion_scheduled": "Suppression programmée",
  "organization.deletion_cancelled": "Suppression annulée",
  "organization.purged": "Station effacée définitivement",
  "user.password_reset_requested": "Lien de réinitialisation émis",
  "user.enabled": "Compte réactivé",
  "user.disabled": "Compte désactivé",
  "subscription.activated": "Forfait activé",
  "subscription.suspended": "Abonnement suspendu",
  "subscription.trial_extended": "Essai prolongé",
  "subscription.request_declined": "Demande déclinée",
}

// ---------------------------------------------------------------------------
// Revenus — formes renvoyées par GET /console/revenue
//
// Vérifiées contre le serveur en marche : un type n'est qu'une déclaration
// d'intention tant que personne n'a comparé les clés au JSON réel.
// ---------------------------------------------------------------------------

export interface RevenueMonth {
  month: string
  collected_cents: number
  recognized_cents: number
  payments: number
}

export interface RevenueEntry {
  id: string
  organization_id: string | null
  organization_name: string
  plan_code: string
  plan_name: string
  amount_cents: number
  months: number
  period_start: string
  period_end: string
  channel: string
  payment_reference: string | null
  source: string
  operator_email: string | null
  note: string | null
  reverses_id: string | null
  occurred_at: string
}

export interface RevenueAtRisk {
  organization_id: string
  organization_name: string
  plan_code: string
  plan_name: string
  price_cents: number
  current_period_end: string
  days_overdue: number
}

export interface RevenuePending {
  reference: string
  organization_id: string
  organization_name: string
  plan_code: string
  months: number
  amount_cents: number
  declared_at: string | null
  created_at: string
}

export interface RevenueResponse {
  from: string
  to: string
  series: RevenueMonth[]
  recent: RevenueEntry[]
  at_risk: RevenueAtRisk[]
  pending: RevenuePending[]
  totals: {
    collected_cents: number
    deferred_cents: number
    at_risk_cents: number
    pending_cents: number
    month_collected_cents: number
    month_recognized_cents: number
  }
  channels: Array<{ code: string; label: string }>
  server_time: string
}

/** Une personne, vue depuis la console : son compte, pas une de ses stations. */
export interface ConsoleAccount {
  id: string
  email: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  status: string
  created_at: string
  last_seen_at: string | null
  active_sessions: number
  memberships: number
}

/** Le lien entre une personne et une station. */
export interface ConsoleAccountMembership {
  organization_id: string
  organization_name: string
  slug: string
  role: string
  status: string
  created_at: string
  disabled_at: string | null
  deletion_requested_at: string | null
  permission_overrides: number
}

export interface ConsoleAccountSession {
  created_at: string
  last_used_at: string | null
  expires_at: string
}

export interface ConsoleAccountDetail {
  account: ConsoleAccount
  memberships: ConsoleAccountMembership[]
  sessions: ConsoleAccountSession[]
  sole_owner_of: Array<{ organization_id: string; name: string }>
}

/** État de l'engagement de délai sur une demande. */
export interface SupportSla {
  breached: boolean
  hours_remaining: number
  responded: boolean
}

export interface SupportRequest {
  id: string
  organization_id: string
  organization_name: string
  created_by: string | null
  subject: string
  category: string
  status: string
  plan_code: string | null
  commitment_hours: number
  response_due_at: string
  first_responded_at: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
  requester_name: string | null
  requester_email: string | null
  requester_phone: string | null
  message_count: number
  sla: SupportSla
}

export interface SupportMessage {
  id: string
  author_user_id: string | null
  author_operator_email: string | null
  author_name: string | null
  internal: boolean
  body: string
  created_at: string
}

export const SUPPORT_STATUS_LABELS: Record<string, string> = {
  open: "En attente de réponse",
  answered: "Répondu",
  resolved: "Résolu",
}

export const SUPPORT_CATEGORY_LABELS: Record<string, string> = {
  technique: "Problème technique",
  facturation: "Abonnement et facturation",
  formation: "Prise en main",
  autre: "Autre",
}

/** Diagnostic technique d'un membre, vu depuis la console. */
export interface MemberDiagnostic {
  member: {
    user_id: string
    email: string
    name: string | null
    organization_id: string
    organization_name: string
    role: string
    role_label: string
    account_status: string
    membership_status: string
    disabled_at: string | null
    active_sessions: number
    last_seen_at: string | null
  }
  subscription: {
    status: string
    plan_code: string | null
    plan_name: string | null
    read_only: boolean
    days_remaining: number
    restricted: string[]
  }
  limits: Array<{ key: string; label: string; used: number; max: number | null; reached: boolean }>
  permissions: {
    granted: Array<{ permission: string; label: string; source: string }>
    overrides: Array<{ permission: string; label: string; granted: boolean }>
  }
  blockers: Array<{ cause: string; explanation: string }>
  recent_activity: Array<{ action: string; entity_type: string | null; created_at: string }>
  server_time: string
}

// ---------------------------------------------------------------------------
// Surveillance
// ---------------------------------------------------------------------------

export interface MonitoringBucket {
  bucket_start: string
  requests: number
  errors: number
  slow: number
  avg_duration_ms: number
}

export interface MonitoringRoute {
  method: string
  route: string
  requests: number
  errors?: number
  avg_duration_ms?: number
  max_duration_ms?: number
}

export interface ErrorGroup {
  method: string
  route: string
  code: string
  message: string
  occurrences: number
  organizations: number
  first_seen: string
  last_seen: string
  latest_id: string
}

export interface MonitoringOverview {
  window_hours: number
  totals: {
    requests: number
    server_errors: number
    client_errors: number
    slow: number
    error_rate: number
    avg_duration_ms: number
    max_duration_ms: number
  }
  series: MonitoringBucket[]
  failing_routes: MonitoringRoute[]
  slowest_routes: MonitoringRoute[]
  error_groups: ErrorGroup[]
  thresholds: {
    slow_request_ms: number
    error_retention_days: number
    metrics_retention_days: number
  }
  server_time: string
}

export interface ErrorEvent {
  id: string
  kind: "error" | "slow"
  method: string
  route: string
  path: string
  status: number
  code: string
  message: string
  stack?: string | null
  duration_ms: number
  organization_id: string | null
  organization_name: string | null
  user_id: string | null
  user_name?: string | null
  user_email?: string | null
  operator_email: string | null
  request_body?: unknown
  occurred_at: string
}

export interface ConsoleOperatorAccount {
  id: string
  email: string
  full_name: string
  role: "admin" | "supervisor" | "support"
  status: "active" | "disabled"
  managed_by: "bootstrap" | "console"
  created_at: string
  updated_at: string
  last_login_at: string | null
  active_sessions: number
}

export interface AlertSettings {
  enabled: boolean
  error_rate_percent: number
  min_requests: number
  slow_request_count: number
  window_minutes: number
  cooldown_minutes: number
  email_recipients: string[]
  whatsapp_recipients: string[]
  updated_at: string
}

export interface AlertDelivery {
  channel: "email" | "whatsapp"
  recipient: string
  delivered: boolean
  error: string | null
}

export interface AlertEvent {
  id: string
  fingerprint: string
  kind: "error_rate" | "slow_requests" | "test"
  severity: "info" | "warning" | "critical"
  title: string
  message: string
  metrics: Record<string, unknown>
  deliveries: AlertDelivery[]
  triggered_at: string
}

export interface ReconciliationBatch {
  id: string
  provider: string
  source_name: string | null
  period_start: string
  period_end: string
  status: "matched" | "attention" | "failed"
  total_rows: number
  matched_rows: number
  discrepancy_rows: number
  ignored_rows: number
  created_by_email: string | null
  created_at: string
  open_discrepancies?: number
}

export interface ReconciliationRun {
  id: string
  trigger_kind: "manual" | "scheduled"
  status: "running" | "success" | "failed"
  batch_id: string | null
  error: string | null
  started_at: string
  finished_at: string | null
}

export interface StatementEntry {
  id: string
  line_number: number
  provider_reference: string | null
  merchant_reference: string | null
  amount_cents: number
  currency: string
  provider_status: string
  occurred_at: string | null
}

export interface ReconciliationDiscrepancy {
  id: string
  batch_id: string
  statement_entry_id: string | null
  payment_id: string | null
  payment_intent_id: string | null
  kind: "amount_mismatch" | "missing_in_register" | "missing_in_statement" | "duplicate_reference"
  reference: string | null
  organization_name: string | null
  expected_amount_cents: number | null
  actual_amount_cents: number | null
  details: string
  status: "open" | "resolved"
  resolution_note: string | null
  resolved_by_email: string | null
  resolved_at: string | null
  created_at: string
}
