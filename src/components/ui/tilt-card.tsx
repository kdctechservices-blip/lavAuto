"use client"

import { useRef } from "react"
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from "framer-motion"
import { useIsDesktop } from "@/hooks/use-media-query"
import { cn } from "@/lib/utils"

interface TiltCardProps {
  children: React.ReactNode
  className?: string
  /** Inclinaison maximale en degrés (6° par défaut : perceptible, jamais clinquant). */
  maxTilt?: number
}

/**
 * Carte qui s'incline légèrement vers le curseur.
 *
 * Volontairement limitée à 6° : au-delà, l'effet attire l'attention sur
 * lui-même au lieu du contenu. Inactif au tactile (< 768 px) et quand
 * l'utilisateur demande un mouvement réduit.
 */
export function TiltCard({ children, className, maxTilt = 6 }: TiltCardProps) {
  const ref = useRef<HTMLDivElement>(null)
  const prefersReduced = useReducedMotion() === true
  const isDesktop = useIsDesktop()
  const enabled = isDesktop && !prefersReduced

  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const springConfig = { stiffness: 220, damping: 22, mass: 0.4 }
  const rotateX = useSpring(useTransform(y, [-0.5, 0.5], [maxTilt, -maxTilt]), springConfig)
  const rotateY = useSpring(useTransform(x, [-0.5, 0.5], [-maxTilt, maxTilt]), springConfig)

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!enabled || !ref.current) return
    const bounds = ref.current.getBoundingClientRect()
    x.set((event.clientX - bounds.left) / bounds.width - 0.5)
    y.set((event.clientY - bounds.top) / bounds.height - 0.5)
  }

  function reset() {
    x.set(0)
    y.set(0)
  }

  return (
    <motion.div
      ref={ref}
      onPointerMove={handlePointerMove}
      onPointerLeave={reset}
      style={
        enabled
          ? { rotateX, rotateY, transformPerspective: 900, transformStyle: "preserve-3d" }
          : undefined
      }
      className={cn("h-full", className)}
    >
      {children}
    </motion.div>
  )
}
