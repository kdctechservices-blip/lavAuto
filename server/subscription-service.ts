/**
 * Activation d'un abonnement — point de passage unique.
 *
 * Ce module existe pour une seule raison : **il ne doit jamais y avoir deux
 * façons d'activer un forfait.**
 *
 * Trois déclencheurs sont prévus, et ils convergent tous ici :
 *
 *   1. l'éditeur valide à la main dans le back-office (`server/admin.ts`) ;
 *   2. un webhook d'agrégateur confirme un paiement (`server/payments-webhook.ts`) ;
 *   3. un rattrapage quotidien réinterroge un paiement resté en attente.
 *
 * Si chacun écrivait sa propre requête SQL, le jour où l'un corrige un défaut
 * — les jours payés perdus lors d'un renouvellement anticipé, le
 * `plan_changed_at` oublié qui supprime le délai de grâce — les deux autres
 * garderaient le bug. C'est la panne classique des systèmes d'abonnement :
 * deux chemins d'activation qui divergent lentement.
 *
 * Passer du manuel à l'automatique devient alors un changement de
 * déclencheur, pas une réécriture.
 */

import type { Pool, PoolClient } from "pg"
import { HttpError } from "./http.ts"
import { invalidateSubscriptionCache } from "./entitlements.ts"
import type { RevenueChannel } from "./revenue.ts"

type Queryable = Pick<Pool | PoolClient, "query">

/** D'où vient l'activation. Journalisé : on doit pouvoir auditer la source. */
export type ActivationSource = "platform_admin" | "payment_webhook" | "reconciliation"

export interface ActivateSubscriptionInput {
  organizationId: string
  planCode: string
  /** Nombre de mois achetés. Borné par l'appelant (36 au back-office). */
  months: number
  source: ActivationSource
  /** Référence du paiement : transaction de l'agrégateur, ou saisie à la main. */
  paymentReference?: string | null
  /** Acteur humain, s'il y en a un. `null` pour un webhook. */
  actorUserId?: string | null
  note?: string | null
  /** Métadonnées supplémentaires à conserver dans le journal du client. */
  extra?: Record<string, unknown>
  /**
   * Canal par lequel l'argent est arrivé. Détermine le compte de trésorerie
   * débité dans le journal comptable (caisse, banque ou monnaie
   * électronique) : sans lui, l'export mettrait du Wave en caisse.
   */
  channel?: RevenueChannel
  /** Opérateur de console à l'origine du geste, s'il y en a un. */
  operatorEmail?: string | null
  /** Intention de paiement d'origine, quand l'activation vient du parcours client. */
  paymentIntentId?: string | null
  /**
   * Montant réellement encaissé, en centimes. Par défaut `prix du forfait ×
   * mois`. À renseigner quand le client a payé autre chose : remise
   * commerciale, arrondi, ou tarif négocié. Le registre doit refléter la
   * banque, pas le tarif affiché.
   */
  amountCents?: number
  now?: Date
}

export interface ActivateSubscriptionResult {
  organizationId: string
  planCode: string
  planName: string
  priceCents: number
  periodEnd: string
  months: number
  /** Vrai si l'activation a prolongé une période déjà payée. */
  renewed: boolean
}

/**
 * Active (ou renouvelle) un forfait payant et journalise l'opération dans
 * l'historique **du client**.
 *
 * L'appelant reste responsable de l'autorisation : ce module ne sait pas qui
 * demande, et c'est voulu — un webhook n'a pas de session.
 */
export async function activateSubscription(
  pool: Queryable,
  input: ActivateSubscriptionInput,
): Promise<ActivateSubscriptionResult> {
  const now = input.now ?? new Date()

  const planQ = await pool.query(
    "SELECT id, code, name, price_cents FROM plans WHERE code = $1",
    [input.planCode],
  )
  if (!planQ.rowCount) throw new HttpError(404, "plan_not_found", "Forfait introuvable.")
  const plan = planQ.rows[0] as { id: string; code: string; name: string; price_cents: number }

  const orgQ = await pool.query("SELECT id FROM organizations WHERE id = $1::uuid", [
    input.organizationId,
  ])
  if (!orgQ.rowCount) throw new HttpError(404, "organization_not_found", "Station introuvable.")

  // L'échéance court à partir d'aujourd'hui, ou de l'échéance en cours si elle
  // est encore devant : un renouvellement anticipé ne doit pas faire perdre
  // les jours déjà payés.
  const currentQ = await pool.query(
    "SELECT current_period_end, status FROM subscriptions WHERE organization_id = $1::uuid",
    [input.organizationId],
  )
  const current = currentQ.rows[0] as
    | { current_period_end: string | null; status: string }
    | undefined
  const existingEnd = current?.current_period_end ? new Date(current.current_period_end) : null
  const renewed =
    current?.status === "active" && existingEnd !== null && existingEnd.getTime() > now.getTime()
  const base = renewed && existingEnd ? existingEnd : now

  const periodEnd = new Date(base)
  periodEnd.setMonth(periodEnd.getMonth() + input.months)

  // `plan_changed_at` conditionne le délai de grâce à la rétrogradation
  // (`server/plan-limits.ts`) : l'oublier priverait le client de ses 14 jours
  // pour rentrer dans les limites du nouveau forfait.
  await pool.query(
    `INSERT INTO subscriptions(organization_id, plan_id, status, current_period_end, plan_changed_at)
     VALUES($1::uuid, $2::uuid, 'active', $3::timestamptz, now())
     ON CONFLICT (organization_id) DO UPDATE
       SET plan_id = EXCLUDED.plan_id,
           status = 'active',
           current_period_end = EXCLUDED.current_period_end,
           plan_changed_at = CASE
             WHEN subscriptions.plan_id IS DISTINCT FROM EXCLUDED.plan_id THEN now()
             ELSE subscriptions.plan_changed_at
           END,
           updated_at = now()`,
    [input.organizationId, plan.id, periodEnd.toISOString()],
  )

  await pool.query(
    `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES($1::uuid, $2::uuid, 'subscription.activated', 'subscription', $3::text, $4::jsonb)`,
    [
      input.organizationId,
      input.actorUserId ?? null,
      plan.id,
      JSON.stringify({
        ...(input.extra ?? {}),
        by: input.source === "platform_admin" ? "platform_admin" : input.source,
        source: input.source,
        plan_code: plan.code,
        plan_name: plan.name,
        price_cents: plan.price_cents,
        months: input.months,
        period_end: periodEnd.toISOString(),
        payment_reference: input.paymentReference ?? null,
        note: input.note ?? null,
        renewed,
      }),
    ],
  )

  // Le registre des encaissements. Il est écrit ici, et nulle part ailleurs :
  // c'est ce qui garantit qu'aucune activation — parcours client, saisie
  // console, futur webhook — ne produise de l'argent invisible au chiffre
  // d'affaires. Le nom de la station est recopié car la ligne doit rester
  // lisible après la suppression de celle-ci.
  const amountCents = input.amountCents ?? plan.price_cents * input.months
  const nameQ = await pool.query("SELECT name FROM organizations WHERE id = $1::uuid", [
    input.organizationId,
  ])
  await pool.query(
    `INSERT INTO subscription_payments(
       organization_id, organization_name, plan_code, plan_name, amount_cents, months,
       period_start, period_end, channel, payment_reference, payment_intent_id,
       source, operator_email, actor_user_id, note, occurred_at)
     VALUES($1::uuid, $2, $3, $4, $5::bigint, $6::int,
            $7::timestamptz, $8::timestamptz, $9, $10, $11::uuid,
            $12, $13, $14::uuid, $15, $16::timestamptz)`,
    [
      input.organizationId,
      (nameQ.rows[0] as { name: string } | undefined)?.name ?? "Station supprimée",
      plan.code,
      plan.name,
      amountCents,
      input.months,
      base.toISOString(),
      periodEnd.toISOString(),
      input.channel ?? "other",
      input.paymentReference ?? null,
      input.paymentIntentId ?? null,
      input.source,
      input.operatorEmail ?? null,
      input.actorUserId ?? null,
      input.note ?? null,
      now.toISOString(),
    ],
  )

  // Une nouvelle période s'ouvre : les relances d'échéance de la précédente
  // n'ont plus de sens et doivent pouvoir repartir. Sans cet effacement, un
  // client ne recevrait qu'une seule fois dans sa vie l'avertissement J-7 —
  // et le renouvellement suivant passerait à la trappe. Les relances d'essai
  // (`trial_%`) sont volontairement conservées : elles, ne se répètent pas.
  await pool.query(
    "DELETE FROM subscription_reminders WHERE organization_id = $1::uuid AND kind LIKE 'renewal_%'",
    [input.organizationId],
  )

  // Le cache d'entitlements vit 10 s : sans cette invalidation, le client
  // continuerait de voir « essai expiré » après avoir payé.
  invalidateSubscriptionCache(input.organizationId)

  return {
    organizationId: input.organizationId,
    planCode: plan.code,
    planName: plan.name,
    priceCents: plan.price_cents,
    periodEnd: periodEnd.toISOString(),
    months: input.months,
    renewed,
  }
}
