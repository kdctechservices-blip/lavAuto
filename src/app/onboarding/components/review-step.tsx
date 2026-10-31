import * as React from "react"
import { Button } from "@/components/ui/button"
import { FrameFooter } from "@/components/ui/frame"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { LoadingSpinner } from "@/components/ui/loading-spinner"
import { PartyPopper } from "lucide-react"
import { Confetti } from "@/components/ui/confetti"
import { useApi, apiFetch } from "@/lib/api"
import {
  type OnboardingSummary,
  type StationData,
  type ServicesData,
  type WorkersData,
} from "@/lib/onboarding-api"
import type { OnboardingWizardProps } from "./onboarding-wizard"

const formatXOF = (cents: number | null | undefined) =>
  cents == null ? "—" : `${(cents / 100).toLocaleString("fr-CI")} F CFA`

interface ReviewStepProps extends OnboardingWizardProps {
  /** Appelé après confirmation serveur réussie (animation + redirection). */
  onCompleted: () => void
}

export function ReviewStep({ onQuit, onCompleted }: ReviewStepProps) {
  const { data: summary, loading, error } = useApi<OnboardingSummary>(
    "/api/v1/onboarding/summary"
  )
  const [confirming, setConfirming] = React.useState(false)
  const [success, setSuccess] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)

  const station = summary?.station as StationData | null
  const services = summary?.services as ServicesData | null
  const workers = summary?.workers as WorkersData | null

  async function confirm() {
    setConfirming(true)
    setServerError(null)
    try {
      // Protection double soumission côté UI : un seul POST à la fois.
      const res = await apiFetch("/api/v1/onboarding/confirm", { method: "POST" })
      if (!res.ok && res.status !== 200 && res.status !== 201) {
        const text = await res.text()
        throw new Error(text || `Erreur ${res.status}`)
      }
      // Animation de succès UNIQUEMENT après confirmation serveur (§9.8).
      setSuccess(true)
      setTimeout(onCompleted, 1600)
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Erreur inconnue")
    } finally {
      setConfirming(false)
    }
  }

  if (success) {
    return (
      <div className="relative flex flex-col items-center gap-4 overflow-hidden rounded-xl border border-primary/50 bg-card py-12 text-center">
        {/* Célébration : une seule fois, à la confirmation du serveur. */}
        <Confetti />
        <PartyPopper className="size-12 animate-in text-primary zoom-in-50 spin-in-12 duration-500" />
        <div className="animate-in fade-in-0 slide-in-from-bottom-2 delay-150 duration-300">
          <p className="text-xl font-bold">Votre station est prête !</p>
          <p className="text-muted-foreground">
            Redirection vers votre tableau de bord…
          </p>
        </div>
        <LoadingSpinner className="size-6" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {loading && (
        <div className="flex flex-col gap-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}

      {summary && (
        <>
          <section className="flex flex-col gap-1">
            <p className="text-sm font-medium text-muted-foreground">Station</p>
            <p className="font-semibold">{station?.name ?? summary.org_name}</p>
            <p className="text-sm text-muted-foreground">
              {[station?.address, station?.city].filter(Boolean).join(", ") || "Adresse non renseignée"}
              {station?.phone ? ` — ${station.phone}` : ""}
            </p>
          </section>
          <Separator />
          <section className="flex flex-col gap-1">
            <p className="text-sm font-medium text-muted-foreground">
              Services ({(services?.selected.length ?? 0) + (services?.custom.length ?? 0)})
            </p>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {services?.selected.map((s) => (
                <span key={s.template_id} className="rounded-full bg-muted px-2.5 py-1">
                  {s.name} — {formatXOF(s.price_cents)}
                </span>
              ))}
              {services?.custom.map((c) => (
                <span key={c.name} className="rounded-full border border-dashed px-2.5 py-1">
                  {c.name} (personnalisé) — {formatXOF(c.price_cents)}
                </span>
              ))}
              {((services?.selected.length ?? 0) + (services?.custom.length ?? 0)) === 0 && "—"}
            </div>
          </section>
          <Separator />
          <section className="flex flex-col gap-1">
            <p className="text-sm font-medium text-muted-foreground">
              Travailleurs ({workers?.workers.length ?? 0})
            </p>
            {workers?.workers.length ? (
              <ul className="text-sm">
                {workers.workers.map((w, i) => (
                  <li key={i}>
                    {w.first_name} {w.last_name} — {w.role}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Aucun — vous exercez seul.
              </p>
            )}
          </section>
          <Separator />
          <section className="flex flex-col gap-1">
            <p className="text-sm font-medium text-muted-foreground">Forfait</p>
            {summary.plan ? (
              <p className="font-semibold">
                {summary.plan.name} —{" "}
                {summary.plan.price_cents === 0
                  ? "Gratuit"
                  : `${formatXOF(summary.plan.price_cents)} (en attente de validation)`}
              </p>
            ) : (
              "—"
            )}
          </section>
        </>
      )}

      {serverError && <p className="text-destructive text-sm">{serverError}</p>}

      <FrameFooter>
        <Button variant="ghost" onClick={onQuit} disabled={confirming}>
          Enregistrer et quitter
        </Button>
        <Button onClick={confirm} disabled={confirming || loading || !!error}>
          {confirming ? "Création en cours…" : "Confirmer et créer ma station"}
        </Button>
      </FrameFooter>
    </div>
  )
}
