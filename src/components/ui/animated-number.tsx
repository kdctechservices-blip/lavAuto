"use client"

import { cn } from "@/lib/utils"
import { useCountUp } from "@/hooks/use-count-up"

interface AnimatedNumberProps {
  /** Valeur cible (nombre brut : centimes, compteur, pourcentage…). */
  value: number | null | undefined
  /** Mise en forme appliquée à la valeur animée (ex. conversion centimes → FCFA). */
  format?: (value: number) => string
  /** Texte affiché quand la valeur est indisponible. */
  placeholder?: string
  duration?: number
  className?: string
}

/**
 * Chiffre qui « monte » jusqu'à sa valeur. `tabular-nums` évite que la largeur
 * tremble pendant l'animation.
 */
export function AnimatedNumber({
  value,
  format,
  placeholder = "—",
  duration = 700,
  className,
}: AnimatedNumberProps) {
  const target = value == null || !Number.isFinite(value) ? 0 : value
  const animated = useCountUp(target, duration)

  if (value == null || !Number.isFinite(value)) {
    return <span className={className}>{placeholder}</span>
  }

  return (
    <span className={cn("tabular-nums", className)}>
      {format ? format(animated) : animated.toLocaleString("fr-FR")}
    </span>
  )
}
