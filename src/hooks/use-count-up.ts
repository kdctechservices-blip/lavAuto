"use client"

import { useEffect, useRef, useState } from "react"
import { useReducedMotion } from "framer-motion"

/**
 * Anime un nombre de sa valeur précédente vers sa nouvelle valeur.
 *
 * Réservé aux **affichages en lecture seule** (tableaux de bord, rapports) :
 * on n'anime jamais un montant pendant une saisie ou un comptage de caisse,
 * où le chiffre doit être lisible instantanément.
 *
 * Respecte `prefers-reduced-motion` : la valeur finale est renvoyée telle quelle.
 */
export function useCountUp(target: number, duration = 700): number {
  const prefersReduced = useReducedMotion() === true
  const [value, setValue] = useState(0)
  const fromRef = useRef(0)

  useEffect(() => {
    if (prefersReduced || !Number.isFinite(target)) {
      fromRef.current = target
      return
    }
    const from = fromRef.current
    if (from === target) return

    const start = performance.now()
    let frame = requestAnimationFrame(function tick(now) {
      const progress = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - progress, 4) // easeOutQuart
      setValue(Math.round(from + (target - from) * eased))
      if (progress < 1) {
        frame = requestAnimationFrame(tick)
      } else {
        fromRef.current = target
      }
    })

    return () => cancelAnimationFrame(frame)
  }, [target, duration, prefersReduced])

  return prefersReduced || !Number.isFinite(target) ? target : value
}
