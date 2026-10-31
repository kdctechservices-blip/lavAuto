"use client"

import { Link } from "react-router-dom"
import { ArrowRight, History, ShieldAlert, TriangleAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import {
  AUDIT_SEVERITY_LABELS,
  AUDIT_SEVERITY_STYLES,
  type AuditEntry,
} from "@/lib/audit-api"
import { formatDateTime, formatRelative } from "@/lib/format"
import { useNotifications } from "@/lib/notifications"
import { cn } from "@/lib/utils"

function iconFor(entry: AuditEntry) {
  if (entry.severity === "critical") return ShieldAlert
  if (entry.severity === "warning") return TriangleAlert
  return History
}

/**
 * Journal d'activité récent.
 *
 * Il ne raconte pas une histoire inventée : chaque ligne vient de
 * `/api/v1/audit`, la même source que la page Historique. Un écran de tableau
 * de bord qui « résume » l'activité sans elle finit toujours par afficher des
 * chiffres que personne ne peut vérifier.
 */
export function ActivityFeed({
  limit = 6,
  className,
}: {
  limit?: number
  className?: string
}) {
  const { activity, activityLoading, activityError, canReadActivity } = useNotifications()
  const entries = activity.slice(0, limit)

  if (!canReadActivity) {
    return (
      <div className={cn("rounded-2xl border bg-card p-4 text-sm text-muted-foreground", className)}>
        Le journal d’activité est réservé aux rôles autorisés à consulter
        l’historique. Demandez à un gérant de vous y donner accès.
      </div>
    )
  }

  if (activityLoading) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Chargement de l’activité récente"
        className={cn("divide-y rounded-2xl border bg-card", className)}
      >
        {Array.from({ length: Math.min(limit, 4) }).map((_, index) => (
          <div key={index} className="flex items-center gap-3 p-3.5">
            <Skeleton className="size-8 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
    )
  }

  if (activityError) {
    return (
      <div className={cn("rounded-2xl border border-destructive/30 bg-destructive/5 p-4", className)}>
        <p className="text-sm font-medium">L’activité n’a pas pu être chargée</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {activityError} Vérifiez votre connexion, puis rouvrez la page Historique —
          les opérations y restent enregistrées, rien n’est perdu.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          render={<Link to="/history" viewTransition />}
        >
          Ouvrir l’historique
        </Button>
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className={cn("rounded-2xl border bg-card", className)}>
        <EmptyState
          icon={History}
          title="Aucune activité enregistrée"
          description="Les lavages, encaissements, dépenses et changements d’accès apparaîtront ici dès la première opération."
          action={
            <Button
              variant="outline"
              size="sm"
              render={<Link to="/washes?new=1" viewTransition />}
            >
              Enregistrer un lavage
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <ul className={cn("divide-y overflow-hidden rounded-2xl border bg-card", className)}>
      {entries.map((entry) => {
        const Icon = iconFor(entry)
        return (
          <li key={entry.id} className="flex items-start gap-3 p-3.5">
            <span
              className={cn(
                "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border",
                AUDIT_SEVERITY_STYLES[entry.severity],
              )}
              aria-hidden="true"
            >
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium">{entry.action_label}</p>
                {entry.severity !== "info" && (
                  <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                    {AUDIT_SEVERITY_LABELS[entry.severity]}
                  </Badge>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {entry.entity_label} · {entry.actor_name}
              </p>
            </div>
            <time
              dateTime={entry.created_at}
              title={formatDateTime(entry.created_at)}
              className="shrink-0 text-xs text-muted-foreground"
            >
              {formatRelative(entry.created_at)}
            </time>
          </li>
        )
      })}
      <li className="bg-muted/30 px-3.5 py-2.5">
        <Link
          to="/history"
          viewTransition
          className="inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          Voir tout l’historique
          <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </li>
    </ul>
  )
}
