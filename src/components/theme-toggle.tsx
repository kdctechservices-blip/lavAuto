"use client"

import { Check, Monitor, MoonStar, Sun } from "lucide-react"
import { motion } from "framer-motion"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useCircularTransition } from "@/hooks/use-circular-transition"
import { useTheme } from "@/hooks/use-theme"
import { SPRING } from "@/lib/motion"
import { THEME_OPTIONS, type Theme } from "@/lib/theme"
import { cn } from "@/lib/utils"

const THEME_ICON: Record<Theme, typeof Sun> = {
  light: Sun,
  dark: MoonStar,
  system: Monitor,
}

/**
 * Bascule rapide clair ↔ sombre.
 *
 * Un seul clic, parce que c'est le geste courant : on passe en sombre le soir
 * et en clair le matin. Le choix « Système » n'a pas sa place ici — il vit
 * dans `ThemeMenu` et dans les réglages, où on le règle une fois pour toutes.
 *
 * La nouvelle interface est révélée par un cercle qui s'ouvre depuis le point
 * cliqué (API View Transitions, repli instantané sinon).
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme } = useTheme()
  const { toggleTheme } = useCircularTransition()
  const isDark = resolvedTheme === "dark"

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      aria-label={isDark ? "Activer le thème clair" : "Activer le thème sombre"}
      title={isDark ? "Thème clair" : "Thème sombre"}
      className={cn("relative overflow-hidden", className)}
    >
      {/* Les deux icônes se croisent en rotation : la sortante part, l'entrante
          arrive. Une seule icône qui change ferait un clignotement. */}
      <Sun
        className={cn(
          "size-4 transition-all duration-300 motion-reduce:transition-none",
          isDark
            ? "-rotate-90 scale-0 opacity-0"
            : "rotate-0 scale-100 opacity-100"
        )}
        aria-hidden="true"
      />
      <MoonStar
        className={cn(
          "absolute size-4 transition-all duration-300 motion-reduce:transition-none",
          isDark
            ? "rotate-0 scale-100 opacity-100"
            : "rotate-90 scale-0 opacity-0"
        )}
        aria-hidden="true"
      />
    </Button>
  )
}

/**
 * Choix complet : Clair / Sombre / Système.
 *
 * Indispensable en complément de la bascule : sans lui, une fois le premier
 * clic donné, « Système » devient inatteignable et l'application cesse
 * définitivement de suivre le réglage du téléphone.
 */
export function ThemeMenu() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  const Icon = THEME_ICON[theme]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Choisir le thème"
            title="Thème"
          />
        }
      >
        <Icon className="size-4" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {/*
          Le groupe n'est pas décoratif : `DropdownMenuLabel` est un
          `Menu.GroupLabel` Base UI, qui enregistre son identifiant auprès du
          groupe parent pour en devenir l'`aria-labelledby`. Hors d'un groupe,
          le contexte manque et le menu lève une erreur à l'ouverture.
          Les options sont dans le même groupe que le libellé, pour qu'un
          lecteur d'écran annonce bien « Apparence » avant de les énumérer.
        */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Apparence</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {THEME_OPTIONS.map((option) => {
            const OptionIcon = THEME_ICON[option.value]
            const selected = theme === option.value
            return (
              <DropdownMenuItem
                key={option.value}
                onClick={() => setTheme(option.value)}
                className="gap-2"
              >
                <OptionIcon className="size-4 shrink-0" aria-hidden="true" />
                <span className="flex-1">{option.label}</span>
                {option.value === "system" && (
                  <span className="text-xs text-muted-foreground">
                    {resolvedTheme === "dark" ? "sombre" : "clair"}
                  </span>
                )}
                {selected && (
                  <Check className="size-4 shrink-0" aria-hidden="true" />
                )}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Sélecteur à trois segments, pour un écran de réglages.
 *
 * `radiogroup` plutôt que trois boutons : un lecteur d'écran annonce alors
 * « 2 sur 3 » et les flèches du clavier naviguent entre les options.
 */
export function ThemeSegmentedControl({ className }: { className?: string }) {
  const { theme, resolvedTheme, setTheme } = useTheme()

  return (
    <div
      role="radiogroup"
      aria-label="Apparence de l’interface"
      className={cn(
        "edge-3d inline-flex w-full gap-1 rounded-xl bg-muted/60 p-1 sm:w-auto",
        className
      )}
    >
      {THEME_OPTIONS.map((option) => {
        const Icon = THEME_ICON[option.value]
        const selected = theme === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(option.value)}
            title={option.description}
            className={cn(
              "relative flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-none sm:px-4",
              selected
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {selected && (
              // Un seul fond pour les trois segments : il glisse vers
              // l'option choisie au lieu d'apparaître d'un coup.
              <motion.span
                layoutId="theme-segment-indicator"
                className="elev-1 absolute inset-0 rounded-lg bg-background"
                transition={SPRING.snappy}
              />
            )}
            <span className="relative z-10 flex items-center gap-2">
              <Icon className="size-4" aria-hidden="true" />
              {option.label}
            </span>
          </button>
        )
      })}
      <span className="sr-only" aria-live="polite">
        Thème appliqué : {resolvedTheme === "dark" ? "sombre" : "clair"}
      </span>
    </div>
  )
}
