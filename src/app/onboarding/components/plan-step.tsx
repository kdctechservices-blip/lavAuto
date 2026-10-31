import * as React from "react"
import { useApi } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { FrameFooter } from "@/components/ui/frame"
import { Skeleton } from "@/components/ui/skeleton"
import { Check, Info } from "lucide-react"
import { cn } from "@/lib/utils"
import { TiltCard } from "@/components/ui/tilt-card"
import type { Plan } from "@/lib/onboarding-api"
import { saveStage } from "./save-stage"
import type { OnboardingWizardProps } from "./onboarding-wizard"

const formatXOF = (cents: number) =>
  cents === 0 ? "Gratuit" : `${(cents / 100).toLocaleString("fr-CI")} F CFA / mois`

const FEATURE_LABELS: Record<string, string> = {
  "sites.multiple": "Gestion multi-stations",
  "reports.advanced": "Rapports avancés",
  "reports.export": "Export des rapports",
  "employees.advanced": "Gestion avancée de l’équipe",
  "cash.reconciliation": "Rapprochement de caisse",
  "audit.advanced": "Journal d’audit avancé",
  "analytics.consolidated": "Analyses consolidées",
}

function getPlanFeatures(features: Plan["features"]): string[] {
  if (Array.isArray(features)) return features
  return Object.entries(features)
    .filter(([, enabled]) => enabled)
    .map(([key]) => FEATURE_LABELS[key] ?? key)
}

export function PlanStep({ progress, onDone, onQuit }: OnboardingWizardProps) {
  const { data: plans, loading, error } = useApi<Plan[]>("/api/v1/plans")
  const [selectedCode, setSelectedCode] = React.useState<string | null>(
    progress?.plan_code ?? null
  )
  const [saving, setSaving] = React.useState(false)
  const [serverError, setServerError] = React.useState<string | null>(null)

  async function save(quit: boolean) {
    if (!quit && !selectedCode) {
      setServerError("Choisissez un forfait pour continuer.")
      return
    }
    setSaving(true)
    setServerError(null)
    try {
      // Le plan_code provient du catalogue serveur, validé à nouveau côté serveur.
      const response = await saveStage("plan", { plan: selectedCode }, selectedCode ?? undefined, quit)
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `Erreur ${response.status}`)
      }
      if (quit) await onQuit()
      else onDone()
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Erreur inconnue")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {loading && (
        <div className="grid gap-4 md:grid-cols-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-48 w-full" />
          ))}
        </div>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="grid gap-4 md:grid-cols-3">
        {(plans ?? []).map((p, index) => (
          <TiltCard key={p.code} className="row-in" maxTilt={5}>
          <button
            type="button"
            onClick={() => setSelectedCode(p.code)}
            style={{ "--row": index } as React.CSSProperties}
            className={cn(
              "surface-3d surface-press flex h-full w-full flex-col gap-3 rounded-lg border bg-card p-4 text-left hover:bg-muted/50",
              // Le forfait retenu garde une lueur permanente : son état doit
              // rester lisible quand le curseur est ailleurs.
              selectedCode === p.code && "glow-primary glow-static border-primary bg-primary/5"
            )}
            aria-pressed={selectedCode === p.code}
          >
            <div className="flex items-center justify-between">
              <p className="font-semibold">{p.name}</p>
              {selectedCode === p.code && (
                <Check className="size-4 animate-in text-primary zoom-in-50 duration-200" />
              )}
            </div>
            <p className="text-sm text-muted-foreground">{p.description}</p>
            <p className="text-lg font-bold">{formatXOF(p.price_cents)}</p>
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {getPlanFeatures(p.features).map((f) => (
                <li key={f} className="flex items-center gap-1.5">
                  <Check className="size-3 text-primary" /> {f}
                </li>
              ))}
            </ul>
          </button>
          </TiltCard>
        ))}
      </div>

      {selectedCode && (
        <p className="flex items-start gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" />
          Votre forfait {plans?.find((p) => p.code === selectedCode)?.name} démarre
          par 14 jours d’essai gratuit, sans carte bancaire. Vous essayez
          exactement ce que vous achetez : aucune fonctionnalité ne disparaîtra
          au quinzième jour. Vous pouvez changer de forfait pendant l’essai.
        </p>
      )}
      {serverError && <p className="text-destructive text-sm">{serverError}</p>}

      <FrameFooter>
        <Button variant="ghost" onClick={() => save(true)} disabled={saving}>
          Enregistrer et quitter
        </Button>
        <Button onClick={() => save(false)} disabled={saving || !selectedCode}>
          {saving ? "Enregistrement…" : "Continuer"}
        </Button>
      </FrameFooter>
    </div>
  )
}
