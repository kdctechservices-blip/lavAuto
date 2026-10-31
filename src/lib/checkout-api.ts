/**
 * Souscription côté client — types partagés avec `server/checkout.ts`.
 *
 * Le client n'envoie pas d'argent par l'application : il ouvre une intention
 * de paiement, paie par mobile money en citant la référence reçue, puis
 * déclare sa transaction. La déclaration n'active rien — elle met la demande
 * en tête de la file de l'éditeur.
 */

import { apiFetch, apiErrorMessage } from "@/lib/api"

export type IntentStatus = "pending" | "paid" | "failed" | "expired" | "cancelled"

export interface PaymentIntent {
  reference: string
  plan_code: string
  months: number
  amount_cents: number
  provider: string
  status: IntentStatus
  declared_reference: string | null
  declared_at: string | null
  created_at: string
  settled_at: string | null
}

export interface CheckoutResponse {
  reference: string
  plan_code: string
  plan_name: string
  months: number
  amount_cents: number
  provider: string
  expires_in_hours: number
  instructions: {
    merchant_number: string | null
    merchant_name: string | null
    channels: string[]
    message: string
  } | null
}

/** Durées proposées. Au-delà de 12 mois, l'engagement inquiète plus qu'il ne rassure. */
export const DURATIONS = [
  { months: 1, label: "1 mois" },
  { months: 3, label: "3 mois" },
  { months: 6, label: "6 mois" },
  { months: 12, label: "12 mois" },
] as const

export function formatFcfa(cents: number): string {
  return `${Math.round(cents / 100).toLocaleString("fr-CI")} F`
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await apiErrorMessage(response))
  return (await response.json()) as T
}

export async function openCheckout(planCode: string, months: number): Promise<CheckoutResponse> {
  return readJson<CheckoutResponse>(
    await apiFetch("/api/v1/subscription/checkout", {
      method: "POST",
      body: JSON.stringify({ plan_code: planCode, months }),
    }),
  )
}

export async function declarePayment(
  reference: string,
  input: { transaction_reference: string; paid_with?: string },
): Promise<void> {
  await readJson(
    await apiFetch(`/api/v1/subscription/checkout/${reference}/declare`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  )
}
