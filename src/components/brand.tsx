import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * La marque WashPilot CI.
 *
 * Le logo est en couleurs : bleu marine, argent, vert. Contrairement à une
 * icône monochrome, il ne peut pas s'adapter par `currentColor` — ses traits
 * clairs disparaissent sur fond sombre. On embarque donc deux fichiers et on
 * choisit selon le fond réel.
 *
 * D'où la prop `tone`, qui décrit le FOND et non le logo :
 *
 * - `auto`   : le fond suit le thème de l'application (cas général).
 * - `light`  : fond toujours clair, quel que soit le thème.
 * - `dark`   : fond toujours sombre — le pied de page, par exemple, reste
 *              bleu nuit même en thème clair.
 *
 * En `auto`, la bascule se fait en CSS et non en JavaScript : les deux
 * images sont dans le DOM, une seule est affichée. Lire le thème en React
 * imposerait un premier rendu avec la mauvaise variante, donc un
 * clignotement à chaque chargement de page en thème sombre.
 */
type Tone = "auto" | "light" | "dark"

interface BrandProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Hauteur du visuel en pixels. La largeur suit le ratio. */
  height?: number
  tone?: Tone
}

const ALT = "WashPilot CI"

function Picture({
  light,
  dark,
  tone,
  height,
  ratio,
  className,
  ...props
}: BrandProps & { light: string; dark: string; ratio: number }) {
  const width = Math.round(height! * ratio)
  // `aria-hidden` sur les images : le lien ou le titre qui entoure la marque
  // porte déjà son nom accessible. Sans cela, un lecteur d'écran annoncerait
  // « WashPilot CI » deux fois, voire trois en mode `auto`.
  const common = {
    width,
    height,
    alt: "",
    "aria-hidden": true,
    draggable: false,
    decoding: "async" as const,
  }

  return (
    <span
      role="img"
      aria-label={ALT}
      className={cn("inline-flex shrink-0 items-center", className)}
      {...props}
    >
      {tone !== "dark" && (
        <img
          src={light}
          className={tone === "auto" ? "block dark:hidden" : "block"}
          {...common}
        />
      )}
      {tone !== "light" && (
        <img
          src={dark}
          className={tone === "auto" ? "hidden dark:block" : "block"}
          {...common}
        />
      )}
    </span>
  )
}

/**
 * L'emblème seul : la voiture et le volant, sans le mot-symbole.
 *
 * À utiliser partout où le nom « WashPilot CI » est déjà écrit à côté — en
 * tête de barre latérale, dans un en-tête. Répéter le nom en image à côté du
 * même nom en texte l'alourdit sans rien ajouter.
 */
export function BrandMark({ height = 32, tone = "auto", ...props }: BrandProps) {
  return (
    <Picture
      light="/brand/logo-mark.png"
      dark="/brand/logo-mark-dark.png"
      ratio={297 / 160}
      height={height}
      tone={tone}
      {...props}
    />
  )
}

/**
 * Le médaillon : le volant seul, dans un carré.
 *
 * L'emblème est presque deux fois plus large que haut. Dans un emplacement
 * carré étroit — favicon, pastille de 32 px — il se tasse à une quinzaine de
 * pixels de haut et n'est plus identifiable. Le médaillon garde le même
 * signe distinctif (le W et la flèche) et reste net dès 16 px.
 *
 * Règle simple : emplacement carré ou plus petit que 36 px → `BrandBadge` ;
 * bandeau horizontal → `BrandMark`.
 */
export function BrandBadge({ height = 32, tone = "auto", ...props }: BrandProps) {
  return (
    <Picture
      light="/brand/logo-badge.png"
      dark="/brand/logo-badge-dark.png"
      ratio={1}
      height={height}
      tone={tone}
      {...props}
    />
  )
}

/**
 * Le verrou complet : emblème et mot-symbole.
 *
 * Réservé aux endroits où la marque se présente seule et en grand — page de
 * connexion, écran de maintenance. Sous 80 px de haut, le mot-symbole devient
 * illisible : préférer `BrandMark` accompagné d'un texte.
 */
export function BrandLockup({ height = 96, tone = "auto", ...props }: BrandProps) {
  return (
    <Picture
      light="/brand/logo-full.png"
      dark="/brand/logo-full-dark.png"
      ratio={460 / 260}
      height={height}
      tone={tone}
      {...props}
    />
  )
}
