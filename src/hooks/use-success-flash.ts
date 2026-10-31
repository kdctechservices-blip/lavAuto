"use client"

import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Petit drapeau « ça vient de réussir », remis à zéro tout seul.
 *
 * Sert à afficher la coche verte d'un bouton après un enregistrement :
 * l'utilisateur voit que l'action a abouti sans avoir à lire le toast.
 */
export function useSuccessFlash(duration = 1600): [boolean, () => void] {
  const [active, setActive] = useState(false)
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const trigger = useCallback(() => {
    if (timeout.current) clearTimeout(timeout.current)
    setActive(true)
    timeout.current = setTimeout(() => setActive(false), duration)
  }, [duration])

  useEffect(() => {
    return () => {
      if (timeout.current) clearTimeout(timeout.current)
    }
  }, [])

  return [active, trigger]
}
