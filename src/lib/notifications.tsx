"use client"

import * as React from "react"

import { apiFetch, useApi } from "@/lib/api"
import type { AuditEntry, AuditListResponse } from "@/lib/audit-api"
import type { QueuedMutation } from "@/lib/offline-queue"
import { subscribeToQueue } from "@/lib/offline-sync"
import { usePermissions } from "@/lib/permissions"
import { useCapability, useSubscription } from "@/lib/subscription"

/**
 * Centre de notifications et journal d'activité récent.
 *
 * Principe : **aucune notification inventée**. Tout ce qui s'affiche provient
 * d'un fait réel et vérifiable — un essai qui se termine, une vente qui attend
 * le réseau, un remboursement enregistré dans l'historique. Une alerte qui ne
 * se rattache à rien apprend à ignorer le centre de notifications.
 *
 * Les acquittements (« lu ») sont conservés sur l'appareil : un caissier qui a
 * vu l'alerte ne la revoit pas à chaque rechargement. Une alerte qui change de
 * nature (1 vente en attente → 3) reste la même alerte : elle se met à jour
 * au lieu de générer une seconde ligne.
 */

export type NotificationLevel = "info" | "success" | "warning" | "critical"

export interface AppNotification {
  id: string
  title: string
  description: string
  /** ISO 8601. */
  at: string
  level: NotificationLevel
  /** Écran à ouvrir pour traiter l'alerte. */
  href?: string
  /** Action conseillée, formulée comme une consigne. */
  hint?: string
}

/**
 * Notification telle que la base la conserve (`GET /api/v1/notifications`).
 *
 * Ces lignes ne sont pas recalculées à l'affichage : elles ont été écrites au
 * moment du fait (un lavage terminé, par exemple) et survivent au rechargement,
 * au changement d'appareil et à la fermeture de l'onglet. Les alertes locales
 * ci-dessus décrivent l'état *maintenant* ; celles-ci racontent ce qui s'est
 * passé, et l'écran a besoin des deux.
 */
interface ServerNotification {
  id: string
  type: string
  title: string
  message: string
  site_id: string | null
  entity_type: string | null
  entity_id: string | null
  read_at: string | null
  created_at: string
}

interface ServerNotificationList {
  notifications: ServerNotification[]
  unread_count: number
}

/** Préfixe qui distingue une notification persistée d'une alerte calculée. */
const SERVER_PREFIX = "server:"

const SERVER_LEVELS: Record<string, NotificationLevel> = {
  WASH_COMPLETED: "success",
}

/** Écran à ouvrir pour traiter une notification persistée. */
function serverHref(item: ServerNotification): string | undefined {
  if (item.entity_type === "wash" && item.entity_id) return `/washes/${item.entity_id}`
  if (item.entity_type === "support_request" && item.entity_id) return `/support?request=${item.entity_id}`
  return undefined
}

const READ_KEY = "washpilot:notifications:read"

function readIds(): string[] {
  try {
    const raw = window.localStorage.getItem(READ_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function writeIds(ids: string[]) {
  try {
    // On ne garde que les 200 derniers identifiants : la liste ne doit pas
    // grossir indéfiniment dans un stockage de navigateur.
    window.localStorage.setItem(READ_KEY, JSON.stringify(ids.slice(-200)))
  } catch {
    // Sans stockage, l'acquittement vaut pour la session.
  }
}

interface NotificationContextValue {
  notifications: AppNotification[]
  unreadCount: number
  markRead: (id: string) => void
  markAllRead: () => void
  /** Cette alerte a-t-elle déjà été acquittée sur cet appareil ? */
  isRead: (id: string) => boolean
  /** Journal d'activité récent, du plus récent au plus ancien. */
  activity: AuditEntry[]
  activityLoading: boolean
  activityError: string | null
  /** L'utilisateur peut-il lire l'historique ? Sinon, l'onglet est masqué. */
  canReadActivity: boolean
  numberOfPending: number
  numberOfFailed: number
}

const NotificationContext = React.createContext<NotificationContextValue | null>(null)

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { state } = useSubscription()
  const { can, loading: permissionsLoading } = usePermissions()
  // Deux verrous distincts : le rôle (`audit:read`) et le forfait
  // (`audit.read`). Sans le second, un rôle autorisé sur un forfait qui
  // n'inclut pas l'historique recevrait un 403 à chaque ouverture du centre.
  const auditCapability = useCapability("audit.read")
  const canReadActivity = can("audit:read") && auditCapability.allowed

  const [queue, setQueue] = React.useState<QueuedMutation[]>([])
  const [read, setRead] = React.useState<string[]>(() =>
    typeof window === "undefined" ? [] : readIds(),
  )

  const { data: audit, loading: auditLoading, error: auditError } =
    useApi<AuditListResponse>(canReadActivity ? "/api/v1/audit-logs?limit=8&offset=0" : "")

  // Les notifications écrites en base par les opérations (lavage terminé…).
  // Le droit est celui des lavages : un membre qui peut les consulter peut voir
  // ce qui les concerne, et personne d'autre. La lecture échouée ne casse rien :
  // le centre continue d'afficher ce qu'il sait calculer.
  const canReadServer = can("wash:read")
  const { data: serverFeed } = useApi<ServerNotificationList>(
    canReadServer ? "/api/v1/notifications?limit=15" : "",
  )

  React.useEffect(() => subscribeToQueue(setQueue), [])

  const pending = queue.filter((item) => item.status === "pending")
  const failed = queue.filter((item) => item.status === "failed")

  const activity = React.useMemo<AuditEntry[]>(() => audit?.entries ?? [], [audit])

  const notifications = React.useMemo<AppNotification[]>(() => {
    const list: AppNotification[] = []
    const now = new Date().toISOString()

    if (state?.read_only) {
      list.push({
        id: "subscription-read-only",
        title: "Compte en lecture seule",
        description:
          "L'essai gratuit est terminé : les nouveaux lavages sont bloqués jusqu'au choix d'un forfait.",
        at: now,
        level: "critical",
        href: "/settings/billing",
        hint: "Choisissez un forfait pour reprendre les enregistrements.",
      })
    } else if (state?.is_trial && (state.days_remaining ?? 0) <= (state.warning_days ?? 3)) {
      const days = Math.max(0, state.days_remaining)
      list.push({
        id: "subscription-trial-ending",
        title: days <= 1 ? "Essai gratuit : dernier jour" : `Essai gratuit : ${days} jours restants`,
        description:
          "Après l'échéance, l'application passe en lecture seule : les lavages ne pourront plus être enregistrés.",
        at: state.trial_ends_at ?? now,
        level: "warning",
        href: "/settings/billing",
        hint: "Choisissez un forfait avant la fin de l'essai.",
      })
    }

    if (failed.length > 0) {
      list.push({
        id: "offline-failed",
        title:
          failed.length === 1
            ? "1 opération refusée à l'envoi"
            : `${failed.length} opérations refusées à l'envoi`,
        description:
          "Ces opérations enregistrées hors ligne n'ont pas été acceptées par le serveur. Elles restent sur cet appareil et doivent être traitées à la main.",
        at: new Date(Math.max(...failed.map((item) => item.createdAt))).toISOString(),
        level: "critical",
        href: "/washes",
        hint: "Ouvrez le bandeau hors ligne pour relire le motif et réessayer.",
      })
    }

    if (pending.length > 0) {
      list.push({
        id: "offline-pending",
        title:
          pending.length === 1
            ? "1 opération attend le réseau"
            : `${pending.length} opérations attendent le réseau`,
        description:
          "Elles sont conservées sur cet appareil et partiront automatiquement dès que la connexion revient.",
        at: new Date(Math.max(...pending.map((item) => item.createdAt))).toISOString(),
        level: "info",
        hint: "Vous pouvez continuer à travailler : rien n'est perdu.",
      })
    }

    // Une entrée d'historique sensible mérite une alerte, pas les informations
    // de routine — sinon le centre devient un second journal.
    for (const entry of activity.slice(0, 4)) {
      if (entry.severity === "info") continue
      list.push({
        id: `activity-${entry.id}`,
        title: entry.action_label,
        description: `${entry.entity_label} · ${entry.actor_name}`,
        at: entry.created_at,
        level: entry.severity === "critical" ? "critical" : "warning",
        href: "/history",
        hint: "Vérifiez le détail dans l'historique.",
      })
    }

    // Notifications persistées : elles gardent leur date réelle, donc une alerte
    // de la veille n'apparaît pas comme si elle venait d'arriver.
    for (const item of serverFeed?.notifications ?? []) {
      list.push({
        id: `${SERVER_PREFIX}${item.id}`,
        title: item.title,
        description: item.message,
        at: item.created_at,
        level: SERVER_LEVELS[item.type] ?? "info",
        href: serverHref(item),
      })
    }

    return list.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
  }, [state, pending, failed, activity, serverFeed])

  // Une notification lue sur un autre appareil ne redevient pas non lue ici :
  // la date de lecture en base fait foi pour les lignes persistées.
  const serverRead = React.useMemo(
    () =>
      new Set(
        (serverFeed?.notifications ?? [])
          .filter((item) => item.read_at)
          .map((item) => `${SERVER_PREFIX}${item.id}`),
      ),
    [serverFeed],
  )

  const isRead = React.useCallback(
    (id: string) => read.includes(id) || serverRead.has(id),
    [read, serverRead],
  )

  const unreadCount = notifications.filter((item) => !isRead(item.id)).length

  const markRead = React.useCallback((id: string) => {
    setRead((current) => {
      if (current.includes(id)) return current
      const next = [...current, id]
      writeIds(next)
      return next
    })
    // Les lignes persistées se marquent aussi en base : sans cela, l'alerte
    // reviendrait sur le téléphone du collègue, et sur le même appareil après
    // une réinstallation. L'échec est sans conséquence — l'acquittement local
    // a déjà eu lieu.
    if (id.startsWith(SERVER_PREFIX)) {
      const notificationId = id.slice(SERVER_PREFIX.length)
      void apiFetch(`/api/v1/notifications/${encodeURIComponent(notificationId)}/read`, {
        method: "POST",
      }).catch(() => {})
    }
  }, [])

  const markAllRead = React.useCallback(() => {
    setRead((current) => {
      const next = [...new Set([...current, ...notifications.map((item) => item.id)])]
      writeIds(next)
      return next
    })
    if ((serverFeed?.unread_count ?? 0) > 0) {
      void apiFetch("/api/v1/notifications/read-all", { method: "POST" }).catch(() => {})
    }
  }, [notifications, serverFeed])

  const value = React.useMemo<NotificationContextValue>(
    () => ({
      notifications,
      unreadCount,
      markRead,
      markAllRead,
      isRead,
      activity,
      activityLoading: canReadActivity && auditLoading,
      activityError: canReadActivity ? auditError : null,
      canReadActivity: !permissionsLoading && canReadActivity,
      numberOfPending: pending.length,
      numberOfFailed: failed.length,
    }),
    [
      notifications,
      unreadCount,
      read,
      isRead,
      markRead,
      markAllRead,
      activity,
      canReadActivity,
      auditLoading,
      auditError,
      permissionsLoading,
      pending.length,
      failed.length,
    ],
  )

  return (
    <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
  )
}

/** Hors fournisseur : un centre vide plutôt qu'une erreur de montage. */
export function useNotifications(): NotificationContextValue {
  const context = React.useContext(NotificationContext)
  if (context) return context
  return {
    notifications: [],
    unreadCount: 0,
    markRead: () => {},
    markAllRead: () => {},
    isRead: () => false,
    activity: [],
    activityLoading: false,
    activityError: null,
    canReadActivity: false,
    numberOfPending: 0,
    numberOfFailed: 0,
  }
}
