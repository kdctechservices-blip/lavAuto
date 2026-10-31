import { Outlet, useLocation, useNavigation, Navigate } from "react-router-dom"
import { useAuth } from "@/lib/auth"
import { LoadingSpinner } from "@/components/ui/loading-spinner"
import { OnboardingGate } from "@/components/router/onboarding-gate"

/** Thin top bar shown while the next route's code is loading. */
function RouteProgress() {
  return (
    <div
      role="progressbar"
      aria-label="Chargement de la page"
      className="route-progress fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-primary/15"
    >
      <div className="route-progress-bar h-full w-1/3 bg-primary" />
    </div>
  )
}

function AuthLoading() {
  return (
    <div className="flex min-h-svh items-center justify-center" role="status" aria-label="Vérification de la session">
      <LoadingSpinner className="size-8" />
    </div>
  )
}

/**
 * Workflow (§WORKFLOW) :
 * - landing publique ;
 * - inscription → onboarding → tableau de bord ;
 * - connexion suivante → tableau de bord directement.
 */
export function RootLayout() {
  const navigation = useNavigation()
  const location = useLocation()
  const { isLoaded, isSignedIn } = useAuth()
  const isPublicLandingRoute = location.pathname === "/" || location.pathname === "/landing"
  const isAuthRoute = location.pathname.startsWith("/auth/")
  // Un lien de réinitialisation reste utilisable même avec une session active :
  // sa validation révoque justement toutes les sessions ouvertes.
  const isPasswordResetRoute = location.pathname === "/auth/reset-password"

  if (!isLoaded) return <AuthLoading />

  if (isPublicLandingRoute) {
    return <>
      {navigation.state === "loading" && <RouteProgress />}
      <Outlet />
    </>
  }

  if (isAuthRoute) {
    if (isSignedIn && !isPasswordResetRoute) {
      return <Navigate to="/dashboard" replace />
    }
    return <>
      {navigation.state === "loading" && <RouteProgress />}
      <Outlet />
    </>
  }

  if (!isSignedIn) {
    return <Navigate to="/auth/sign-in" replace state={{ from: `${location.pathname}${location.search}` }} />
  }

  return (
    <>
      {navigation.state === "loading" && <RouteProgress />}
      <OnboardingGate>
        <Outlet />
      </OnboardingGate>
    </>
  )
}

/** Shown on the very first load, before any route has rendered. */
export function RootFallback() {
  return <AuthLoading />
}
