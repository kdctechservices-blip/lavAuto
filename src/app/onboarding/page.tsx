import * as React from "react"
import { apiFetch, useApi } from "@/lib/api"
import { OnboardingWizard } from "./components/onboarding-wizard"
import { LoadingSpinner } from "@/components/ui/loading-spinner"
import { BaseLayout } from "@/components/layouts/base-layout"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/lib/auth"
import { useNavigate } from "react-router-dom"
import type { OnboardingProgress } from "@/lib/onboarding-api"

/**
 * Assistant d'onboarding multi-étapes (§5-§9 de docs/WORKFLOW.md).
 * L'étape courante vient du serveur (onboarding_progress) : rafraîchir ou
 * se déconnecter ne perd jamais la progression.
 */
export default function OnboardingPage() {
  const { isSignedIn, signOut } = useAuth()
  const navigate = useNavigate()
  const {
    data: savedProgress,
    loading,
    error,
  } = useApi<OnboardingProgress>("/api/v1/onboarding/progress")

  // Progression rafraîchie après chaque étape : évite le rechargement complet de
  // la page (et la perte de position) tout en gardant le serveur comme seule
  // source de vérité de l'étape courante.
  const [refreshed, setRefreshed] = React.useState<OnboardingProgress | null>(null)
  const progress = refreshed ?? savedProgress

  async function refreshProgress() {
    try {
      const response = await apiFetch("/api/v1/onboarding/progress")
      if (!response.ok) throw new Error(`Erreur ${response.status}`)
      setRefreshed((await response.json()) as OnboardingProgress)
    } catch {
      // Repli sans risque : on recharge la page, comme avant, si la relecture
      // échoue. Mieux vaut perdre la position que rester bloqué sur une étape
      // déjà enregistrée.
      window.location.reload()
    }
  }

  if (!isSignedIn || loading) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <LoadingSpinner className="size-8" />
      </div>
    )
  }

  if (error) {
    return (
      <BaseLayout title="Onboarding">
        <div className="flex flex-col items-center gap-4 p-8 text-center">
          <p className="text-destructive">{error}</p>
          <Button onClick={() => window.location.reload()}>Réessayer</Button>
        </div>
      </BaseLayout>
    )
  }

  if (!progress) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <LoadingSpinner className="size-8" />
      </div>
    )
  }

  return (
    <BaseLayout
      title="Configuration de la station"
      description="Création et configuration de votre station."
      hideHeading
    >
      <OnboardingWizard
        progress={progress}
        onDone={refreshProgress}
        onQuit={async () => {
          // Leave the authenticated app before logging out so the route guard
          // never loops an unfinished onboarding back to the wizard.
          navigate("/landing", { replace: true })
          await signOut()
        }}
      />
    </BaseLayout>
  )
}
