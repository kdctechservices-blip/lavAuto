"use client"

import * as React from "react"
import { apiFetch } from "@/lib/api"
import { useCapability, type Capability } from "@/lib/subscription"

/**
 * Permissions de l'utilisateur connecté (RBAC).
 *
 * Deux systèmes cohabitent volontairement, et ils ne répondent pas à la même
 * question :
 *   • les **permissions** (ce fichier) disent ce que le RÔLE autorise ;
 *   • les **capacités** (`subscription.tsx`) disent ce que le FORFAIT autorise.
 *
 * `useAccess()` combine les deux pour que les écrans n'aient qu'un seul appel à
 * faire. Dans tous les cas, ce qui est affiché ici ne protège rien : le serveur
 * revérifie chaque permission à chaque requête.
 */

export type Permission =
  | "dashboard:read"
  | "wash:create"
  | "wash:read"
  | "wash:update"
  | "wash:status"
  | "wash:cancel"
  | "payment:create"
  | "payment:read"
  | "payment:verify"
  | "payment:cancel"
  | "cash_session:read"
  | "cash_session:manage"
  | "service:read"
  | "service:manage"
  | "worker:read"
  | "worker:create"
  | "worker:update"
  | "worker:delete"
  | "expense:read"
  | "expense:create"
  | "expense:manage"
  | "stock:read"
  | "stock:manage"
  | "stock:move"
  | "supplier:manage"
  | "purchase:manage"
  | "attendance:read"
  | "attendance:manage"
  | "attendance:correct"
  | "report:operational"
  | "report:financial"
  | "report:export"
  | "audit:read"
  | "user:manage"
  | "settings:manage"
  | "subscription:manage"
  | "data:export"

export type Role = "owner" | "manager" | "cashier" | "washer"

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Propriétaire",
  manager: "Gérant",
  cashier: "Caissier",
  washer: "Agent de lavage",
}

export interface PermissionState {
  user_id: string
  organization_id: string
  role: Role
  role_label: string
  permissions: Permission[]
  permission_labels: Record<Permission, string>
}

interface PermissionContextValue {
  state: PermissionState | null
  loading: boolean
  /** L'utilisateur a-t-il cette permission ? Refus par défaut. */
  can: (permission: Permission) => boolean
  refresh: () => Promise<void>
}

const PermissionContext = React.createContext<PermissionContextValue>({
  state: null,
  loading: true,
  can: () => false,
  refresh: async () => {},
})

export function PermissionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<PermissionState | null>(null)
  const [loading, setLoading] = React.useState(true)

  const refresh = React.useCallback(async () => {
    try {
      const response = await apiFetch("/api/v1/me/permissions")
      if (!response.ok) {
        setState(null)
        return
      }
      setState((await response.json()) as PermissionState)
    } catch {
      setState(null)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    // IIFE : la règle react-hooks interdit d'appeler directement une fonction
    // qui modifie l'état dans le corps d'un effet.
    ;(async () => {
      await refresh()
    })()
  }, [refresh])

  const can = React.useCallback(
    (permission: Permission) => state?.permissions.includes(permission) ?? false,
    [state],
  )

  const value = React.useMemo(
    () => ({ state, loading, can, refresh }),
    [state, loading, can, refresh],
  )

  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>
}

export function usePermissions() {
  return React.useContext(PermissionContext)
}

export interface AccessCheck {
  allowed: boolean
  /** Motif du refus, à afficher **visiblement** près de l'action désactivée. */
  reason: string | null
  /**
   * Les droits sont-ils encore en cours de chargement ?
   *
   * Distinguer ce cas du refus est indispensable : tant que la réponse de
   * `/me/permissions` n'est pas arrivée, on ne sait pas si l'action est
   * permise. Afficher un cadenas pendant ce laps de temps fait passer une
   * attente pour une interdiction, et c'est ce qui faisait croire à un
   * « Nouveau lavage » refusé alors qu'il était simplement pas encore prêt.
   */
  loading: boolean
}

/** Vérifie une permission de rôle seule. */
export function usePermission(permission: Permission): AccessCheck {
  const { state, can, loading } = usePermissions()
  if (loading) return { allowed: false, reason: null, loading: true }
  if (can(permission)) return { allowed: true, reason: null, loading: false }

  // Chargement terminé mais aucun état : la requête a échoué. Accuser le rôle
  // serait un mensonge — et « votre rôle (votre rôle) » était la phrase que
  // cette branche produisait réellement.
  if (!state) {
    return {
      allowed: false,
      loading: false,
      reason: "Vos droits n'ont pas pu être chargés. Rechargez la page ou reconnectez-vous.",
    }
  }

  const label = state.permission_labels?.[permission]
  const roleLabel = ROLE_LABELS[state.role] ?? state.role_label
  return {
    allowed: false,
    loading: false,
    reason: label
      ? `${label} : action réservée. Votre rôle (${roleLabel}) ne dispose pas de ce droit.`
      : `Action non autorisée pour votre rôle (${roleLabel}).`,
  }
}

/**
 * Vérifie le rôle **et** le forfait d'un seul appel.
 * Le rôle prime : inutile de proposer de passer au forfait supérieur à
 * quelqu'un qui n'aurait de toute façon pas le droit d'agir.
 */
export function useAccess(permission: Permission, capability?: Capability): AccessCheck {
  const permissionCheck = usePermission(permission)
  // Capacité neutre quand aucune n'est demandée : le hook doit rester appelé
  // inconditionnellement.
  const capabilityCheck = useCapability(capability ?? "washes.create")

  if (!permissionCheck.allowed) return permissionCheck
  if (!capability) return { allowed: true, reason: null, loading: false }
  return {
    allowed: capabilityCheck.allowed,
    reason: capabilityCheck.reason,
    loading: capabilityCheck.loading,
  }
}
