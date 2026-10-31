import type { NextFunction, Request, Response } from "express"
import type { Pool } from "pg"
import { getPool } from "./db.ts"
import { HttpError } from "./auth.ts"
import { env } from "./env.ts"

// ---------------------------------------------------------------------------
// Essai gratuit de 14 jours
//
// Règle produit :
//   • Les trois forfaits sont payants et ouvrent chacun 14 jours d'essai à
//     partir de la validation de l'onboarding, sans carte bancaire.
//   • L'essai donne **exactement les fonctionnalités du forfait choisi**, pas
//     davantage. Débloquer tout pendant l'essai rendrait les trois forfaits
//     indiscernables au moment précis où le client choisit, et transformerait
//     le quinzième jour en perte de fonctionnalités. Pour essayer autre chose,
//     on change de forfait pendant l'essai — le décompte, lui, ne repart pas.
//   • À l'échéance → l'organisation bascule en **lecture seule** : les données
//     restent consultables, mais plus aucune écriture n'est acceptée et les
//     rapports sont limités aux 7 derniers jours.
//   • Un forfait payant validé (`active`) n'est jamais restreint.
//
// La vérité est côté serveur : l'interface se contente de refléter cet état.
// ---------------------------------------------------------------------------

/**
 * Durée de l'essai, en jours. 14 par défaut, réglable par `TRIAL_DAYS` pour
 * accorder davantage à un prospect important sans toucher au code. La valeur
 * est lue une fois au démarrage : les essais déjà ouverts gardent l'échéance
 * calculée à leur inscription, un changement ne raccourcit donc jamais
 * rétroactivement l'essai de quelqu'un.
 */
export const TRIAL_DAYS = env.TRIAL_DAYS
export const TRIAL_DURATION_MS = TRIAL_DAYS * 86_400_000
/** Profondeur d'historique encore consultable une fois l'essai terminé. */
export const EXPIRED_REPORT_WINDOW_DAYS = 7
/** Seuil d'alerte : à partir d'ici, l'interface insiste sur l'échéance. */
export const TRIAL_WARNING_DAYS = 3

export type SubscriptionStatus =
  | "none"
  | "pending"
  | "trialing"
  | "active"
  | "expired"
  | "cancelled"

/** Actions soumises à l'abonnement. Le client utilise les mêmes clés. */
export const CAPABILITIES = [
  "washes.create",
  "washes.cancel",
  "payments.manage",
  "expenses.manage",
  "cash.manage",
  "catalog.manage",
  "team.manage",
  "reports.export",
  "reports.advanced",
  "reports.consolidated",
  "audit.read",
  "sites.multiple",
  "stock.manage",
  "team.tracking",
] as const

export type Capability = (typeof CAPABILITIES)[number]

/** Libellés affichés dans les messages d'erreur et l'interface. */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  "washes.create": "Enregistrer un lavage",
  "washes.cancel": "Annuler un lavage",
  "payments.manage": "Encaisser et confirmer un paiement",
  "expenses.manage": "Gérer les dépenses",
  "cash.manage": "Gérer la caisse",
  "catalog.manage": "Modifier le catalogue (prestations, catégories, sites)",
  "team.manage": "Gérer l’équipe",
  "reports.export": "Exporter les rapports",
  "reports.advanced": "Rapports avancés",
  "reports.consolidated": "Rapports consolidés et vue multi-stations",
  "audit.read": "Historique des opérations et traçabilité",
  "sites.multiple": "Gestion multi-stations",
  "stock.manage": "Suivi du stock de consommables",
  "team.tracking": "Présences, affectations et rendement des laveurs",
}

/** Capacités coupées dès que l'organisation passe en lecture seule. */
const WRITE_CAPABILITIES: Capability[] = [
  "washes.create",
  "washes.cancel",
  "payments.manage",
  "expenses.manage",
  "cash.manage",
  "catalog.manage",
  "team.manage",
]

export interface SubscriptionState {
  /** Statut effectif : un essai échu vaut « expired », même si la base dit « trialing ». */
  status: SubscriptionStatus
  /** Statut tel qu'il est stocké (utile pour le diagnostic). */
  stored_status: string
  plan_code: string | null
  plan_name: string | null
  plan_price_cents: number
  is_trial: boolean
  is_expired: boolean
  trial_days: number
  trial_started_at: string | null
  trial_ends_at: string | null
  /** Millisecondes restantes (0 si terminé). Le client fait le décompte localement. */
  ms_remaining: number
  days_remaining: number
  /** Part de l'essai déjà consommée, de 0 à 1 (pour la barre de progression). */
  progress: number
  /** Vrai quand l'essai est terminé : plus aucune écriture n'est acceptée. */
  read_only: boolean
  /** Fenêtre d'historique autorisée, en jours (null = illimitée). */
  report_window_days: number | null
  capabilities: Record<Capability, boolean>
  /** Capacités refusées, pour l'affichage « ce qui est bloqué ». */
  restricted: Capability[]
  /** Horodatage serveur : le client cale son décompte dessus. */
  server_time: string
}

export interface SubscriptionInput {
  status?: string | null
  current_period_end?: Date | string | null
  plan_code?: string | null
  plan_name?: string | null
  plan_price_cents?: number | null
  plan_features?: Record<string, unknown> | string[] | null
  now?: Date
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function featureEnabled(
  features: SubscriptionInput["plan_features"],
  key: Capability,
): boolean {
  if (!features) return false
  if (Array.isArray(features)) return features.includes(key)
  return features[key] === true
}

/**
 * Calcule l'état d'abonnement d'une organisation.
 *
 * Fonction pure (aucun accès base) : c'est elle qui est couverte par les tests.
 */
export function computeSubscriptionState(input: SubscriptionInput): SubscriptionState {
  const now = input.now ?? new Date()
  const storedStatus = (input.status ?? "none").toLowerCase()
  const periodEnd = toDate(input.current_period_end)
  const priceCents = Number(input.plan_price_cents ?? 0)

  const isTrialRecord = storedStatus === "trialing"
  const trialEnded = isTrialRecord && periodEnd != null && periodEnd.getTime() <= now.getTime()

  let status: SubscriptionStatus
  if (trialEnded || storedStatus === "expired") status = "expired"
  else if (isTrialRecord) status = "trialing"
  else if (storedStatus === "active") status = "active"
  else if (storedStatus === "pending") status = "pending"
  else if (storedStatus === "cancelled" || storedStatus === "canceled") status = "cancelled"
  else status = "none"

  const isTrial = status === "trialing"
  const isExpired = status === "expired"
  // Lecture seule : essai terminé, ou abonnement annulé. Un forfait payant
  // « en attente de validation » reste utilisable (le paiement est hors ligne).
  const readOnly = isExpired || status === "cancelled"

  const msRemaining =
    isTrial && periodEnd ? Math.max(0, periodEnd.getTime() - now.getTime()) : 0
  const trialStart = periodEnd ? new Date(periodEnd.getTime() - TRIAL_DURATION_MS) : null
  const elapsed = trialStart ? now.getTime() - trialStart.getTime() : 0
  const progress = isTrial
    ? Math.min(1, Math.max(0, elapsed / TRIAL_DURATION_MS))
    : isExpired
      ? 1
      : 0

  const capabilities = {} as Record<Capability, boolean>
  for (const capability of CAPABILITIES) {
    if (WRITE_CAPABILITIES.includes(capability)) {
      capabilities[capability] = !readOnly
      continue
    }
    // Fonctionnalités de forfait : l'essai ne change rien, il donne à voir le
    // forfait choisi tel qu'il sera facturé. Ce que l'on essaie est ce que
    // l'on achète.
    capabilities[capability] = !readOnly && featureEnabled(input.plan_features, capability)
  }

  return {
    status,
    stored_status: storedStatus,
    plan_code: input.plan_code ?? null,
    plan_name: input.plan_name ?? null,
    plan_price_cents: priceCents,
    is_trial: isTrial,
    is_expired: isExpired,
    trial_days: TRIAL_DAYS,
    trial_started_at: isTrial || isExpired ? (trialStart?.toISOString() ?? null) : null,
    trial_ends_at: isTrial || isExpired ? (periodEnd?.toISOString() ?? null) : null,
    ms_remaining: msRemaining,
    days_remaining: Math.ceil(msRemaining / 86_400_000),
    progress,
    read_only: readOnly,
    report_window_days: readOnly ? EXPIRED_REPORT_WINDOW_DAYS : null,
    capabilities,
    restricted: CAPABILITIES.filter((capability) => !capabilities[capability]),
    server_time: now.toISOString(),
  }
}

/**
 * Ramène une période de rapport dans la fenêtre autorisée.
 * On tronque au lieu de refuser : l'écran reste utilisable, simplement réduit.
 */
export function clampReportRange(
  range: { from: string; to: string },
  windowDays: number | null,
  today = new Date(),
): { from: string; to: string; clamped: boolean } {
  if (!windowDays) return { ...range, clamped: false }
  const earliest = new Date(today.getTime() - (windowDays - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10)
  if (range.from >= earliest) return { ...range, clamped: false }
  return { from: earliest, to: range.to < earliest ? earliest : range.to, clamped: true }
}

// ---------------------------------------------------------------------------
// Accès base + middlewares Express
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      subscription?: SubscriptionState
    }
  }
}

interface CacheEntry {
  state: SubscriptionState
  loadedAt: number
}

/** Cache court : évite une requête SQL par appel d'API pendant le décompte. */
const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 10_000

export function invalidateSubscriptionCache(organizationId?: string) {
  if (organizationId) cache.delete(organizationId)
  else cache.clear()
}

/**
 * Charge l'état d'abonnement d'une organisation et matérialise l'expiration :
 * un essai échu est écrit en base une seule fois (`status='expired'`).
 */
export async function loadSubscriptionState(
  pool: Pool,
  organizationId: string,
  options: { fresh?: boolean } = {},
): Promise<SubscriptionState> {
  const cached = cache.get(organizationId)
  if (!options.fresh && cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    // Le décompte est recalculé à chaque lecture pour rester juste à la seconde.
    if (!(cached.state.is_trial && cached.state.ms_remaining <= CACHE_TTL_MS)) {
      return cached.state
    }
  }

  const q = await pool.query(
    `SELECT s.status, s.current_period_end, p.code AS plan_code, p.name AS plan_name,
            p.price_cents AS plan_price_cents, p.features AS plan_features
     FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     WHERE s.organization_id = $1::uuid`,
    [organizationId],
  )

  const row = q.rows[0]
  const state = computeSubscriptionState({
    status: row?.status ?? "none",
    current_period_end: row?.current_period_end ?? null,
    plan_code: row?.plan_code ?? null,
    plan_name: row?.plan_name ?? null,
    plan_price_cents: row?.plan_price_cents ?? 0,
    plan_features: row?.plan_features ?? null,
  })

  // Matérialisation de l'expiration : le statut stocké suit l'état réel.
  if (state.is_expired && state.stored_status === "trialing") {
    await pool.query(
      "UPDATE subscriptions SET status='expired', updated_at=now() WHERE organization_id=$1::uuid AND status='trialing'",
      [organizationId],
    )
  }

  cache.set(organizationId, { state, loadedAt: Date.now() })
  return state
}

/** Attache l'état d'abonnement à la requête (après requireTenantContext). */
export async function attachSubscription(req: Request, _res: Response, next: NextFunction) {
  try {
    const pool = getPool()
    if (!pool || !req.tenant) return next()
    req.subscription = await loadSubscriptionState(pool, req.tenant.organizationId)
    next()
  } catch (error) {
    next(error)
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
/** Routes qui restent ouvertes en lecture seule (sortie de l'impasse). */
const ALWAYS_ALLOWED = [/^\/subscription/, /^\/onboarding/]

/**
 * Bloque toute écriture quand l'organisation est en lecture seule.
 *
 * Filet de sécurité global : même si un bouton oublie sa garde côté interface,
 * l'API répond 402 avec un message explicite et la date de fin d'essai.
 */
export function blockWritesWhenReadOnly(req: Request, _res: Response, next: NextFunction) {
  const state = req.subscription
  if (!state?.read_only) return next()
  if (SAFE_METHODS.has(req.method)) return next()
  if (ALWAYS_ALLOWED.some((pattern) => pattern.test(req.path))) return next()

  next(
    new HttpError(
      402,
      "trial_expired",
      state.status === "cancelled"
        ? "Votre abonnement est résilié : l’espace est en lecture seule. Choisissez un forfait pour reprendre les enregistrements."
        : `Votre essai gratuit de ${TRIAL_DAYS} jours est terminé. Votre espace reste consultable, mais les nouveaux enregistrements nécessitent un forfait.`,
    ),
  )
}

/** Garde explicite pour une capacité donnée (fonctionnalités de forfait). */
export function requireCapability(capability: Capability) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const state = req.subscription
    if (!state || state.capabilities[capability]) return next()
    next(
      new HttpError(
        402,
        state.read_only ? "trial_expired" : "plan_upgrade_required",
        state.read_only
          ? `« ${CAPABILITY_LABELS[capability]} » n’est plus disponible : votre essai gratuit est terminé.`
          : `« ${CAPABILITY_LABELS[capability]} » n’est pas inclus dans votre forfait actuel.`,
      ),
    )
  }
}
