import { AppErrorState } from "@/components/errors/app-error-state"

export function NotFoundError() {
  return (
    <AppErrorState
      code="404"
      title="Page introuvable"
      description="Cette page n’existe pas ou n’est plus disponible."
    />
  )
}
