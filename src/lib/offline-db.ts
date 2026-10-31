import type { QueueStorage, QueuedMutation } from "./offline-queue"

type PGliteDatabase = import("@electric-sql/pglite").PGlite

/**
 * Petite base PostgreSQL embarquée dans le navigateur.
 *
 * Elle persiste dans IndexedDB (PGlite/WASM), et contient la file durable des
 * mutations hors connexion ainsi que les snapshots locaux synchronisables.
 * Le cloud Supabase reste la source de vérité : aucune requête ne se connecte
 * directement à Supabase depuis cette base locale.
 *
 * L'import WASM est dynamique pour ne pas payer son coût de téléchargement au
 * démarrage en ligne. L'ancien magasin IndexedDB v1 est importé une seule fois
 * pour ne pas perdre les opérations en attente lors de la mise à niveau.
 */
const DB_NAME = "washpilot-local-pg-v1"
const LEGACY_DB_NAME = "washpilot-offline"
const LEGACY_DB_VERSION = 1
const LEGACY_STORE = "mutations"
const PENDING_HINT = "washpilot-local-pglite-pending-count"

let databasePromise: Promise<PGliteDatabase | null> | null = null
let migrationPromise: Promise<void> | null = null

function pendingHint(): number {
  try {
    const value = Number(window.localStorage.getItem(PENDING_HINT) ?? 0)
    return Number.isFinite(value) && value >= 0 ? value : -1
  } catch {
    // Sans le témoin léger, on privilégie la livraison à la taille du bundle :
    // recharger PGlite est préférable à cacher une mutation déjà sauvegardée.
    return -1
  }
}

function setPendingHint(count: number): void {
  try {
    window.localStorage.setItem(PENDING_HINT, String(Math.max(0, count)))
  } catch {
    // La file PGlite reste la source locale ; l'indicateur ne sert qu'à éviter
    // de charger le moteur WASM sur une visite en ligne sans opération en attente.
  }
}

async function openLegacyDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(LEGACY_DB_NAME, LEGACY_DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(LEGACY_STORE)) {
        request.result.createObjectStore(LEGACY_STORE, { keyPath: "id" })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

async function legacyList(): Promise<QueuedMutation[]> {
  const db = await openLegacyDatabase()
  if (!db) return []
  try {
    return await new Promise((resolve) => {
      const request = db.transaction(LEGACY_STORE, "readonly").objectStore(LEGACY_STORE).getAll()
      request.onsuccess = () => resolve((request.result as QueuedMutation[] | undefined) ?? [])
      request.onerror = () => resolve([])
    })
  } catch {
    return []
  } finally {
    db.close()
  }
}

async function legacyClear(): Promise<void> {
  const db = await openLegacyDatabase()
  if (!db) return
  try {
    await new Promise<void>((resolve) => {
      const request = db.transaction(LEGACY_STORE, "readwrite").objectStore(LEGACY_STORE).clear()
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
    })
  } catch {
    // La file PostgreSQL locale est déjà la copie de sécurité.
  } finally {
    db.close()
  }
}

async function createLocalDatabase(): Promise<PGliteDatabase | null> {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") return null
  try {
    const { PGlite } = await import("@electric-sql/pglite")
    const db = new PGlite(`idb://${DB_NAME}`)
    await db.waitReady
    await db.exec(`
      CREATE TABLE IF NOT EXISTS local_schema_meta (
        key text PRIMARY KEY,
        value text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS offline_mutations (
        id text PRIMARY KEY,
        payload jsonb NOT NULL,
        created_at bigint NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_offline_mutations_created_at
        ON offline_mutations(created_at);
      CREATE TABLE IF NOT EXISTS offline_snapshots (
        cache_key text PRIMARY KEY,
        payload jsonb NOT NULL,
        synced_at timestamptz NOT NULL DEFAULT now()
      );
    `)
    return db
  } catch (error) {
    console.warn("[offline] Base locale indisponible :", error instanceof Error ? error.message : error)
    return null
  }
}

async function localDatabase(): Promise<PGliteDatabase | null> {
  if (!databasePromise) databasePromise = createLocalDatabase()
  const db = await databasePromise
  if (db && !migrationPromise) {
    migrationPromise = importLegacyQueue(db).catch((error) => {
      migrationPromise = null
      console.warn("[offline] Migration de la file locale différée :", error)
    })
  }
  if (db) await migrationPromise
  return db
}

async function importLegacyQueue(db: PGliteDatabase): Promise<void> {
  const marker = await db.query<{ value: string }>(
    "SELECT value FROM local_schema_meta WHERE key = 'legacy_queue_v1_imported'",
  )
  if (marker.rows.length) return

  const legacyItems = await legacyList()
  await db.transaction(async (tx) => {
    for (const item of legacyItems) {
      await tx.query(
        `INSERT INTO offline_mutations(id, payload, created_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (id) DO NOTHING`,
        [item.id, JSON.stringify(item), item.createdAt],
      )
    }
    await tx.query(
      `INSERT INTO local_schema_meta(key, value) VALUES ('legacy_queue_v1_imported', 'true')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    )
  })
  if (legacyItems.length) {
    await legacyClear()
    setPendingHint(legacyItems.length)
  }
}

/** Ancienne file en lecture/écriture si le navigateur ne prend pas en charge PGlite. */
const legacyFallback: QueueStorage = {
  async list() {
    return legacyList()
  },
  async put(item) {
    const db = await openLegacyDatabase()
    if (!db) return
    try {
      await new Promise<void>((resolve) => {
        const request = db.transaction(LEGACY_STORE, "readwrite").objectStore(LEGACY_STORE).put(item)
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
      })
    } catch {
      // Le caissier reste dans l'application si le stockage local est bloqué.
    } finally {
      db.close()
    }
  },
  async remove(id) {
    const db = await openLegacyDatabase()
    if (!db) return
    try {
      await new Promise<void>((resolve) => {
        const request = db.transaction(LEGACY_STORE, "readwrite").objectStore(LEGACY_STORE).delete(id)
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
      })
    } catch {
      // Même comportement tolérant que le stockage historique.
    } finally {
      db.close()
    }
  },
}

/** Interface compatible avec l'ancienne file : le synchroniseur ne change pas. */
export const indexedDbQueueStorage: QueueStorage = {
  async list() {
    // En ligne et sans éléments en attente, ne télécharge pas le moteur
    // PostgreSQL/WASM. On ne vérifie que l'ancien magasin léger pour assurer
    // la migration d'une file laissée par une version antérieure.
    if (pendingHint() === 0) {
      const oldItems = await legacyList()
      if (oldItems.length === 0) return []
    }
    const db = await localDatabase()
    if (!db) return legacyFallback.list()
    const result = await db.query<{ payload: QueuedMutation }>(
      "SELECT payload FROM offline_mutations ORDER BY created_at, id",
    )
    const items = result.rows.map((row) => row.payload)
    setPendingHint(items.length)
    return items
  },
  async put(item) {
    const db = await localDatabase()
    if (!db) {
      await legacyFallback.put(item)
      setPendingHint((await legacyList()).length)
      return
    }
    await db.query(
      `INSERT INTO offline_mutations(id, payload, created_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, created_at = EXCLUDED.created_at`,
      [item.id, JSON.stringify(item), item.createdAt],
    )
    const count = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM offline_mutations")
    setPendingHint(Number(count.rows[0]?.count ?? 0))
  },
  async remove(id) {
    const db = await localDatabase()
    if (!db) {
      await legacyFallback.remove(id)
      setPendingHint((await legacyList()).length)
      return
    }
    await db.query("DELETE FROM offline_mutations WHERE id = $1", [id])
    const count = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM offline_mutations")
    setPendingHint(Number(count.rows[0]?.count ?? 0))
  },
}

/** Cache JSON local pour les données de référence nécessaires aux écrans hors ligne. */
export async function saveOfflineSnapshot(key: string, value: unknown): Promise<void> {
  const db = await localDatabase()
  if (!db) return
  await db.query(
    `INSERT INTO offline_snapshots(cache_key, payload, synced_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (cache_key) DO UPDATE
       SET payload = EXCLUDED.payload, synced_at = EXCLUDED.synced_at`,
    [key, JSON.stringify(value)],
  )
}

export async function readOfflineSnapshot<T>(key: string): Promise<T | null> {
  const db = await localDatabase()
  if (!db) return null
  const result = await db.query<{ payload: T }>(
    "SELECT payload FROM offline_snapshots WHERE cache_key = $1",
    [key],
  )
  return result.rows[0]?.payload ?? null
}
