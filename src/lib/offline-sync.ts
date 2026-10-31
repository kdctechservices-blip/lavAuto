import { apiFetch } from "@/lib/api"
import type { MutationRequest } from "@/lib/mutation"
import { indexedDbQueueStorage } from "@/lib/offline-db"
import {
  buildQueuedMutation,
  drainQueue,
  isQueueable,
  type DrainResult,
  type QueuedMutation,
} from "@/lib/offline-queue"

/**
 * Le chef d'orchestre du mode hors connexion.
 *
 * Fait le lien entre la logique pure (`offline-queue.ts`), le stockage
 * (`offline-db.ts`) et l'application. Garde une seule vérité en mémoire —
 * la liste en attente — et prévient les écrans qui l'affichent.
 *
 * Un point de méthode : la resynchronisation ne tourne **jamais deux fois en
 * parallèle**. Deux défilements simultanés enverraient la même opération
 * deux fois ; la clé d'idempotence l'empêcherait d'être enregistrée en
 * double côté serveur, mais on aurait tout de même doublé le trafic d'une
 * station en 3G, et faussé les compteurs affichés.
 */

type Listener = (items: QueuedMutation[]) => void

const listeners = new Set<Listener>()
let cache: QueuedMutation[] = []
let syncing = false
let ownerKey = ""

/** Déclare le compte connecté. Sans lui, rien ne part : voir la règle 5. */
export function setQueueOwner(key: string): void {
  ownerKey = key
}

function notify() {
  for (const listener of listeners) listener(cache)
}

export function subscribeToQueue(listener: Listener): () => void {
  listeners.add(listener)
  listener(cache)
  return () => {
    listeners.delete(listener)
  }
}

export async function refreshQueue(): Promise<QueuedMutation[]> {
  cache = await indexedDbQueueStorage.list()
  notify()
  return cache
}

/**
 * Conserve une écriture pour plus tard.
 *
 * Rend `false` si l'opération n'a rien à faire dans une file — l'appelant
 * affiche alors l'erreur réseau habituelle plutôt que de promettre un envoi
 * qui n'aura pas lieu.
 */
export async function enqueueMutation(request: MutationRequest): Promise<boolean> {
  if (!request.offline) return false
  if (!isQueueable(request.url, request.method ?? "POST")) return false
  if (!ownerKey) return false

  const item = buildQueuedMutation({
    url: request.url,
    body: request.body,
    label: request.offline.label,
    ownerKey,
    id: crypto.randomUUID(),
    // Tirée ici, une fois pour toutes : c'est ce qui interdit le doublon.
    idempotencyKey: request.headers?.["Idempotency-Key"] ?? crypto.randomUUID(),
    now: Date.now(),
  })

  await indexedDbQueueStorage.put(item)
  await refreshQueue()
  return true
}

/** Oublie une opération refusée, sur décision explicite du gérant. */
export async function discardQueued(id: string): Promise<void> {
  await indexedDbQueueStorage.remove(id)
  await refreshQueue()
}

/** Remet une opération refusée dans la file, après correction côté serveur. */
export async function retryQueued(id: string): Promise<void> {
  const item = cache.find((entry) => entry.id === id)
  if (!item) return
  await indexedDbQueueStorage.put({ ...item, status: "pending", lastError: null })
  await refreshQueue()
  await syncNow()
}

export async function syncNow(): Promise<DrainResult | null> {
  if (syncing || !ownerKey) return null
  syncing = true
  try {
    const result = await drainQueue({
      storage: indexedDbQueueStorage,
      fetch: (url, init) => apiFetch(url, init),
      ownerKey,
    })
    await refreshQueue()
    return result
  } finally {
    syncing = false
  }
}

let started = false

/**
 * Branche la resynchronisation automatique.
 *
 * Trois déclencheurs, et c'est volontairement peu :
 *   • le navigateur annonce le retour du réseau ;
 *   • l'onglet redevient visible — `online` ment souvent sur mobile, où le
 *     téléphone dort pendant la coupure et ne signale rien au réveil ;
 *   • un rappel périodique, filet pour les cas où ni l'un ni l'autre ne se
 *     produit.
 */
export function startOfflineSync(): () => void {
  if (started || typeof window === "undefined") return () => {}
  started = true

  const trigger = () => {
    if (navigator.onLine) void syncNow()
  }

  window.addEventListener("online", trigger)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") trigger()
  })
  const timer = window.setInterval(trigger, 60_000)

  void refreshQueue().then(trigger)

  return () => {
    window.removeEventListener("online", trigger)
    window.clearInterval(timer)
    started = false
  }
}
