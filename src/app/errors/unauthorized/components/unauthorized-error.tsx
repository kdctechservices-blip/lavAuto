import { AppErrorState } from "@/components/errors/app-error-state"

export function UnauthorizedError() {
  return (
    <AppErrorState
      code="401"
      title="Connexion requise"
      description="Votre session n’est pas valide. Connectez-vous pour accéder à cet espace."
      primaryLabel="Se connecter"
      primaryTo="/auth/sign-in"
    />
  )
}
