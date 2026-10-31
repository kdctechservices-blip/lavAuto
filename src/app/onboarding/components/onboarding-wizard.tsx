import * as React from "react"
import { Check, ChevronDown } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Frame } from "@/components/ui/frame"
import {
  Timeline,
  TimelineContent,
  TimelineItem,
} from "@/components/ui/timeline"
import { cn } from "@/lib/utils"
import {
  STAGES,
  TIMELINE_STEPS,
  overallPercent,
  stageIndex,
  stepState,
  stepSummary,
  type OnboardingStage,
  type StepState,
} from "@/lib/onboarding-stages"
import type { OnboardingProgress } from "@/lib/onboarding-api"
import { StationStep } from "./station-step"
import { ServicesStep } from "./services-step"
import { WorkersStep } from "./workers-step"
import { PlanStep } from "./plan-step"
import { ReviewStep } from "./review-step"
import { StepRecap } from "./step-recap"

export interface OnboardingWizardProps {
  progress: OnboardingProgress | null
  /** Appelé quand l'étape courante est enregistrée : recharge la progression. */
  onDone: () => void
  onQuit: () => void | Promise<void>
}

const STATUS_LABEL: Record<StepState, string> = {
  completed: "Terminée",
  active: "À compléter",
  pending: "À venir",
}

const BADGE_VARIANT: Record<StepState, "success-light" | "warning-light" | "secondary"> = {
  completed: "success-light",
  active: "warning-light",
  pending: "secondary",
}

/**
 * Assistant de configuration présenté comme une Timeline verticale.
 *
 * L'étape courante reste celle du serveur (`onboarding_progress.current_stage`) :
 * rafraîchir, se déconnecter ou revenir plus tard retombe exactement au même
 * endroit. Chaque étape garde son formulaire, ses validations, ses appels API et
 * ses boutons ; seule la coque de navigation change (barre d'onglets → timeline).
 */
export function OnboardingWizard({
  progress,
  onDone,
  onQuit,
}: OnboardingWizardProps) {
  const stage = (progress?.current_stage ?? "station") as OnboardingStage
  const currentIndex = stageIndex(stage)

  // Étapes terminées dépliées : une seule à la fois, pour garder la timeline
  // lisible sur un téléphone.
  const [openStage, setOpenStage] = React.useState<OnboardingStage | null>(null)
  const activeRef = React.useRef<HTMLLIElement | null>(null)
  const previousStage = React.useRef(stage)

  // Après une sauvegarde, l'étape suivante peut se trouver hors écran : on
  // l'amène doucement en vue, sans faire sauter la page au premier rendu.
  React.useEffect(() => {
    if (previousStage.current === stage) return
    previousStage.current = stage
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [stage])

  if (!progress) return null

  const percent = overallPercent(currentIndex)
  const stepProps = { progress, onDone, onQuit }

  function toggle(step: OnboardingStage, next: boolean) {
    setOpenStage((current) => (next ? step : current === step ? null : current))
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4 md:p-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">Configurez votre station</h1>
          <p className="text-sm text-muted-foreground">
            Étape {currentIndex + 1} sur {STAGES.length} —{" "}
            {TIMELINE_STEPS[currentIndex].title}. Vous pouvez quitter à tout moment et
            reprendre plus tard.
          </p>
        </div>

        <div
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Progression de la configuration"
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="progress-fill h-full w-full rounded-full bg-primary transition-transform duration-500"
            style={{ transform: `scaleX(${percent / 100})` }}
          />
        </div>
      </header>

      <Timeline aria-label="Étapes de la configuration">
        {TIMELINE_STEPS.map((step, index) => {
          const status = stepState(index, currentIndex)
          const isLast = index === TIMELINE_STEPS.length - 1
          const isActive = status === "active"
          const expanded = isActive || openStage === step.id
          const summary = stepSummary(step.id, progress)

          return (
            <TimelineItem
              key={step.id}
              ref={isActive ? activeRef : undefined}
              status={status}
              last={isLast}
              aria-current={isActive ? "step" : undefined}
            >
              <Collapsible
                open={expanded}
                // Une étape à venir ne s'ouvre pas ; une étape terminée se
                // déplie pour laisser relire ce qui a été enregistré.
                onOpenChange={(next) => toggle(step.id, next)}
                disabled={status === "pending"}
              >
                <div className="flex flex-col gap-1">
                  <CollapsibleTrigger
                    // Seule une étape terminée se replie/se déplie : l'étape en
                    // cours reste ouverte, les suivantes sont verrouillées.
                    disabled={status !== "completed"}
                    className={cn(
                      "group/step flex w-full items-start justify-between gap-3 rounded-lg text-left outline-none",
                      "focus-visible:ring-[3px] focus-visible:ring-ring/50",
                      status === "completed" && "-mx-2 px-2 py-1 hover:bg-muted/50"
                    )}
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2">
                        <span
                          className={cn(
                            "text-sm leading-snug font-semibold",
                            status === "pending" && "text-muted-foreground"
                          )}
                        >
                          {step.title}
                        </span>
                        <Badge variant={BADGE_VARIANT[status]} size="sm">
                          {STATUS_LABEL[status]}
                        </Badge>
                      </span>
                      <span className="text-xs text-muted-foreground sm:text-sm">
                        {status === "pending" ? step.waiting : summary}
                      </span>
                    </span>

                    {status === "completed" && (
                      <ChevronDown
                        aria-hidden="true"
                        className={cn(
                          "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200",
                          expanded && "rotate-180"
                        )}
                      />
                    )}
                  </CollapsibleTrigger>
                </div>

                <CollapsibleContent>
                  <TimelineContent>
                    {isActive ? (
                      <div className="flex flex-col gap-3">
                        <p className="text-xs text-muted-foreground sm:text-sm">
                          {step.description}
                        </p>
                        <Frame>
                          {stage === "station" && <StationStep {...stepProps} />}
                          {stage === "services" && <ServicesStep {...stepProps} />}
                          {stage === "workers" && <WorkersStep {...stepProps} />}
                          {stage === "plan" && <PlanStep {...stepProps} />}
                          {stage === "review" && (
                            <ReviewStep
                              {...stepProps}
                              // Navigation pleine page, pas `navigate()` : la garde de
                              // route (`OnboardingGate`) persiste entre deux navigations
                              // SPA et a déjà mémorisé « in_progress » pendant l'assistant.
                              // Un rechargement forcé la fait reconsulter le serveur, qui
                              // répond maintenant « completed » : le dashboard s'ouvre.
                              onCompleted={() => window.location.assign("/dashboard")}
                            />
                          )}
                        </Frame>
                      </div>
                    ) : (
                      <Frame>
                        <StepRecap stage={step.id} progress={progress} />
                      </Frame>
                    )}
                  </TimelineContent>
                </CollapsibleContent>
              </Collapsible>
            </TimelineItem>
          )
        })}
      </Timeline>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
        Les étapes cochées sont enregistrées sur le serveur : rien ne se perd si
        vous fermez cet onglet.
      </p>
    </div>
  )
}
