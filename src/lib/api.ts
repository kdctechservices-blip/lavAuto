import { useEffect, useState } from "react"

const configuredApiBase = (import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "")
const API_BASE_URL = /^(https?:\/\/)(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(
  configuredApiBase
)
  ? ""
  : configuredApiBase

export { API_BASE_URL }

/**
 * Délai d'attente par requête.
 *
 * Sans lui, une requête qui pend (le répartiteur devant le serveur qui boucle,
 * le réseau mobile qui coupe sans prévenir) laisse un spinner tourner pour
 * toujours — et un bouton « Nouveau lavage » qui charge sans jamais rien
 * ouvrir, parce que les droits ne sont jamais arrivés. Le fetch natif ne sait
 * pas s'annuler tout seul : on combine un `AbortSignal.timeout` avec le signal
 * éventuellement fourni par l'appelant (la valeur la plus contraignante gagne).
 */
export const API_TIMEOUT_MS = 20_000

async function fetchWithTimeout(path: string, options: RequestInit): Promise<Response> {
  const external = options.signal
  if (typeof AbortSignal?.timeout === "function" && !external) {
    return fetch(path, { ...options, signal: AbortSignal.timeout(API_TIMEOUT_MS) })
  }
  if (typeof AbortSignal?.timeout === "function" && external) {
    return fetch(path, {
      ...options,
      signal: AbortSignal.any([external, AbortSignal.timeout(API_TIMEOUT_MS)]),
    })
  }
  return fetch(path, options)
}

// ---------------------------------------------------------------------------
// Jeton de session de secours : le cookie httpOnly reste la voie principale,
// mais certains contextes (aperçu intégré dans une iframe) bloquent les
// cookies tiers. Le serveur accepte alors `Authorization: Bearer <jeton>`.
// ---------------------------------------------------------------------------
const SESSION_TOKEN_KEY = "washpilot.session-token"

// Repli ultime : certains contextes intégrés (iframe) bloquent cookies ET
// localStorage. Le jeton vit alors en mémoire pour la durée de la page.
let inMemorySessionToken: string | null = null

export function getStoredSessionToken(): string | null {
  if (inMemorySessionToken) return inMemorySessionToken
  try {
    return window.localStorage.getItem(SESSION_TOKEN_KEY)
  } catch {
    return null
  }
}

export function storeSessionToken(token: string | null): void {
  inMemorySessionToken = token
  try {
    if (token) window.localStorage.setItem(SESSION_TOKEN_KEY, token)
    else window.localStorage.removeItem(SESSION_TOKEN_KEY)
  } catch {
    // Stockage local indisponible : le jeton en mémoire prend le relais.
  }
}

export function authHeaders(): Record<string, string> {
  const token = getStoredSessionToken()
  return token ? { Authorization: `Bearer ${token}`, "X-Session-Token": token } : {}
}

export interface UseApiResult<T> {
  data: T | null
  loading: boolean
  error: string | null
}

export async function apiErrorMessage(response: Response): Promise<string> {
  const body = await response.text()
  const contentType = response.headers.get("content-type") || ""

  // Une page HTML là où l'on attend du JSON n'est pas une erreur métier : c'est
  // le signe que la requête n'a jamais atteint l'API (réécriture absente du
  // déploiement, passerelle en panne). Afficher les premières lignes de la page
  // d'erreur de la plateforme — « <!doctype html>… » — n'apprend rien à un
  // gérant de station ; le code HTTP, lui, dit quoi vérifier à l'exploitant.
  const looksLikeHtml = contentType.includes("text/html") || /^\s*</.test(body)
  if (looksLikeHtml) {
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return "Le serveur n'a pas répondu à temps. Réessayez dans un instant ; si cela dure, prévenez votre éditeur."
    }
    if (response.status === 401 || response.status === 403) {
      return "Votre session n'est plus reconnue. Reconnectez-vous."
    }
    return `L'API n'a pas répondu (${response.status}). Le service est peut-être en cours de déploiement : réessayez dans un instant.`
  }

  if (!body) return `API ${response.status}`
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string }
    return parsed.error?.message || parsed.message || `API ${response.status}`
  } catch {
    return body.slice(0, 500)
  }
}

const responseError = apiErrorMessage

/** Fetch an API resource; the session cookie authenticates the request. */
export function useApi<T = unknown>(path: string): UseApiResult<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!path) return

    const controller = new AbortController()

    ;(async () => {
      setLoading(true)
      setData(null)
      setError(null)
      try {
        const res = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
          headers: new Headers({ Accept: "application/json", ...authHeaders() }),
          signal: controller.signal,
          credentials: "include",
        })
        if (controller.signal.aborted) return
        if (!res.ok) throw new Error(await responseError(res))

        const contentType = res.headers.get("content-type") || ""
        if (contentType.includes("application/json")) {
          const json = (await res.json()) as T
          if (!controller.signal.aborted) setData(json)
        } else {
          const text = await res.text()
          if (!controller.signal.aborted) setData(text as unknown as T)
        }
      } catch (err) {
        if (controller.signal.aborted) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()

    return () => controller.abort()
  }, [path])

  return {
    data: path ? data : null,
    loading: path ? loading : false,
    error: path ? error : null,
  }
}

/** Authenticated fetch helper — the httpOnly session cookie is sent automatically. */
export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers)
  headers.set("Accept", "application/json")
  if (options.body !== undefined && !headers.has("Content-Type") && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json")
  }
  const token = getStoredSessionToken()
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`)
  if (token && !headers.has("X-Session-Token")) headers.set("X-Session-Token", token)

  return fetchWithTimeout(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    credentials: options.credentials ?? "include",
  })
}
