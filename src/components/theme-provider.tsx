"use client"

import * as React from "react"
import { ThemeProviderContext } from "@/contexts/theme-context"
import {
  MEDIA_DARK,
  applyTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  type ResolvedTheme,
  type Theme,
} from "@/lib/theme"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
}

// Pas de prop `storageKey` : la clé doit rester identique à celle du script
// inline de `index.html`, qu'aucune prop React ne peut atteindre. La rendre
// configurable donnerait un réglage sans effet — et un éclair blanc au
// chargement pour qui s'en servirait.

export function ThemeProvider({
  children,
  defaultTheme = "system",
  ...props
}: ThemeProviderProps) {
  // Lu une seule fois : le script inline de `index.html` a déjà posé la bonne
  // classe sur `<html>`, on se contente de reprendre la même source.
  const [theme, setThemeState] = React.useState<Theme>(() =>
    readStoredTheme(defaultTheme)
  )
  const [systemResolved, setSystemResolved] = React.useState<ResolvedTheme>(
    () => resolveTheme("system")
  )

  const resolvedTheme: ResolvedTheme =
    theme === "system" ? systemResolved : theme

  // Suit le système d'exploitation en continu. Sans cet abonnement, un
  // téléphone qui bascule en sombre au coucher du soleil laissait
  // l'application en clair jusqu'au rechargement suivant.
  React.useEffect(() => {
    if (!window.matchMedia) return
    const query = window.matchMedia(MEDIA_DARK)
    const onChange = (event: MediaQueryListEvent) => {
      setSystemResolved(event.matches ? "dark" : "light")
    }
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])

  React.useEffect(() => {
    applyTheme(resolvedTheme)
  }, [resolvedTheme])

  // Un même compte ouvert dans deux onglets doit rester cohérent : l'événement
  // `storage` n'est émis que vers les *autres* onglets, donc pas de boucle.
  React.useEffect(() => {
    const onStorage = () => setThemeState(readStoredTheme(defaultTheme))
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [defaultTheme])

  const setTheme = React.useCallback((next: Theme) => {
    storeTheme(next)
    setThemeState(next)
  }, [])

  const value = React.useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme]
  )

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}
