import "fake-indexeddb/auto"
import test from "node:test"
import assert from "node:assert/strict"
import { drainQueue, type QueuedMutation } from "../src/lib/offline-queue.ts"

const localValues = new Map<string, string>()
Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis })
Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { pathname: "/index.html" },
})
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => localValues.set(key, value),
  },
})

function mutation(id: string, createdAt: number): QueuedMutation {
  return {
    id,
    url: "/api/v1/washes",
    body: { id },
    idempotencyKey: `idem-${id}`,
    ownerKey: "user-1",
    label: `Lavage ${id}`,
    createdAt,
    attempts: 0,
    status: "pending",
    lastError: null,
  }
}

async function seedLegacyMutation(item: QueuedMutation): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("washpilot-offline", 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore("mutations", { keyPath: "id" })
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const transaction = request.result.transaction("mutations", "readwrite")
      transaction.objectStore("mutations").put(item)
      transaction.oncomplete = () => {
        request.result.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
    }
  })
}

async function readLegacyMutations(): Promise<QueuedMutation[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("washpilot-offline", 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const read = db.transaction("mutations", "readonly").objectStore("mutations").getAll()
      read.onsuccess = () => {
        db.close()
        resolve(read.result as QueuedMutation[])
      }
      read.onerror = () => reject(read.error)
    }
  })
}

test("PGlite conserve la file, importe l'ancien IndexedDB et tolère un témoin inaccessible", async () => {
  const legacy = mutation("legacy-1", 1)
  const current = mutation("current-1", 2)
  await seedLegacyMutation(legacy)

  const { indexedDbQueueStorage, readOfflineSnapshot, saveOfflineSnapshot } = await import("../src/lib/offline-db.ts")

  const afterImport = await indexedDbQueueStorage.list()
  assert.deepEqual(afterImport.map((item) => item.id), [legacy.id])
  assert.deepEqual(await readLegacyMutations(), [])
  assert.equal(localValues.get("washpilot-local-pglite-pending-count"), "1")

  const snapshot = [{ id: "service-1", name: "Lavage complet", price_cents: 2500 }]
  await saveOfflineSnapshot("services", snapshot)
  assert.deepEqual(await readOfflineSnapshot("services"), snapshot)

  await indexedDbQueueStorage.put(current)
  assert.deepEqual(
    (await indexedDbQueueStorage.list()).map((item) => item.id),
    [legacy.id, current.id],
  )

  await indexedDbQueueStorage.remove(legacy.id)
  assert.deepEqual((await indexedDbQueueStorage.list()).map((item) => item.id), [current.id])

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("storage indisponible")
    },
  })
  assert.deepEqual((await indexedDbQueueStorage.list()).map((item) => item.id), [current.id])

  const sentRequests: Array<{ url: string; init: RequestInit }> = []
  const result = await drainQueue({
    storage: indexedDbQueueStorage,
    ownerKey: current.ownerKey,
    fetch: async (url, init) => {
      sentRequests.push({ url, init })
      return new Response(JSON.stringify({ id: current.id }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  assert.deepEqual(result, { sent: 1, failed: 0, remaining: 0, stoppedOffline: false })
  assert.equal(sentRequests.length, 1)
  assert.equal(sentRequests[0]?.url, current.url)
  assert.equal(new Headers(sentRequests[0]?.init.headers).get("Idempotency-Key"), current.idempotencyKey)
  assert.deepEqual(JSON.parse(String(sentRequests[0]?.init.body)), current.body)
  assert.deepEqual(await indexedDbQueueStorage.list(), [])
})
