"use client"

import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

interface TableSkeletonProps {
  rows?: number
  cols?: number
  /** Libellé annoncé aux lecteurs d'écran pendant le chargement. */
  label?: string
  className?: string
}

/**
 * Squelette de tableau : affiche la *forme* du contenu attendu plutôt qu'un
 * texte « Chargement… ». L'écran paraît nettement plus rapide, surtout sur
 * les connexions mobiles.
 */
export function TableSkeleton({
  rows = 5,
  cols = 5,
  label = "Chargement des données",
  className,
}: TableSkeletonProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className={cn("overflow-hidden rounded-lg border", className)}
    >
      <div className="flex items-center gap-4 border-b bg-muted/40 px-4 py-3">
        {Array.from({ length: cols }).map((_, col) => (
          <Skeleton
            key={col}
            className={cn("h-3", col === 0 ? "w-32 flex-1" : "w-20")}
          />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, row) => (
        <div
          key={row}
          className="row-in flex items-center gap-4 border-b px-4 py-3.5 last:border-0"
          style={{ "--row": row } as React.CSSProperties}
        >
          {Array.from({ length: cols }).map((_, col) => (
            <Skeleton
              key={col}
              className={cn("h-4", col === 0 ? "w-40 flex-1" : "w-16")}
              style={{ animationDelay: `${(row * cols + col) * 45}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Squelette de cartes (grilles de KPI, listes de cartes). */
export function CardsSkeleton({
  count = 4,
  className,
}: {
  count?: number
  className?: string
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Chargement des indicateurs"
      className={cn("grid gap-4 sm:grid-cols-2 xl:grid-cols-4", className)}
    >
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="row-in rounded-2xl border bg-card p-5"
          style={{ "--row": index } as React.CSSProperties}
        >
          <div className="flex items-start justify-between gap-3">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="size-10 rounded-xl" />
          </div>
          <Skeleton className="mt-4 h-7 w-32" />
          <Skeleton className="mt-3 h-3 w-full" />
        </div>
      ))}
    </div>
  )
}
