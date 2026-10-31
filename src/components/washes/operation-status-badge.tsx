"use client"

import { Badge } from "@/components/ui/badge"
import {
  OPERATION_STATUS_ACTIONS,
  OPERATION_STATUS_LABELS,
  nextOperationStatus,
  normaliseOperationStatus,
  type OperationStatus,
} from "@/lib/wash-operation-status"
import { cn } from "cn"

const TONES: Record<OperationStatus, string> = {
  // « En attente » est rouge : une voiture qui attend se voit de loin, et
  // c'est la couleur que l'ecran de la station attend deja.
  pending: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  in_progress: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  overtime: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
  completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
}

export interface OperationStatusBadgeProps {
  /** L'avancement courant. Une valeur inconnue est traitee comme « termine ». */
  status: string | null | undefined
  /** Le lavage est annule : l'avancement n'a plus de sens. */
  cancelled?: boolean
  /** L'utilisateur a-t-il le droit de faire avancer l'operation ? */
  canAdvance?: boolean
  /** Un changement est-il en cours sur ce lavage ? */
  busy?: boolean
  onAdvance?: (next: OperationStatus) => void
  className?: string
}

/**
 * Pastille d'avancement, cliquable quand un cran peut être franchi.
 *
 * Rendue en `button` seulement lorsqu'il y a quelque chose a faire : une
 * pastille qui ne fait rien ne doit pas ressembler a un bouton. Un lavage
 * terminé est un état, pas une action.
 */
export function OperationStatusBadge({
  status,
  cancelled = false,
  canAdvance = false,
  busy = false,
  onAdvance,
  className,
}: OperationStatusBadgeProps) {
  if (cancelled) {
    return (
      <Badge
        variant="destructive"
        className={cn("border border-destructive/30", className)}
      >
        Annulé
      </Badge>
    )
  }

  const courant = normaliseOperationStatus(status)
  const suivant = nextOperationStatus(courant)
  const cliquable = Boolean(suivant) && canAdvance && !busy && Boolean(onAdvance)

  if (!cliquable) {
    return (
      <Badge
        className={cn("border", TONES[courant], className)}
        title={
          suivant && canAdvance
            ? "Vous n’avez pas le droit de faire avancer cet avancement."
            : undefined
        }
      >
        {OPERATION_STATUS_LABELS[courant]}
      </Badge>
    )
  }

  const action = OPERATION_STATUS_ACTIONS[courant as Exclude<OperationStatus, "completed">]

  return (
    <Badge
      render={
        <button
          type="button"
          onClick={() => onAdvance?.(suivant!)}
          aria-label={`${action} (${OPERATION_STATUS_LABELS[courant]})`}
          title={action}
        />
      }
      className={cn(
        "cursor-pointer border transition-colors hover:brightness-95 focus-visible:ring-[3px] focus-visible:ring-ring/50",
        TONES[courant],
        className,
      )}
    >
      {OPERATION_STATUS_LABELS[courant]}
    </Badge>
  )
}
