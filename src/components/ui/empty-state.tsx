"use client"

import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  /** Bouton d'action principal (facultatif). */
  action?: React.ReactNode
  className?: string
}

/**
 * État vide illustré : une icône qui flotte lentement, un titre et une
 * consigne concrète. Un tableau vide n'est pas une erreur — c'est une
 * invitation à faire la première action.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-10 text-center",
        className
      )}
    >
      <span className="relative flex size-14 items-center justify-center">
        {/* Halo fixe + icône qui respire : ~3,6 s par cycle, imperceptible
            mais suffisant pour que la zone ne paraisse pas « morte ». */}
        <span className="absolute inset-0 rounded-2xl bg-muted/60" aria-hidden="true" />
        <Icon
          className="float-soft relative size-6 text-muted-foreground"
          aria-hidden="true"
        />
      </span>
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  )
}
