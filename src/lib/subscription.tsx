"use client"

import * as React from "react"
import { apiFetch } from "@/lib/api"

/**
 * Essai gratuit de 14 jours — état partagé par toute l'application.
 *
 * Le serveur reste la source de vérité (`GET /api/v1/subscription`) ; le client
 * se contente d'égrener les secondes à partir de la durée restante renvoyée,
 * ce qui évite tout décalage d'horloge entre le téléphone et le serveur.
 */

export type Capability =
  | "washes.create"
  | "washes.cancel"
  | "payments.manage"
  | "expenses.manage"
  | "cash.manage"
  | "catalog.manage"
  | "team.manage"
  | "reports.export"
  | "reports.advanced"
  | "reports.consolidated"
  | "audit.read"
  | "sites.multiple"
  | "stock.manage"
  | "team.tracking"

export type SubscriptionStatus =
  | "none"
  | "pending"
  | "trialing"
  | "active"
  | "expired"
  | "cancelled"

export interface SubscriptionState {
  status: SubscriptionStatus
  stored_status: string
  plan_code: string | null
  plan_name: string | null
  plan_price_cents: number
  is_trial: boolean
  is_expired: boolean
  trial_days: number
  trial_started_at: string | null
  trial_ends_at: string | null
  ms_remaining: number
  days_remaining: number
  progress: number
  read_only: boolean
  report_window_days: number | null
  capabilities: Record<Capability, boolean>
  restricted: Capability[]
  server_time: string
  warning_days: number
  capability_labels: Record<Capability, string>
  limits: { sites: PlanLimitState }
  downgrade_grace_days: number
}

/**
 * Limite numérique d'un forfait. Un dépassement n'efface jamais de données :
 * il bloque la création et, le délai de grâce écoulé, met l'excédent en
 * lecture seule. Voir `server/plan-limits.ts`.
 */
export interface PlanLimitState {
  /** `null` = illimité. */
  limit: number | null
  active_count: number
  remaining: number | null
  over_limit: boolean
  excess: number
  grace_ends_at: string | null
  grace_days_remaining: number
  /** Vrai quand le délai est écoulé : l'excédent est passé en lecture seule. */
  enforced: boolean
  creation_blocked: boolean
}

interface SubscriptionContextValue {
  state: SubscriptionState | null
  loading: boolean
  /** Millisecondes restantes, rafraîchies chaque seconde. */
  msRemaining: number
  isTrial: boolean
  isExpired: boolean
  readOnly: boolean
  /** Essai en cours et échéance proche (≤ 3 jours). */
  isEndingSoon: boolean
  can: (capability: Capability) => boolean
  refresh: () => Promise<void>
}

const SubscriptionContext = React.createContext<SubscriptionContextValue | null>(null)

/** Découpe une durée en jours / heures / minutes / secondes. */
export function splitDuration(ms: number) {
  const safe = Math.max(0, ms)
  return {
    days: Math.floor(safe / 86_400_000),
    hours: Math.floor((safe % 86_400_000) / 3_600_000),
    minutes: Math.floor((safe % 3_600_000) / 60_000),
    seconds: Math.floor((safe % 60_000) / 1000),
  }
}

/** « 11 j 04 h 20 min » — formulation courte pour les bandeaux. */
export function formatRemaining(ms: number): string {
  const { days, hours, minutes } = splitDuration(ms)
  if (ms <= 0) return "terminé"
  if (days > 0) return `${days} j ${String(hours).padStart(2, "0")} h`
  if (hours > 0) return `${hours} h ${String(minutes).padStart(2, "0")} min`
  return `${minutes} min`
}

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<SubscriptionState | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [msRemaining, setMsRemaining] = React.useState(0)
  // Échéance recalculée à partir de l'horloge locale au moment de la réponse :
  // le décompte reste juste même si le téléphone est mal réglé.
  const deadlineRef = React.useRef<number | null>(null)
  const stateRef = React.useRef<SubscriptionState | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      const response = await apiFetch("/api/v1/subscription")
      if (!response.ok) {
        setState(null)
        return
      }
      const data = (await response.json()) as SubscriptionState
      deadlineRef.current = data.is_trial ? Date.now() + data.ms_remaining : null
      stateRef.current = data
      setState(data)
      setMsRemaining(data.ms_remaining)
    } catch {
      // Hors ligne ou session expirée : on n'impose aucune restriction côté
      // client, le serveur reste de toute façon le garde-fou.
      setState(null)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    // Chargement initial dans une fonction asynchrone : les mises à jour
    // d'état sont différées, l'effet ne déclenche pas de rendu en cascade.
    ;(async () => {
      await refresh()
    })()
  }, [refresh])

  // Décompte local, une fois par seconde.
  React.useEffect(() => {
    const id = window.setInterval(() => {
      const deadline = deadlineRef.current
      if (deadline == null) return
      const left = Math.max(0, deadline - Date.now())
      setMsRemaining(left)
      // L'essai vient de se terminer sous les yeux de l'utilisateur :
      // on resynchronise pour basculer proprement en lecture seule.
      if (left === 0 && stateRef.current?.is_trial) {
        deadlineRef.current = null
        void refresh()
      }
    }, 1000)
    return () => window.clearInterval(id)
  }, [refresh])

  // Resynchronisation au retour sur l'onglet et toutes les 5 minutes.
  React.useEffect(() => {
    const onFocus = () => void refresh()
    window.addEventListener("focus", onFocus)
    const id = window.setInterval(() => void refresh(), 300_000)
    return () => {
      window.removeEventListener("focus", onFocus)
      window.clearInterval(id)
    }
  }, [refresh])

  const value = React.useMemo<SubscriptionContextValue>(() => {
    const readOnly = state?.read_only ?? false
    return {
      state,
      loading,
      msRemaining,
      isTrial: state?.is_trial ?? false,
      isExpired: state?.is_expired ?? false,
      readOnly,
      isEndingSoon:
        (state?.is_trial ?? false) &&
        msRemaining <= (state?.warning_days ?? 3) * 86_400_000,
      can: (capability: Capability) => state?.capabilities?.[capability] ?? true,
      refresh,
    }
  }, [state, loading, msRemaining, refresh])

  return (
    <SubscriptionContext.Provider value={value}>{children}</SubscriptionContext.Provider>
  )
}

/**
 * État de l'abonnement. Hors `SubscriptionProvider` (pages publiques), renvoie
 * un état neutre : rien n'est restreint côté interface.
 */
export function useSubscription(): SubscriptionContextValue {
  const context = React.useContext(SubscriptionContext)
  if (context) return context
  return {
    state: null,
    loading: false,
    msRemaining: 0,
    isTrial: false,
    isExpired: false,
    readOnly: false,
    isEndingSoon: false,
    can: () => true,
    refresh: async () => {},
  }
}

export interface CapabilityCheck {
  allowed: boolean
  /** Explication à afficher **visiblement** près de l'action désactivée. */
  reason: string | null
  readOnly: boolean
  /** L'abonnement est-il encore en cours de chargement ? Voir `AccessCheck`. */
  loading: boolean
}

/** Droit d'exécuter une action, avec le motif du refus. */
export function useCapability(capability: Capability): CapabilityCheck {
  const { state, can, readOnly, loading } = useSubscription()
  const allowed = can(capability)
  if (allowed) return { allowed: true, reason: null, readOnly, loading: false }

  // Tant que l'abonnement n'est pas chargé, on ne sait pas ce que le forfait
  // permet. Annoncer « non inclus dans votre forfait » à ce moment-là serait
  // une explication inventée.
  if (loading) return { allowed: false, reason: null, readOnly, loading: true }

  if (!state) {
    return {
      allowed: false,
      readOnly,
      loading: false,
      reason: "Votre abonnement n'a pas pu être chargé. Rechargez la page ou reconnectez-vous.",
    }
  }

  const label = state.capability_labels?.[capability] ?? "Cette action"
  return {
    allowed: false,
    readOnly,
    loading: false,
    reason: readOnly
      ? `${label} : votre essai gratuit de ${state.trial_days ?? 14} jours est terminé. Choisissez un forfait pour réactiver les enregistrements.`
      : `${label} n’est pas inclus dans votre forfait ${state.plan_name ?? "actuel"}.`,
  }
}
