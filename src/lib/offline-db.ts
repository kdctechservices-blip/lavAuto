import type { QueueStorage, QueuedMutation } from "./offline-queue"

/**
 * Stockage de la file d'attente, en IndexedDB.
 *
 * Pourquoi IndexedDB et pas `localStorage` : une recette de journée tient
 * largement dans les 5 Mo de `localStorage`, mais celui-ci est **synchrone**.
 * Écrire à chaque vente gèlerait brièvement l'interface sur un téléphone
 * d'entrée de gamme — exactement le matériel sur lequel ce produit tourne.
 *
 * Aucune bibliothèque : IndexedDB est verbeux, mais une dépendance de plus
 * dans un paquet que des stations téléchargent en 3G coûte plus cher que
 * cinquante lignes de rappels.
 *
 * Tous les accès échouent en silence et renvoient une file vide plutôt que
 * de lever : en navigation privée, IndexedDB peut être refusé. L'application
 * doit alors continuer de fonctionner en ligne, pas afficher une erreur
 * incompréhensible au caissier.
 */

const DB_NAME = "washpilot-offline"
const DB_VERSION = 1
const STORE = "mutations"

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null)
      return
    }
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

function promisify<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

export const indexedDbQueueStorage: QueueStorage = {
  async list(): Promise<QueuedMutation[]> {
    const db = await openDatabase()
    if (!db) return []
    try {
      const store = db.transaction(STORE, "readonly").objectStore(STORE)
      const rows = await promisify(store.getAll() as IDBRequest<QueuedMutation[]>)
      return rows ?? []
    } catch {
      return []
    } finally {
      db.close()
    }
  },

  async put(item: QueuedMutation): Promise<void> {
    const db = await openDatabase()
    if (!db) return
    try {
      const store = db.transaction(STORE, "readwrite").objectStore(STORE)
      await promisify(store.put(item) as IDBRequest<IDBValidKey>)
    } catch {
      /* Écriture refusée : l'opération est perdue, mais l'application tient. */
    } finally {
      db.close()
    }
  },

  async remove(id: string): Promise<void> {
    const db = await openDatabase()
    if (!db) return
    try {
      const store = db.transaction(STORE, "readwrite").objectStore(STORE)
      await promisify(store.delete(id) as IDBRequest<undefined>)
    } catch {
      /* Idem : on ne casse pas l'interface pour une suppression ratée. */
    } finally {
      db.close()
    }
  },
}
