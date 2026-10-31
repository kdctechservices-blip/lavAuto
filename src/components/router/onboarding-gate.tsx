import * as React from "react"
import { Navigate, useLocation } from "react-router-dom"
import { LoadingSpinner } from "@/components/ui/loading-spinner"
import { useOnboardingStatus } from "@/lib/onboarding-api"
import { useAuth } from "@/lib/auth"

/**
 * Garde de route authentifiée (§3 du WORKFLOW) :
 * - détermine côté serveur si le compte est configuré ;
 * - un compte non configuré est renvoyé vers /onboarding (reprise à
 *   l'étape sauvegardée) ;
 * - un compte configuré accède au contenu demandé.
 * La décision ne repose jamais sur le localStorage ou l'URL.
 */
export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { data, loading, error } = useOnboardingStatus()
  const location = useLocation()
  const { refresh } = useAuth()

  // Si la vérification échoue (ex. session expirée côté serveur), on
  // resynchronise l'état d'authentification : une session réellement invalide
  // bascule l'app en "déconnecté" et la garde racine redirige vers la
  // connexion au lieu de laisser un écran d'erreur.
  React.useEffect(() => {
    if (!error) return
    const timer = window.setTimeout(() => {
      void refresh()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [error, refresh])

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <LoadingSpinner className="size-8" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-lg font-semibold">Session indisponible</p>
        <p className="text-muted-foreground max-w-sm">
          Impossible de vérifier l'état de votre station auprès du serveur. Réessayez dans un instant ; si le problème persiste, vérifiez la configuration de la base de données.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          Réessayer
        </button>
      </div>
    )
  }

  const needsOnboarding =
    data.state === "not_started" || data.state === "in_progress"

  if (needsOnboarding && location.pathname !== "/onboarding") {
    return <Navigate to="/onboarding" replace />
  }

  if (data.state === "completed" && location.pathname === "/onboarding") {
    return <Navigate to="/dashboard" replace />
  }

  return <>{children}</>
}
