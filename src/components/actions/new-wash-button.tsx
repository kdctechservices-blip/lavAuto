"use client"

import * as React from "react"
import { Link } from "react-router-dom"
import { Loader2, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useAccess } from "@/lib/permissions"
import { cn } from "@/lib/utils"

/**
 * « Nouveau lavage » — l'action la plus fréquente de la journée.
 *
 * Elle reste **visible sur tous les écrans** (en-tête, barre mobile, ⌘K), avec
 * une place constante : un geste appris une fois vaut pour toute l'application.
 * Quand le rôle ou le forfait l'interdit, le bouton reste affiché mais
 * désactivé, avec la raison en toutes lettres : le masquer ferait croire que
 * l'application a changé, alors que seul le droit manque.
 */
export function NewWashButton({
  className,
  size = "sm",
  compact = false,
}: {
  className?: string
  size?: "xs" | "sm" | "default" | "lg"
  /** Icône seule : gagne de la place en en-tête sur mobile. */
  compact?: boolean
}) {
  const access = useAccess("wash:create", "washes.create")
  // Le bouton peut apparaître dans l'en-tête ET dans le tableau de bord :
  // l'identifiant du motif doit rester unique dans le document.
  const blockedId = React.useId()

  if (access.loading) {
    return (
      <Button
        size={size}
        disabled
        aria-busy="true"
        aria-label="Nouveau lavage — vérification de vos droits en cours"
        className={cn("gap-1.5", className)}
      >
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {!compact && <span className="hidden sm:inline">Nouveau lavage</span>}
      </Button>
    )
  }

  if (!access.allowed) {
    return (
      <Button
        size={size}
        variant="outline"
        disabled
        aria-describedby={blockedId}
        aria-label={`Nouveau lavage indisponible. ${access.reason ?? ""}`}
        className={cn("gap-1.5", className)}
      >
        <Plus className="size-4" aria-hidden="true" />
        {!compact && <span className="hidden sm:inline">Nouveau lavage</span>}
        <span id={blockedId} className="sr-only">
          {access.reason}
        </span>
      </Button>
    )
  }

  return (
    <Button
      size={size}
      render={<Link to="/washes?new=1" viewTransition />}
      aria-keyshortcuts="n"
      title="Nouveau lavage — raccourci N"
      className={cn("gap-1.5", className)}
    >
      <Plus className="size-4 transition-transform duration-150 group-hover/button:rotate-90" aria-hidden="true" />
      {!compact && <span className="hidden sm:inline">Nouveau lavage</span>}
      {compact && <span className="sr-only">Nouveau lavage</span>}
    </Button>
  )
}
