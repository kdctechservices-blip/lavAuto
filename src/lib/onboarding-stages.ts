/**
 * Étapes de la configuration initiale — définitions pures.
 *
 * Ce module ne dépend ni de React ni d'`import.meta.env` : il est partagé par
 * l'assistant (Timeline), la page et les tests. Les libellés et l'ordre vivaient
 * auparavant dans `onboarding-api.ts`, qui importe `useApi` ; impossible de
 * vérifier la progression hors navigateur, et l'ordre des étapes n'avait qu'une
 * seule source par convention.
 */

export const STAGES = ["station", "services", "workers", "plan", "review"] as const
export type OnboardingStage = (typeof STAGES)[number]

export const STAGE_LABELS: Record<OnboardingStage, string> = {
  station: "Station",
  services: "Prestations",
  workers: "Travailleurs",
  plan: "Forfait",
  review: "Confirmation",
}

/** Index de l'étape dans le parcours. Une étape inconnue retombe sur la première. */
export function stageIndex(stage: string | null | undefined): number {
  const index = STAGES.indexOf((stage ?? "") as OnboardingStage)
  return index === -1 ? 0 : index
}

export type StepState = "completed" | "active" | "pending"

/** État d'une étape relativement à l'étape courante du serveur. */
export function stepState(index: number, currentIndex: number): StepState {
  if (index < currentIndex) return "completed"
  if (index === currentIndex) return "active"
  return "pending"
}

/** Progression affichée : 20 % à la première étape, 100 % à la confirmation. */
export function overallPercent(currentIndex: number): number {
  return Math.round(((currentIndex + 1) / STAGES.length) * 100)
}

/** Forme minimale lue dans `onboarding_progress`, suffisante pour les résumés. */
export interface OnboardingSnapshot {
  station_data: {
    name?: string | null
    city?: string | null
    phone?: string | null
    address?: string | null
    email?: string | null
  } | null
  services_data: {
    selected: Array<{ name: string; price_cents: number | null }>
    custom: Array<{ name: string; price_cents: number | null }>
  } | null
  workers_data: {
    workers: Array<{
      first_name?: string | null
      last_name?: string | null
      role?: string | null
    }>
  } | null
  plan_code: string | null
}

export interface TimelineStep {
  id: OnboardingStage
  title: string
  /** Ce que l'étape permet de faire — affiché sous le titre. */
  description: string
  /** Ce que voit l'utilisateur tant que l'étape n'est pas ouverte. */
  waiting: string
}

export const TIMELINE_STEPS: readonly TimelineStep[] = [
  {
    id: "station",
    title: "Identité de la station",
    description:
      "Présentez votre station de lavage : nom, coordonnées et présentation. Ces informations apparaîtront sur votre tableau de bord.",
    waiting: "C'est ici que commence la configuration de votre station.",
  },
  {
    id: "services",
    title: "Prestations et tarifs",
    description:
      "Sélectionnez les prestations que votre station propose. Vous pourrez les modifier à tout moment.",
    waiting: "S'ouvrira une fois l'identité de la station enregistrée.",
  },
  {
    id: "workers",
    title: "Équipe",
    description:
      "Ajoutez les laveurs et chefs d'équipe de la station. Vous pouvez aussi exercer seul et continuer sans travailleur.",
    waiting: "S'ouvrira une fois les prestations choisies.",
  },
  {
    id: "plan",
    title: "Forfait",
    description:
      "Pour un forfait payant, la sélection n'est pas un paiement : votre abonnement sera en attente de confirmation.",
    waiting: "S'ouvrira une fois l'équipe renseignée.",
  },
  {
    id: "review",
    title: "Confirmation",
    description:
      "Vérifiez les informations avant de créer votre station.",
    waiting: "S'ouvrira une fois le forfait choisi.",
  },
]

/** Libellé lisible d'un code de forfait (`starter` → « Starter »). */
export function planLabel(code: string | null | undefined): string {
  if (!code) return "Aucun forfait"
  return code.charAt(0).toUpperCase() + code.slice(1).replace(/[_-]/g, " ")
}

/**
 * Résumé d'une étape, affiché dans l'en-tête de la Timeline.
 * Jamais de valeur inventée : « À renseigner » quand la donnée manque.
 */
export function stepSummary(stage: OnboardingStage, progress: OnboardingSnapshot | null): string {
  if (!progress) return "À renseigner"

  switch (stage) {
    case "station": {
      const name = progress.station_data?.name?.trim()
      const city = progress.station_data?.city?.trim()
      if (!name) return "À renseigner"
      return city ? `${name} · ${city}` : name
    }
    case "services": {
      const count =
        (progress.services_data?.selected.length ?? 0) +
        (progress.services_data?.custom.length ?? 0)
      if (count === 0) return "Aucune prestation sélectionnée"
      return count === 1 ? "1 prestation sélectionnée" : `${count} prestations sélectionnées`
    }
    case "workers": {
      const count = progress.workers_data?.workers.length ?? 0
      if (count === 0) return "Vous exercez seul"
      return count === 1 ? "1 travailleur" : `${count} travailleurs`
    }
    case "plan":
      return progress.plan_code ? `Forfait ${planLabel(progress.plan_code)}` : "À choisir"
    case "review":
      return progress.station_data?.name ? "Prêt à confirmer" : "À vérifier"
    default:
      return "À renseigner"
  }
}
