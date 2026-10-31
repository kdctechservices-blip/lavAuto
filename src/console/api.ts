import { API_BASE_URL } from "@/lib/api"

// ---------------------------------------------------------------------------
// Accès réseau de la console
//
// Volontairement distinct de `apiFetch` : celui des stations attache le jeton
// de session du lavage (`Authorization: Bearer …`). L'emprunter ici
// reconstruirait exactement ce qu'on vient de défaire — une requête de
// console portant une identité de station.
//
// Le jeton de console voyage sous un schéma à lui, `Console`, pour qu'un
// mélange de jetons ne puisse pas passer inaperçu côté serveur.
// ---------------------------------------------------------------------------

const CONSOLE_TOKEN_KEY = "washpilot.console-token"

let inMemoryToken: string | null = null

export function getConsoleToken(): string | null {
  if (inMemoryToken) return inMemoryToken
  try {
    return window.localStorage.getItem(CONSOLE_TOKEN_KEY)
  } catch {
    return null
  }
}

export function storeConsoleToken(token: string | null): void {
  inMemoryToken = token
  try {
    if (token) window.localStorage.setItem(CONSOLE_TOKEN_KEY, token)
    else window.localStorage.removeItem(CONSOLE_TOKEN_KEY)
  } catch {
    /* Stockage indisponible : le jeton vit en mémoire pour la page. */
  }
}

export class ConsoleApiError extends Error {
  code: string
  status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "ConsoleApiError"
    this.status = status
    this.code = code
  }
}

export async function consoleFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers)
  headers.set("Accept", "application/json")
  if (options.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json")
  }
  const token = getConsoleToken()
  if (token) headers.set("Authorization", `Console ${token}`)

  return fetch(`${API_BASE_URL}/api/v1/console${path}`, {
    ...options,
    headers,
    credentials: options.credentials ?? "include",
  })
}

/** Appelle la console et renvoie le JSON, ou lève une `ConsoleApiError`. */
export async function consoleRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await consoleFetch(path, options)
  const text = await response.text()
  const payload = text ? (JSON.parse(text) as unknown) : null

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error
    throw new ConsoleApiError(
      response.status,
      error?.code ?? "unknown_error",
      error?.message ?? "La console n'a pas pu traiter cette demande.",
    )
  }
  return payload as T
}

/**
 * Télécharge un fichier servi par la console.
 *
 * Un simple `<a href>` n'enverrait pas l'en-tête `Console` : le serveur
 * répondrait 404 et l'utilisateur verrait une page blanche sans comprendre.
 * On récupère donc le corps par `fetch`, puis on déclenche le
 * téléchargement depuis un objet blob.
 *
 * Le nom de fichier est repris de `Content-Disposition` quand le serveur en
 * fournit un : c'est lui qui connaît la période exportée.
 */
export async function downloadConsoleFile(path: string, fallbackName = "export.csv"): Promise<void> {
  const response = await consoleFetch(path, { headers: { Accept: "text/csv" } })
  if (!response.ok) {
    let code = "unknown_error"
    let message = "Export impossible."
    try {
      const payload = (await response.json()) as { error?: { code?: string; message?: string } }
      code = payload.error?.code ?? code
      message = payload.error?.message ?? message
    } catch {
      /* Le corps n'est pas du JSON : on garde le message générique. */
    }
    throw new ConsoleApiError(response.status, code, message)
  }

  const disposition = response.headers.get("content-disposition") ?? ""
  const match = /filename="?([^"]+)"?/.exec(disposition)
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = match?.[1] ?? fallbackName
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Sans révocation, le blob reste en mémoire jusqu'au rechargement de la page.
  URL.revokeObjectURL(url)
}

export function formatFcfa(cents: number): string {
  return `${Math.round(cents / 100).toLocaleString("fr-FR")} F`
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("fr-CI", { day: "2-digit", month: "short", year: "numeric" })
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleString("fr-CI", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
