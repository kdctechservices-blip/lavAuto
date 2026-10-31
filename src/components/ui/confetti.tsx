"use client"

import { useMemo } from "react"
import { useReducedMotion } from "framer-motion"
import { cn } from "@/lib/utils"

const COLORS = [
  "var(--color-primary)",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#ec4899",
]

/**
 * Confettis en CSS pur (aucune librairie, ~0 Ko de JS) joués **une seule
 * fois**, 1,4 s maximum, pour célébrer la fin de la configuration.
 *
 * Rien n'est affiché si l'utilisateur a demandé un mouvement réduit.
 */
export function Confetti({
  pieces = 22,
  className,
}: {
  pieces?: number
  className?: string
}) {
  const prefersReduced = useReducedMotion() === true

  // Positions figées au montage : un re-rendu ne relance pas la fête.
  const confetti = useMemo(
    () =>
      Array.from({ length: pieces }).map((_, index) => ({
        left: `${(index / pieces) * 100 + (index % 3) * 2}%`,
        dx: `${(index % 2 === 0 ? 1 : -1) * (12 + (index % 5) * 9)}px`,
        spin: `${(index % 2 === 0 ? 1 : -1) * (180 + (index % 4) * 120)}deg`,
        delay: `${(index % 7) * 60}ms`,
        color: COLORS[index % COLORS.length],
        size: 6 + (index % 3) * 3,
        round: index % 3 === 0,
      })),
    [pieces]
  )

  if (prefersReduced) return null

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        className
      )}
    >
      {confetti.map((piece, index) => (
        <span
          key={index}
          className={cn(
            "confetti-piece absolute top-0 block",
            piece.round ? "rounded-full" : "rounded-[1px]"
          )}
          style={
            {
              left: piece.left,
              width: piece.size,
              height: piece.size * (piece.round ? 1 : 1.6),
              backgroundColor: piece.color,
              "--dx": piece.dx,
              "--spin": piece.spin,
              "--delay": piece.delay,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  )
}
