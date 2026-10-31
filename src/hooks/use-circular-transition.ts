"use client"

import { useRef, useCallback } from "react"
import { useTheme } from "@/hooks/use-theme"

interface CircularTransitionHook {
  startTransition: (
    coords: { x: number; y: number },
    callback: () => void
  ) => void
  toggleTheme: (event: React.MouseEvent) => void
  isTransitioning: () => boolean
}

export function useCircularTransition(): CircularTransitionHook {
  const { theme, setTheme } = useTheme()
  const isTransitioningRef = useRef(false)

  const startTransition = useCallback(
    (coords: { x: number; y: number }, callback: () => void) => {
      if (isTransitioningRef.current) return

      isTransitioningRef.current = true

      // Set CSS variables for the circular reveal animation - exactly like tweakcn
      const x = (coords.x / window.innerWidth) * 100
      const y = (coords.y / window.innerHeight) * 100

      // Set the CSS variables on document element
      document.documentElement.style.setProperty("--x", `${x}%`)
      document.documentElement.style.setProperty("--y", `${y}%`)

      // Mouvement réduit demandé : on change le thème sans la révélation.
      // Un cercle qui balaie tout l'écran est exactement le type d'animation
      // plein cadre que ce réglage vise à supprimer.
      const prefersReducedMotion =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches

      if (!prefersReducedMotion && "startViewTransition" in document) {
        // Marque la transition pour que le CSS applique la révélation
        // circulaire au lieu du fondu utilisé par les changements de page.
        document.documentElement.setAttribute("data-theme-transition", "")

        const transition = (
          document as Document & {
            startViewTransition: (callback: () => void) => {
              finished: Promise<void>
            }
          }
        ).startViewTransition(() => {
          callback()
        })

        transition.finished.finally(() => {
          document.documentElement.removeAttribute("data-theme-transition")
          isTransitioningRef.current = false
        })
      } else {
        // Fallback for browsers without View Transitions API
        callback()
        setTimeout(() => {
          isTransitioningRef.current = false
        }, 400)
      }
    },
    []
  )

  const toggleTheme = useCallback(
    (event: React.MouseEvent) => {
      // Get precise click coordinates - use clientX/clientY directly like tweakcn
      const coords = {
        x: event.clientX,
        y: event.clientY,
      }

      startTransition(coords, () => {
        // « system » doit basculer vers l'inverse de ce qui est réellement
        // affiché, sinon le premier clic ne change rien à l'écran.
        const isDark =
          theme === "dark" ||
          (theme === "system" &&
            typeof window !== "undefined" &&
            window.matchMedia("(prefers-color-scheme: dark)").matches)
        setTheme(isDark ? "light" : "dark")
      })
    },
    [theme, setTheme, startTransition]
  )

  const isTransitioning = useCallback(() => {
    return isTransitioningRef.current
  }, [])

  return {
    startTransition,
    toggleTheme,
    isTransitioning,
  }
}
