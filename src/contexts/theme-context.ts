import * as React from "react"
import type { ResolvedTheme, Theme } from "@/lib/theme"

export type ThemeProviderState = {
  /** Préférence choisie, « system » compris. */
  theme: Theme
  /** Thème réellement affiché : « system » est résolu en clair ou sombre. */
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

const initialState: ThemeProviderState = {
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => null,
}

export const ThemeProviderContext =
  React.createContext<ThemeProviderState>(initialState)
