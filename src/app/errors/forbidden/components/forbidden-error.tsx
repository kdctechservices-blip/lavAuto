import { AppErrorState } from "@/components/errors/app-error-state"

export function ForbiddenError() {
  return (
    <AppErrorState
      code="403"
      title="Accès refusé"
      description="Votre rôle ne permet pas d’effectuer cette action dans l’organisation active."
    />
  )
}
