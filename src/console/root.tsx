import { LoadingSpinner } from "@/components/ui/loading-spinner"

import { ConsoleAuthProvider, useConsoleAuth } from "./auth"
import { ConsoleLayout } from "./layout"
import { ConsoleLogin } from "./login"

/**
 * Racine de la console.
 *
 * Remplace `RootLayout` : la garde de session de l'application cliente
 * renverrait vers `/auth/sign-in`, c'est-à-dire vers la connexion d'une
 * station. Ici, une session absente mène à la connexion de la console, et à
 * rien d'autre.
 */
function ConsoleGate() {
  const { operator, loading } = useConsoleAuth()

  if (loading) {
    return (
      <div
        className="flex min-h-svh items-center justify-center bg-slate-950"
        role="status"
        aria-label="Vérification de la session"
        aria-busy="true"
      >
        <LoadingSpinner className="size-8" />
      </div>
    )
  }

  if (!operator) return <ConsoleLogin />

  return <ConsoleLayout />
}

export function ConsoleRoot() {
  return (
    <ConsoleAuthProvider>
      <ConsoleGate />
    </ConsoleAuthProvider>
  )
}

export default ConsoleRoot
