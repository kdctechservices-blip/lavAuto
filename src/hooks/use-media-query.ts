"use client"

import { useCallback, useSyncExternalStore } from "react"

/**
 * S'abonne à une media query sans effet ni état : `useSyncExternalStore`
 * renvoie déjà la bonne valeur au premier rendu (pas de clignotement).
 *
 * Sert notamment à désactiver le parallax en dessous de 768 px, où il coûte
 * cher en performance sans rien apporter.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {}
      const list = window.matchMedia(query)
      list.addEventListener("change", onChange)
      return () => list.removeEventListener("change", onChange)
    },
    [query]
  )

  const getSnapshot = useCallback(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false
    return window.matchMedia(query).matches
  }, [query])

  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/** Vrai à partir de 768 px (point de rupture `md` de Tailwind). */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 768px)")
}
