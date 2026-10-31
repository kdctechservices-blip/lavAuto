"use client"

import { useRef } from "react"
import { useInView, useReducedMotion } from "framer-motion"
import { useCountUp } from "@/hooks/use-count-up"
import { cn } from "@/lib/utils"

interface CountUpOnViewProps {
  value: number
  format?: (value: number) => string
  duration?: number
  className?: string
}

/**
 * Compteur qui démarre quand le chiffre entre dans l'écran, une seule fois.
 *
 * Sur une page vitrine, le mouvement sert d'accroche : l'œil est attiré par le
 * chiffre qui se compose, pas par une animation décorative.
 */
export function CountUpOnView({
  value,
  format,
  duration = 900,
  className,
}: CountUpOnViewProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, amount: 0.6 })
  const prefersReduced = useReducedMotion() === true
  const animated = useCountUp(inView ? value : 0, duration)
  const displayed = prefersReduced || !inView ? value : animated

  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {format ? format(displayed) : displayed.toLocaleString("fr-FR")}
    </span>
  )
}
