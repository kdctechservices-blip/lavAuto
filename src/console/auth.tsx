import * as React from "react"

import { consoleRequest, storeConsoleToken } from "./api"

// ---------------------------------------------------------------------------
// Session de la console
//
// Un contexte à part, qui n'emprunte rien à `src/lib/auth.tsx`. Partager le
// fournisseur des stations aurait un effet pervers discret : se déconnecter
// d'un côté déconnecterait de l'autre, et un état résiduel de station
// ressurgirait dans la console au prochain rendu.
// ---------------------------------------------------------------------------

export type ConsoleRole = "admin" | "supervisor" | "support"

export interface Operator {
  id: string
  email: string
  full_name: string
  role: ConsoleRole
}

interface ConsoleAuthValue {
  operator: Operator | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}

const ConsoleAuthContext = React.createContext<ConsoleAuthValue | null>(null)

export function ConsoleAuthProvider({ children }: { children: React.ReactNode }) {
  const [operator, setOperator] = React.useState<Operator | null>(null)
  const [loading, setLoading] = React.useState(true)

  // La session est relue une seule fois au montage. L'appel vit dans l'effet
  // plutôt que dans un `useCallback` appelé depuis l'effet : poser un état
  // depuis une fonction déclenchée synchroniquement par un effet provoque un
  // rendu en cascade, que le lint signale à juste titre.
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const payload = await consoleRequest<{ operator: Operator }>("/auth/me")
        if (!cancelled) setOperator(payload.operator)
      } catch {
        if (!cancelled) setOperator(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const signIn = React.useCallback(async (email: string, password: string) => {
    const payload = await consoleRequest<{ token: string; operator: Operator }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    })
    // Le cookie httpOnly reste la voie principale ; le jeton stocké n'est
    // qu'un repli pour les aperçus en iframe, où les cookies tiers sautent.
    storeConsoleToken(payload.token)
    setOperator(payload.operator)
  }, [])

  const signOut = React.useCallback(async () => {
    try {
      await consoleRequest("/auth/logout", { method: "POST" })
    } catch {
      /* Même si le serveur refuse, on referme la session côté navigateur. */
    }
    storeConsoleToken(null)
    setOperator(null)
  }, [])

  const value = React.useMemo(
    () => ({ operator, loading, signIn, signOut }),
    [operator, loading, signIn, signOut],
  )

  return <ConsoleAuthContext.Provider value={value}>{children}</ConsoleAuthContext.Provider>
}

export function useConsoleAuth(): ConsoleAuthValue {
  const value = React.useContext(ConsoleAuthContext)
  if (!value) throw new Error("useConsoleAuth doit être utilisé dans ConsoleAuthProvider")
  return value
}

/** Masque une action d'écriture pour le profil support ; le serveur la refuse aussi. */
export function ConsoleWrite({ children, fallback = null }: {
  children: React.ReactNode
  fallback?: React.ReactNode
}) {
  const { operator } = useConsoleAuth()
  return operator?.role === "support" ? fallback : children
}

export function ConsoleAdminOnly({ children, fallback = null }: {
  children: React.ReactNode
  fallback?: React.ReactNode
}) {
  const { operator } = useConsoleAuth()
  return operator?.role === "admin" ? children : fallback
}
