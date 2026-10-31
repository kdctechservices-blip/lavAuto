/**
 * Thème clair / sombre — logique partagée.
 *
 * Ce fichier est la référence côté React. Le script inline de `index.html`
 * duplique volontairement les trois lignes essentielles (clé de stockage,
 * lecture, application de la classe) : il doit s'exécuter **avant** le
 * premier rendu, donc avant tout import de module. Si la clé change ici,
 * elle doit changer là-bas — c'est signalé dans les deux fichiers.
 */

export type Theme = "light" | "dark" | "system"

/** Thème réellement appliqué au document : « system » y est résolu. */
export type ResolvedTheme = "light" | "dark"

/** Clé `localStorage`. ⚠️ Dupliquée dans le script inline de `index.html`. */
export const THEME_STORAGE_KEY = "vite-ui-theme"

export const MEDIA_DARK = "(prefers-color-scheme: dark)"

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system"
}

/**
 * Lit la préférence enregistrée.
 *
 * `localStorage` lève une exception en navigation privée sur certains
 * navigateurs, et en contexte sans stockage : un thème ne justifie pas de
 * faire planter l'application, on retombe sur la valeur par défaut.
 */
export function readStoredTheme(fallback: Theme = "system"): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isTheme(stored) ? stored : fallback
  } catch {
    return fallback
  }
}

export function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Préférence non persistée : l'utilisateur devra rechoisir au prochain
    // chargement. Acceptable, contrairement à une exception non rattrapée.
  }
}

/** Ce que le système d'exploitation demande actuellement. */
export function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "light"
  return window.matchMedia(MEDIA_DARK).matches ? "dark" : "light"
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? systemTheme() : theme
}

/**
 * Couleur de la barre du navigateur (Android Chrome, Safari iOS).
 *
 * Doit rester alignée sur `--background` dans `src/index.css`. Les valeurs
 * sont en hexadécimal : `<meta name="theme-color">` n'accepte pas `oklch()`.
 *
 * Conversion : `oklch(1 0 0)` → #ffffff, `oklch(0.145 0 0)` → #0a0a0a.
 * ⚠️ Également dupliquées dans le script inline de `index.html`.
 */
const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: "#ffffff",
  dark: "#0a0a0a",
}

/**
 * Applique le thème au document.
 *
 * Met aussi à jour `color-scheme`, qui pilote l'apparence native des barres
 * de défilement, des sélecteurs de date et des champs de formulaire — sans
 * lui, un formulaire sombre garde des contrôles blancs.
 */
export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement

  root.classList.remove("light", "dark")
  root.classList.add(resolved)
  root.style.colorScheme = resolved

  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement("meta")
    meta.name = "theme-color"
    document.head.appendChild(meta)
  }
  meta.content = THEME_COLOR[resolved]
}

/** Libellés de l'interface. Un seul endroit pour les trois choix. */
export const THEME_OPTIONS: ReadonlyArray<{
  value: Theme
  label: string
  description: string
}> = [
  {
    value: "light",
    label: "Clair",
    description: "Lisible en plein soleil, sur le poste de lavage.",
  },
  {
    value: "dark",
    label: "Sombre",
    description: "Moins fatigant le soir et en caisse fermée.",
  },
  {
    value: "system",
    label: "Système",
    description: "Suit le réglage de votre téléphone ou de votre ordinateur.",
  },
]
