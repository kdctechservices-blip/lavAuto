"use client"

import * as React from "react"
import { Info } from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * Explication d'une métrique, au plus près de son libellé.
 *
 * Un tableau de bord qui affiche « Taux de complétion » sans dire ce qui est
 * compté oblige le gérant à deviner. L'infobulle est accessible : déclencheur
 * focusable, texte relié par `aria-describedby`, et le même contenu reste
 * lisible au clavier (Échap ferme).
 */
export function InfoTooltip({
  label,
  children,
  side = "top",
  className,
}: {
  /** Nom de la métrique, utilisé pour nommer le bouton aux lecteurs d'écran. */
  label: string
  children: React.ReactNode
  side?: "top" | "bottom" | "left" | "right"
  className?: string
}) {
  return (
    <TooltipProvider delay={150}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`En savoir plus : ${label}`}
              className={cn(
                "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                className,
              )}
            />
          }
        >
          <Info className="size-3.5" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent side={side} className="max-w-72 text-left leading-relaxed">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** Libellé + infobulle, pour les en-têtes de KPI et les tableaux. */
export function MetricLabel({
  label,
  explanation,
  className,
}: {
  label: string
  explanation: React.ReactNode
  className?: string
}) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span>{label}</span>
      <InfoTooltip label={label}>{explanation}</InfoTooltip>
    </span>
  )
}
