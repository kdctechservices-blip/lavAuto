"use client"

import * as React from "react"
import { Check, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface SubmitButtonProps extends React.ComponentProps<typeof Button> {
  /** Requête en cours. */
  pending?: boolean
  /** Succès récent : la coche remplace brièvement le libellé. */
  success?: boolean
  pendingLabel?: string
  successLabel?: string
  /** Icône affichée au repos. */
  idleIcon?: React.ReactNode
}

/**
 * Bouton d'envoi à trois temps : repos → attente → succès.
 *
 * Le changement d'état se lit sur le bouton lui-même, là où se trouve déjà le
 * regard et le doigt : l'utilisateur n'a pas besoin de chercher une
 * confirmation ailleurs dans l'écran.
 */
export function SubmitButton({
  pending = false,
  success = false,
  pendingLabel = "Enregistrement…",
  successLabel = "Enregistré",
  idleIcon,
  children,
  className,
  disabled,
  ...props
}: SubmitButtonProps) {
  return (
    <Button
      {...props}
      disabled={disabled || pending}
      aria-live="polite"
      aria-busy={pending}
      data-state={pending ? "pending" : success ? "success" : "idle"}
      className={cn(
        "relative transition-colors duration-200",
        success &&
          "bg-emerald-600 text-white hover:bg-emerald-600 dark:bg-emerald-600",
        className
      )}
    >
      <span
        key={pending ? "pending" : success ? "success" : "idle"}
        className="inline-flex animate-in items-center gap-2 fade-in-0 zoom-in-95 duration-200"
      >
        {pending ? (
          <>
            <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
            {pendingLabel}
          </>
        ) : success ? (
          <>
            <Check className="size-4" aria-hidden="true" />
            {successLabel}
          </>
        ) : (
          <>
            {idleIcon}
            {children}
          </>
        )}
      </span>
    </Button>
  )
}
