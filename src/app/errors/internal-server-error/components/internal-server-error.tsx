import { AppErrorState } from "@/components/errors/app-error-state"

export function InternalServerError() {
  return (
    <AppErrorState
      code="500"
      title="Une erreur est survenue"
      description="Le service rencontre un problème temporaire. Réessayez dans quelques instants."
      onRetry={() => window.location.reload()}
    />
  )
}
