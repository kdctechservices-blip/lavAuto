"use client"

import { Check, Clock, Lock, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "cn"
import { splitDuration, useSubscription, type Capability } from "@/lib/subscription"

function formatDate(value: string | null) {
  if (!value) return "—"
  return new Date(value).toLocaleDateString("fr-CI", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  })
}

function Segment({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex min-w-14 flex-col items-center rounded-lg border bg-muted/40 px-3 py-2">
      <span className="font-mono text-2xl font-bold tabular-nums leading-none">
        {String(value).padStart(2, "0")}
      </span>
      <span className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
    </div>
  )
}

/**
 * Détail de l'essai gratuit sur la page Forfait : décompte, dates clés et
 * conséquences précises de l'échéance.
 */
export function TrialStatusCard() {
  const { state, loading, isTrial, isExpired, isEndingSoon, msRemaining } = useSubscription()

  if (loading) {
    return (
      <Card role="status" aria-busy="true" aria-label="Chargement de l’essai">
        <CardContent className="space-y-3 p-6">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </CardContent>
      </Card>
    )
  }

  if (!state || (!isTrial && !isExpired)) return null

  const { days, hours, minutes, seconds } = splitDuration(msRemaining)
  const labels = state.capability_labels ?? ({} as Record<Capability, string>)
  const blocked = state.restricted.filter((capability) => capability !== "sites.multiple")

  return (
    <Card
      className={cn(
        "overflow-hidden",
        isExpired
          ? "border-destructive/40"
          : isEndingSoon
            ? "border-amber-500/50"
            : "border-primary/30",
      )}
    >
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              {isExpired ? (
                <Lock className="size-5 text-destructive" aria-hidden="true" />
              ) : (
                <Sparkles className="size-5 text-primary" aria-hidden="true" />
              )}
              Essai gratuit de {state.trial_days} jours
            </CardTitle>
            <CardDescription>
              Démarré le {formatDate(state.trial_started_at)} · échéance le{" "}
              {formatDate(state.trial_ends_at)}
            </CardDescription>
          </div>
          <Badge variant={isExpired ? "destructive" : isEndingSoon ? "outline" : "secondary"}>
            {isExpired ? "Terminé" : isEndingSoon ? "Bientôt terminé" : "En cours"}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {isExpired ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <Lock className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <p>
              Votre période d’essai est terminée. L’espace reste consultable, mais les
              enregistrements sont désactivés jusqu’à l’activation d’un forfait.
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2" aria-hidden="true">
              <Segment value={days} label="jours" />
              <Segment value={hours} label="heures" />
              <Segment value={minutes} label="minutes" />
              <Segment value={seconds} label="secondes" />
            </div>
            <p className="sr-only" role="status">
              Il reste {days} jours et {hours} heures d’essai gratuit.
            </p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "progress-fill h-full w-full rounded-full",
                  isEndingSoon ? "bg-amber-500" : "bg-primary",
                )}
                style={{
                  transform: `scaleX(${Math.min(1, Math.max(0, 1 - msRemaining / Math.max(1, state.trial_days * 86_400_000)))})`,
                }}
              />
            </div>
          </>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <Check className="size-4 text-primary" aria-hidden="true" />
              {isExpired ? "Toujours disponible" : "Inclus pendant l’essai"}
            </h3>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {isExpired ? (
                <>
                  <li>Consultation de tous les lavages et paiements</li>
                  <li>Historique des {state.report_window_days ?? 7} derniers jours</li>
                  <li>Accès à l’équipe, au catalogue et à la caisse en lecture</li>
                </>
              ) : (
                <>
                  <li>Lavages, caisse et dépenses sans limite</li>
                  <li>Rapports avancés et export CSV</li>
                  <li>Historique complet de votre activité</li>
                </>
              )}
            </ul>
          </div>

          <div className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <Clock className="size-4 text-amber-500" aria-hidden="true" />
              {isExpired ? "Désactivé" : "Désactivé à l’échéance"}
            </h3>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {(isExpired
                ? blocked
                : ([
                    "washes.create",
                    "cash.manage",
                    "expenses.manage",
                    "reports.export",
                  ] as Capability[])
              ).map((capability) => (
                <li key={capability} className="flex items-center gap-1.5">
                  <Lock className="size-3 shrink-0 opacity-60" aria-hidden="true" />
                  {labels[capability] ?? capability}
                </li>
              ))}
              <li className="flex items-center gap-1.5">
                <Lock className="size-3 shrink-0 opacity-60" aria-hidden="true" />
                Historique au-delà de {state.report_window_days ?? 7} jours
              </li>
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
