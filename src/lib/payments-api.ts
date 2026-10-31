/** Types et libellés partagés pour les encaissements. */

export const PAYMENT_METHODS = [
  "cash",
  "orange_money",
  "mtn_momo",
  "moov_money",
  "wave",
  "other",
] as const

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Espèces",
  orange_money: "Orange Money",
  mtn_momo: "MTN MoMo",
  moov_money: "Moov Money",
  wave: "Wave",
  other: "Autre",
}

/** Canaux dont la réception doit être confirmée (aucun argent en caisse). */
export const MOBILE_MONEY_METHODS: PaymentMethod[] = [
  "orange_money",
  "mtn_momo",
  "moov_money",
  "wave",
]

export function paymentMethodLabel(method: string): string {
  return PAYMENT_METHOD_LABELS[method as PaymentMethod] ?? method
}

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "À confirmer",
  verified: "Confirmé",
  failed: "Échoué",
  refunded: "Remboursé",
}

export const WASH_PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: "Non réglé",
  partial: "Partiellement réglé",
  paid: "Réglé",
}

export interface PaymentRow {
  id: string
  wash_id: string
  wash_reference: string
  site_id: string | null
  wash_total_cents: number
  method: string
  amount_cents: number
  status: string
  reference: string | null
  created_at: string
}

export interface PaymentTotalsRow {
  method: string
  payment_count: number
  amount_cents: number
  verified_cents: number
  pending_cents: number
}

export interface PaymentsResponse {
  payments: PaymentRow[]
  totals_by_method: PaymentTotalsRow[]
}
