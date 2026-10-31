/**
 * Historique des opérations — types partagés avec `server/audit-log.ts`.
 *
 * L'historique est volontairement en lecture seule : on ne corrige pas une
 * ligne d'historique, on enregistre l'opération qui corrige. Il n'existe donc
 * ni formulaire ni type d'écriture dans ce fichier.
 */

/** Teinte d'affichage calculée par le serveur à partir de l'action. */
export type AuditSeverity = "info" | "warning" | "critical"

export interface AuditEntry {
  id: string
  /** Code technique, ex. `payment.refunded`. Sert aux filtres. */
  action: string
  /** Libellé français prêt à afficher, ex. « Paiement remboursé ». */
  action_label: string
  entity_type: string
  entity_label: string
  entity_id: string | null
  actor_user_id: string | null
  /** Nom de l'auteur, ou « Système » pour une action automatique. */
  actor_name: string
  severity: AuditSeverity
  /** Détails libres propres à l'action (motif d'un remboursement, écart de caisse…). */
  metadata: Record<string, unknown> | null
  created_at: string
}

export interface AuditListResponse {
  entries: AuditEntry[]
  total: number
  limit: number
  offset: number
}

/** Valeur de filtre réellement présente dans l'historique de l'organisation. */
export interface AuditFilterOption {
  value: string
  label: string
  count?: number
}

export interface AuditFiltersResponse {
  actions: AuditFilterOption[]
  entity_types: AuditFilterOption[]
  actors: AuditFilterOption[]
}

/** Classes de la pastille de sévérité, alignées sur le reste de l'interface. */
export const AUDIT_SEVERITY_STYLES: Record<AuditSeverity, string> = {
  info: "border-border bg-muted/50 text-muted-foreground",
  warning:
    "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100",
  critical:
    "border-destructive/30 bg-destructive/5 text-destructive dark:border-destructive/40",
}

export const AUDIT_SEVERITY_LABELS: Record<AuditSeverity, string> = {
  info: "Information",
  warning: "Vigilance",
  critical: "Sensible",
}

/**
 * Rend un bloc `metadata` lisible sans l'afficher en JSON brut.
 * Les clés connues sont traduites ; les autres sont laissées telles quelles
 * plutôt que masquées — mieux vaut une clé technique qu'une information perdue.
 */
const METADATA_LABELS: Record<string, string> = {
  reason: "Motif",
  amount_cents: "Montant",
  expected_cents: "Attendu",
  counted_cents: "Compté",
  difference_cents: "Écart",
  method: "Moyen de paiement",
  permission: "Droit",
  role: "Rôle",
  status: "Statut",
  granted: "Accordé",
  revoked: "Retiré",
  site_id: "Station",
  plan: "Forfait",
  path: "Adresse demandée",
}

export function metadataLabel(key: string) {
  return METADATA_LABELS[key] ?? key.replace(/_/g, " ")
}

export function metadataValue(key: string, value: unknown) {
  if (value === null || value === undefined) return "—"
  if (typeof value === "boolean") return value ? "oui" : "non"
  if (key.endsWith("_cents") && typeof value === "number") {
    return `${new Intl.NumberFormat("fr-CI").format(Math.round(value / 100))} FCFA`
  }
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}
