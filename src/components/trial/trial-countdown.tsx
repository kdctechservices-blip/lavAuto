"use client"

import { Link } from "react-router"
import { Clock, Lock, Sparkles } from "lucide-react"
import { cn } from "cn"
import { splitDuration, useSubscription } from "@/lib/subscription"

/** Deux chiffres, pour éviter que le décompte ne « saute » à chaque seconde. */
function pad(value: number) {
  return String(value).padStart(2, "0")
}

function Unit({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center rounded-md bg-background/70 px-1.5 py-1 leading-none">
      <span className="font-mono text-sm font-semibold tabular-nums">{value}</span>
      <span className="text-[9px] uppercase tracking-wide opacity-70">{label}</span>
    </div>
  )
}

/**
 * Carte « essai gratuit » affichée en pied de barre latérale.
 * Trois états : essai confortable, échéance proche (≤ 3 jours), essai terminé.
 */
export function TrialCountdown({ className }: { className?: string }) {
  const { state, isTrial, isExpired, isEndingSoon, msRemaining } = useSubscription()

  if (!state) return null

  if (isExpired) {
    return (
      <div
        className={cn(
          "rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs group-data-[collapsible=icon]:hidden",
          className,
        )}
        role="status"
      >
        <div className="flex items-center gap-2 font-medium text-destructive">
          <Lock className="size-3.5 shrink-0" aria-hidden="true" />
          Essai terminé
        </div>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          Votre espace est en lecture seule. Activez un forfait pour reprendre les
          enregistrements.
        </p>
        <Link
          to="/settings/billing"
          viewTransition
          className="mt-2 flex h-8 items-center justify-center rounded-md bg-destructive px-2 text-[11px] font-medium text-white transition-transform duration-150 hover:scale-[1.02] active:scale-[0.98]"
        >
          Choisir un forfait
        </Link>
      </div>
    )
  }

  if (!isTrial) return null

  const { days, hours, minutes, seconds } = splitDuration(msRemaining)
  // Part de l'essai déjà consommée (0 → 1), pour la barre de progression.
  const elapsed = Math.min(
    1,
    Math.max(0, 1 - msRemaining / Math.max(1, state.trial_days * 86_400_000)),
  )

  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-xs transition-colors duration-200 group-data-[collapsible=icon]:hidden",
        isEndingSoon
          ? "border-amber-500/50 bg-amber-500/10"
          : "border-primary/30 bg-primary/5",
        className,
      )}
      role="status"
      aria-label={`Essai gratuit : ${days} jours ${hours} heures restants`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium">
          {isEndingSoon ? (
            <Clock className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
          ) : (
            <Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
          )}
          Essai gratuit
        </span>
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
            isEndingSoon
              ? "bg-amber-500/20 text-amber-700 dark:text-amber-300"
              : "bg-primary/15 text-primary",
          )}
        >
          J-{days}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-4 gap-1 text-center" aria-hidden="true">
        <Unit value={pad(days)} label="j" />
        <Unit value={pad(hours)} label="h" />
        <Unit value={pad(minutes)} label="min" />
        <Unit value={pad(seconds)} label="s" />
      </div>

      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "progress-fill h-full w-full rounded-full",
            isEndingSoon ? "bg-amber-500" : "bg-primary",
          )}
          style={{ transform: `scaleX(${elapsed})` }}
        />
      </div>

      <Link
        to="/settings/billing"
        viewTransition
        className={cn(
          "mt-2.5 flex h-8 items-center justify-center rounded-md px-2 text-[11px] font-medium transition-transform duration-150 hover:scale-[1.02] active:scale-[0.98]",
          isEndingSoon
            ? "bg-amber-500 text-white"
            : "border bg-background text-foreground hover:bg-accent",
        )}
      >
        {isEndingSoon ? "Activer un forfait" : "Voir les forfaits"}
      </Link>
    </div>
  )
}
