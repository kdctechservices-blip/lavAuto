import { Link } from "react-router-dom"
import { ExternalLink } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { formatXof } from "@/lib/format"
import { planLabel, type OnboardingStage } from "@/lib/onboarding-stages"
import type { OnboardingProgress } from "@/lib/onboarding-api"

/**
 * Récapitulatif en lecture seule d'une étape déjà validée.
 *
 * Pourquoi en lecture seule : l'API de progression avance
 * `current_stage` à chaque sauvegarde (`nextStage`), sans retour possible.
 * Rouvrir une étape antérieure pour l'éditer ferait donc reculer tout le
 * parcours et forcerait à le refaire. On affiche donc ce qui a été enregistré,
 * avec le lien vers l'écran de gestion correspondant pour modifier plus tard.
 */

const EDIT_LINKS: Partial<Record<OnboardingStage, { to: string; label: string }>> = {
  station: { to: "/sites", label: "Modifier depuis Stations" },
  services: { to: "/services", label: "Modifier depuis Prestations" },
  workers: { to: "/team", label: "Modifier depuis Équipe" },
  plan: { to: "/settings/billing", label: "Modifier depuis Abonnement" },
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
      <dt className="w-40 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  )
}

const EMPTY = <span className="text-muted-foreground">Non renseigné</span>

export function StepRecap({
  stage,
  progress,
}: {
  stage: OnboardingStage
  progress: OnboardingProgress | null
}) {
  const edit = EDIT_LINKS[stage]

  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-2">
        {stage === "station" && (
          <>
            <Row label="Nom">{progress?.station_data?.name || EMPTY}</Row>
            <Row label="Ville ou commune">{progress?.station_data?.city || EMPTY}</Row>
            <Row label="Téléphone">{progress?.station_data?.phone || EMPTY}</Row>
            <Row label="E-mail">{progress?.station_data?.email || EMPTY}</Row>
            <Row label="Adresse">{progress?.station_data?.address || EMPTY}</Row>
          </>
        )}

        {stage === "services" && (
          <>
            <Row label="Prestations du catalogue">
              {progress?.services_data?.selected.length ? (
                <span className="flex flex-wrap gap-1.5">
                  {progress.services_data.selected.map((service) => (
                    <Badge key={service.template_id} variant="secondary" size="sm">
                      {service.name}
                      {service.price_cents != null && ` · ${formatXof(service.price_cents)}`}
                    </Badge>
                  ))}
                </span>
              ) : (
                EMPTY
              )}
            </Row>
            <Row label="Prestations propres">
              {progress?.services_data?.custom.length ? (
                <span className="flex flex-wrap gap-1.5">
                  {progress.services_data.custom.map((service) => (
                    <Badge key={service.name} variant="info-light" size="sm">
                      {service.name}
                      {service.price_cents != null && ` · ${formatXof(service.price_cents)}`}
                    </Badge>
                  ))}
                </span>
              ) : (
                <span className="text-muted-foreground">Aucune</span>
              )}
            </Row>
          </>
        )}

        {stage === "workers" && (
          <Row label="Travailleurs">
            {progress?.workers_data?.workers.length ? (
              <ul className="flex flex-col gap-0.5">
                {progress.workers_data.workers.map((worker, index) => (
                  <li key={index}>
                    {worker.first_name} {worker.last_name}
                    {worker.role && (
                      <span className="text-muted-foreground"> — {worker.role}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted-foreground">Aucun — vous exercez seul.</span>
            )}
          </Row>
        )}

        {stage === "plan" && (
          <Row label="Forfait">
            {progress?.plan_code ? (
              <span className="flex items-center gap-2">
                {planLabel(progress.plan_code)}
                <Badge variant="info-light" size="sm">
                  14 jours d’essai
                </Badge>
              </span>
            ) : (
              EMPTY
            )}
          </Row>
        )}
      </dl>

      {edit && (
        <Link
          to={edit.to}
          className="inline-flex w-fit items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
        >
          {edit.label}
          <ExternalLink className="size-3" aria-hidden="true" />
        </Link>
      )}
    </div>
  )
}
