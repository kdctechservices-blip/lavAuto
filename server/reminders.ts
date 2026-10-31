import type { Pool } from "pg"
import { env } from "./env.ts"
import { runScheduledPurges } from "./organization-deletion.ts"
import { sendMail, trialReminderMessage, renewalReminderMessage } from "./mailer.ts"
import { computeSubscriptionState, TRIAL_WARNING_DAYS, type SubscriptionState } from "./entitlements.ts"
import { runMonitoringAlerts } from "./monitoring-alerts.ts"
import { runScheduledReconciliation } from "./reconciliation.ts"

// ---------------------------------------------------------------------------
// Relances d'échéance d'abonnement
//
// Trois relances au maximum, une seule fois chacune :
//   • trial_j3      — il reste 3 jours ou moins
//   • trial_j1      — il reste 1 jour ou moins
//   • trial_expired — l'essai est terminé, l'espace est en lecture seule
//
// Le planificateur repasse toutes les heures : une station créée à n'importe
// quelle heure reçoit sa relance le bon jour, sans dépendre d'un cron externe.
// ---------------------------------------------------------------------------

export const REMINDER_KINDS = ["trial_j3", "trial_j1", "trial_expired"] as const
export type ReminderKind = (typeof REMINDER_KINDS)[number]

/**
 * Relances d'échéance d'un forfait **payant**.
 *
 * Elles existent parce que le rail mobile money ne permet pas de prélèvement
 * récurrent fiable : il n'y a personne pour débiter le client à sa date
 * anniversaire. Ce courriel est donc le mécanisme de renouvellement lui-même,
 * pas un simple rappel de courtoisie.
 *
 * Contrairement aux relances d'essai, elles se répètent **à chaque période**.
 * `activateSubscription()` les efface donc à chaque activation : une nouvelle
 * période ouverte, les relances de la précédente n'ont plus de sens.
 */
export const RENEWAL_REMINDER_KINDS = [
  "renewal_j7",
  "renewal_j3",
  "renewal_j1",
  "renewal_overdue",
] as const
export type RenewalReminderKind = (typeof RENEWAL_REMINDER_KINDS)[number]

/**
 * Décide la relance de renouvellement à envoyer.
 *
 * Fonction pure, comme `planReminder` : c'est elle que les tests couvrent.
 * `daysToExpiry` est négatif quand l'échéance est dépassée — cas qui compte
 * le plus, puisque c'est là que le revenu se perd.
 */
export function planRenewalReminder(
  daysToExpiry: number,
  alreadySent: readonly string[] = [],
): RenewalReminderKind | null {
  const sent = new Set(alreadySent)

  if (daysToExpiry < 0) return sent.has("renewal_overdue") ? null : "renewal_overdue"
  if (daysToExpiry <= 1) return sent.has("renewal_j1") ? null : "renewal_j1"
  if (daysToExpiry <= 3) return sent.has("renewal_j3") ? null : "renewal_j3"
  if (daysToExpiry <= 7) return sent.has("renewal_j7") ? null : "renewal_j7"
  return null
}

/**
 * Décide la relance à envoyer pour un état d'abonnement donné.
 * Fonction pure : c'est elle qui est couverte par les tests.
 */
export function planReminder(
  state: Pick<SubscriptionState, "is_trial" | "is_expired" | "days_remaining">,
  alreadySent: readonly string[] = [],
): ReminderKind | null {
  const sent = new Set(alreadySent)

  if (state.is_expired) {
    return sent.has("trial_expired") ? null : "trial_expired"
  }
  if (!state.is_trial) return null

  if (state.days_remaining <= 1) {
    return sent.has("trial_j1") ? null : "trial_j1"
  }
  if (state.days_remaining <= TRIAL_WARNING_DAYS) {
    return sent.has("trial_j3") ? null : "trial_j3"
  }
  return null
}

interface ReminderRow {
  organization_id: string
  organization_name: string
  status: string
  current_period_end: Date | string | null
  plan_code: string | null
  plan_name: string | null
  plan_price_cents: number | null
  plan_features: Record<string, unknown> | null
  owner_email: string | null
  owner_first_name: string | null
  sent_kinds: string[] | null
}

export interface ReminderOutcome {
  organization_id: string
  kind: ReminderKind | RenewalReminderKind
  email: string
  delivered: boolean
}

/**
 * Parcourt les organisations en essai (ou dont l'essai vient d'expirer) et
 * envoie la relance qui n'a pas encore été envoyée.
 */
export async function runSubscriptionReminders(
  pool: Pool,
  now = new Date(),
): Promise<ReminderOutcome[]> {
  const q = await pool.query<ReminderRow>(
    `SELECT s.organization_id,
            o.name AS organization_name,
            s.status, s.current_period_end,
            p.code AS plan_code, p.name AS plan_name, p.price_cents AS plan_price_cents,
            p.features AS plan_features,
            owner.email AS owner_email, owner.first_name AS owner_first_name,
            (SELECT array_agg(r.kind) FROM subscription_reminders r
              WHERE r.organization_id = s.organization_id) AS sent_kinds
     FROM subscriptions s
     JOIN organizations o ON o.id = s.organization_id
     JOIN plans p ON p.id = s.plan_id
     LEFT JOIN LATERAL (
       SELECT u.email, u.first_name
       FROM organization_members m JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = s.organization_id
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, m.created_at
       LIMIT 1
     ) owner ON true
     WHERE s.status IN ('trialing','expired','active')`,
  )

  const outcomes: ReminderOutcome[] = []

  for (const row of q.rows) {
    const state = computeSubscriptionState({
      status: row.status,
      current_period_end: row.current_period_end,
      plan_code: row.plan_code,
      plan_name: row.plan_name,
      plan_price_cents: row.plan_price_cents,
      plan_features: row.plan_features,
      now,
    })

    if (!row.owner_email) continue
    const sentKinds = row.sent_kinds ?? []

    // Un forfait payant suit une autre logique que l'essai : on ne cherche
    // pas à convaincre, on évite une interruption. Et la relance se répète à
    // chaque période, là où celle de l'essai n'arrive qu'une fois.
    if (state.status === "active") {
      const periodEnd = row.current_period_end ? new Date(row.current_period_end) : null
      if (!periodEnd) continue
      const daysToExpiry = Math.ceil(
        (periodEnd.getTime() - now.getTime()) / 86_400_000,
      )
      const renewalKind = planRenewalReminder(daysToExpiry, sentKinds)
      if (!renewalKind) continue

      const reservedRenewal = await pool.query(
        `INSERT INTO subscription_reminders(organization_id, kind)
         VALUES($1::uuid,$2) ON CONFLICT (organization_id, kind) DO NOTHING RETURNING kind`,
        [row.organization_id, renewalKind],
      )
      if (!reservedRenewal.rowCount) continue

      const renewalDelivered = await sendMail(
        renewalReminderMessage(renewalKind, {
          to: row.owner_email,
          firstName: row.owner_first_name,
          organizationName: row.organization_name,
          planName: row.plan_name ?? "votre forfait",
          periodEnd: periodEnd.toISOString(),
          billingUrl: billingUrl(),
        }),
      )

      await pool
        .query(
          `INSERT INTO audit_logs(organization_id, action, entity_type, entity_id, metadata)
           VALUES($1::uuid,'subscription.reminder_sent','subscription',$1::text,$2::jsonb)`,
          [
            row.organization_id,
            JSON.stringify({
              kind: renewalKind,
              delivered: renewalDelivered,
              to: row.owner_email,
              days_to_expiry: daysToExpiry,
            }),
          ],
        )
        .catch(() => {})

      outcomes.push({
        organization_id: row.organization_id,
        kind: renewalKind,
        email: row.owner_email,
        delivered: renewalDelivered,
      })
      continue
    }

    const kind = planReminder(state, sentKinds)
    if (!kind) continue

    // Réservation d'abord : deux instances du serveur ne peuvent pas envoyer
    // la même relance en double.
    const reserved = await pool.query(
      `INSERT INTO subscription_reminders(organization_id, kind)
       VALUES($1::uuid,$2) ON CONFLICT (organization_id, kind) DO NOTHING RETURNING kind`,
      [row.organization_id, kind],
    )
    if (!reserved.rowCount) continue

    const delivered = await sendMail(
      trialReminderMessage(kind, {
        to: row.owner_email,
        firstName: row.owner_first_name,
        organizationName: row.organization_name,
        daysRemaining: state.days_remaining,
        trialEndsAt: state.trial_ends_at,
        billingUrl: billingUrl(),
      }),
    )

    await pool
      .query(
        `INSERT INTO audit_logs(organization_id, action, entity_type, entity_id, metadata)
         VALUES($1::uuid,'subscription.reminder_sent','subscription',$1::text,$2::jsonb)`,
        [row.organization_id, JSON.stringify({ kind, delivered, to: row.owner_email })],
      )
      .catch(() => {})

    outcomes.push({ organization_id: row.organization_id, kind, email: row.owner_email, delivered })
  }

  return outcomes
}

/**
 * Lien vers la page Forfait, utilisé dans les e-mails.
 * Sans APP_URL, le lien reste relatif : l'e-mail est alors moins exploitable,
 * d'où l'avertissement au démarrage du planificateur.
 */
export function billingUrl(): string {
  const base = env.APP_URL.replace(/\/+$/, "")
  return base ? `${base}/settings/billing` : "/settings/billing"
}

let timer: NodeJS.Timeout | null = null
let schedulerStarted = false
let alertTimer: NodeJS.Timeout | null = null
let alertTickRunning = false

/** Démarre le planificateur horaire (idempotent). */
export function startReminderScheduler(pool: Pool): void {
  if (env.NODE_ENV === "test" || schedulerStarted) return
  schedulerStarted = true

  if (!env.APP_URL) {
    console.warn(
      "[relances] APP_URL n'est pas défini : les liens des e-mails de relance seront relatifs.",
    )
  }

  const intervalMs = env.REMINDERS_INTERVAL_MINUTES * 60_000
  const tick = async () => {
    try {
      if (env.REMINDERS_ENABLED) {
        const outcomes = await runSubscriptionReminders(pool)
        if (outcomes.length) {
          console.info(`[relances] ${outcomes.length} relance(s) d'abonnement traitée(s).`)
        }
      }
    } catch (error) {
      console.error(
        "[relances] Passage échoué :",
        error instanceof Error ? error.message : "erreur inconnue",
      )
    }

    // Rapprochement du relevé distant. Isolé des relances : une indisponibilité
    // de l'agrégateur ne doit empêcher ni les e-mails ni les purges.
    try {
      const result = await runScheduledReconciliation(pool)
      if (result?.status === "success") {
        console.info(`[rapprochement] Lot ${result.batch_id} : ${result.matched_rows} correspondance(s), ${result.discrepancy_rows} écart(s).`)
      } else if (result?.status === "failed") {
        console.error(`[rapprochement] Passage échoué : ${result.error}`)
      }
    } catch (error) {
      console.error("[rapprochement] Passage interrompu :", error instanceof Error ? error.message : "erreur inconnue")
    }

    // Purges arrivées à échéance. Dans le même passage que les relances
    // plutôt que dans un minuteur séparé : deux planificateurs concurrents
    // sur la même base doubleraient le risque sans rien gagner.
    //
    // Enveloppé dans son propre try : une purge qui échoue ne doit pas
    // empêcher les relances du passage suivant.
    try {
      const { purged, failed } = await runScheduledPurges(pool)
      if (purged.length) console.info(`[suppression] ${purged.length} station(s) purgée(s).`)
      for (const failure of failed) {
        console.error(`[suppression] Purge échouée pour ${failure.id} : ${failure.error}`)
      }
    } catch (error) {
      console.error(
        "[suppression] Passage échoué :",
        error instanceof Error ? error.message : "erreur inconnue",
      )
    }
  }

  // Premier passage après 30 s pour ne pas ralentir le démarrage. Le passage
  // exécute aussi rapprochement et purges même si les seuls e-mails sont off.
  const initial = setTimeout(() => void tick(), 30_000)
  initial.unref?.()
  timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()

  // Les alertes ont leur propre cadence : attendre la relance horaire des
  // abonnements rendrait un pic de 5xx visible bien trop tard.
  const alertTick = async () => {
    if (alertTickRunning) return
    alertTickRunning = true
    try {
      const outcomes = await runMonitoringAlerts(pool)
      if (outcomes.length) console.info(`[surveillance] ${outcomes.length} alerte(s) proactive(s) déclenchée(s).`)
    } catch (error) {
      console.error("[surveillance] Passage des alertes échoué :", error instanceof Error ? error.message : "erreur inconnue")
    } finally {
      alertTickRunning = false
    }
  }
  const initialAlerts = setTimeout(() => void alertTick(), 45_000)
  initialAlerts.unref?.()
  alertTimer = setInterval(() => void alertTick(), env.MONITORING_ALERT_INTERVAL_MINUTES * 60_000)
  alertTimer.unref?.()
}

export function stopReminderScheduler(): void {
  schedulerStarted = false
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (alertTimer) {
    clearInterval(alertTimer)
    alertTimer = null
  }
}
