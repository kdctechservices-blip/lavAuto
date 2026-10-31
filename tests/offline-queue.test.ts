import test from "node:test"
import assert from "node:assert/strict"
import {
  buildQueuedMutation,
  drainQueue,
  isNetworkError,
  isPermanentRejection,
  isQueueable,
  QUEUEABLE_ROUTES,
  type QueueStorage,
  type QueuedMutation,
} from "../src/lib/offline-queue.ts"

// ---------------------------------------------------------------------------
// La file d'attente hors connexion
//
// Le scénario que ces tests gardent : une station de Yopougon perd le réseau,
// le caissier encaisse quand même trois voitures, le réseau revient.
//
// Ce qui ne doit JAMAIS arriver, et que chaque test ci-dessous interdit :
//   • qu'un lavage soit enregistré deux fois ;
//   • qu'une opération parte sous le compte d'un autre caissier ;
//   • qu'une ligne fautive retienne la recette de la journée ;
//   • qu'une coupure en cours d'envoi fasse perdre le reste de la file.
// ---------------------------------------------------------------------------

/** Stockage en mémoire, qui se comporte comme IndexedDB sans navigateur. */
function fakeStorage(initial: QueuedMutation[] = []): QueueStorage & {
  rows: Map<string, QueuedMutation>
} {
  const rows = new Map(initial.map((item) => [item.id, item]))
  return {
    rows,
    async list() {
      return [...rows.values()]
    },
    async put(item) {
      rows.set(item.id, item)
    },
    async remove(id) {
      rows.delete(id)
    },
  }
}

function item(overrides: Partial<QueuedMutation> = {}): QueuedMutation {
  // Les surcharges s'appliquent APRÈS la construction : `createdAt` et
  // `status` n'existent pas dans l'entrée de buildQueuedMutation, les passer
  // en amont revenait à les perdre en silence.
  const base = buildQueuedMutation({
    url: "/api/v1/washes",
    body: { amount_received_cents: 250_000 },
    label: "Lavage 2 500 F",
    ownerKey: "caissier-1",
    id: `id-${Math.random().toString(36).slice(2)}`,
    idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
    now: Date.now(),
  })
  return { ...base, ...overrides }
}

function jsonResponse(status: number, payload: unknown = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

// ---------------------------------------------------------------------------

test("une vente encaissée hors ligne part au retour du réseau", async () => {
  const storage = fakeStorage([item({ id: "a" })])
  const result = await drainQueue({
    storage,
    fetch: async () => jsonResponse(201, { wash: { id: "w1" } }),
    ownerKey: "caissier-1",
  })

  assert.equal(result.sent, 1)
  assert.equal(storage.rows.size, 0, "une opération acceptée quitte la file")
})

test("la clé d'idempotence ne change pas d'une tentative à l'autre", async () => {
  // LE test de ce module. Si la clé était tirée à l'envoi, un réseau qui
  // coupe juste après la requête mais avant la réponse ferait enregistrer
  // le lavage une première fois, puis une seconde à la tentative suivante.
  // Le client paierait une fois et la caisse compterait deux ventes.
  const keys: string[] = []
  let attempt = 0
  const storage = fakeStorage([item({ id: "a", idempotencyKey: "clef-stable" })])

  const fetchImpl = async (_url: string, init: RequestInit) => {
    keys.push((init.headers as Record<string, string>)["Idempotency-Key"])
    attempt += 1
    // Première tentative : le réseau lâche avant la réponse.
    if (attempt === 1) throw new TypeError("Failed to fetch")
    return jsonResponse(201)
  }

  await drainQueue({ storage, fetch: fetchImpl, ownerKey: "caissier-1" })
  assert.equal(storage.rows.size, 1, "l'opération est conservée après la coupure")

  await drainQueue({ storage, fetch: fetchImpl, ownerKey: "caissier-1" })

  assert.equal(keys.length, 2, "deux tentatives ont bien eu lieu")
  assert.equal(keys[0], keys[1], "la même clé doit repartir : c'est elle qui empêche le doublon")
  assert.equal(keys[0], "clef-stable")
})

test("les opérations partent dans l'ordre où elles ont été saisies", async () => {
  const sent: unknown[] = []
  const storage = fakeStorage([
    item({ id: "c", createdAt: 3_000, body: { rang: 3 } }),
    item({ id: "a", createdAt: 1_000, body: { rang: 1 } }),
    item({ id: "b", createdAt: 2_000, body: { rang: 2 } }),
  ])

  await drainQueue({
    storage,
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init.body)))
      return jsonResponse(201)
    },
    ownerKey: "caissier-1",
  })

  assert.deepEqual(sent, [{ rang: 1 }, { rang: 2 }, { rang: 3 }])
})

test("une coupure en cours d'envoi garde intact tout ce qui reste", async () => {
  // Sans cet arrêt, revenir en ligne une seconde ferait échouer la file
  // entière et épuiserait les tentatives pour rien.
  const storage = fakeStorage([
    item({ id: "a", createdAt: 1 }),
    item({ id: "b", createdAt: 2 }),
    item({ id: "c", createdAt: 3 }),
  ])
  let calls = 0

  const result = await drainQueue({
    storage,
    fetch: async () => {
      calls += 1
      if (calls === 1) return jsonResponse(201)
      throw new TypeError("Failed to fetch")
    },
    ownerKey: "caissier-1",
  })

  assert.equal(result.sent, 1)
  assert.equal(result.stoppedOffline, true)
  assert.equal(result.remaining, 2)
  assert.equal(calls, 2, "on n'insiste pas : deux appels, pas trois")
  assert.equal(storage.rows.size, 2, "les deux restantes attendent le prochain réseau")
  assert.equal(storage.rows.get("b")?.status, "pending", "elles restent envoyables")
})

test("une ligne refusée définitivement ne retient pas les suivantes", async () => {
  // Caisse fermée entre-temps, prestation supprimée : le serveur refuse. La
  // recette de la journée ne doit pas rester bloquée derrière cette ligne.
  const storage = fakeStorage([
    item({ id: "mauvaise", createdAt: 1 }),
    item({ id: "bonne", createdAt: 2 }),
  ])

  let call = 0
  const result = await drainQueue({
    storage,
    fetch: async () => {
      call += 1
      // La première ligne est refusée, la seconde acceptée.
      return call === 1
        ? jsonResponse(400, {
            error: { code: "cash_session_required", message: "Ouvrez la caisse." },
          })
        : jsonResponse(201)
    },
    ownerKey: "caissier-1",
  })
  assert.equal(result.failed, 1)
  assert.equal(result.sent, 1, "la suivante est bien partie")

  const parked = storage.rows.get("mauvaise")
  assert.equal(parked?.status, "failed")
  assert.equal(parked?.lastError, "Ouvrez la caisse.", "le gérant lit la raison du serveur")
  assert.equal(storage.rows.has("bonne"), false)
})

test("une session expirée n'est pas un refus définitif", async () => {
  // Le caissier s'est déconnecté pendant la coupure. L'opération redeviendra
  // valide après reconnexion : la jeter ferait perdre une recette réelle.
  assert.equal(isPermanentRejection(401), false)
  assert.equal(isPermanentRejection(408), false)
  assert.equal(isPermanentRejection(429), false)
  assert.equal(isPermanentRejection(400), true)
  assert.equal(isPermanentRejection(403), true)
  assert.equal(isPermanentRejection(409), true)
  assert.equal(isPermanentRejection(500), false, "une panne serveur se retente")
})

test("un serveur en panne arrête le défilement au lieu de le marteler", async () => {
  const storage = fakeStorage([item({ id: "a", createdAt: 1 }), item({ id: "b", createdAt: 2 })])
  let calls = 0

  const result = await drainQueue({
    storage,
    fetch: async () => {
      calls += 1
      return jsonResponse(503)
    },
    ownerKey: "caissier-1",
  })

  assert.equal(calls, 1, "on n'enchaîne pas sur un serveur à terre")
  assert.equal(result.sent, 0)
  assert.equal(storage.rows.size, 2)
  assert.equal(storage.rows.get("a")?.status, "pending")
})

test("les lignes d'un autre caissier ne partent pas sous le compte courant", async () => {
  // Le caissier du matin a laissé des ventes en attente ; celui du soir se
  // connecte. Les envoyer attribuerait son encaissement à la mauvaise
  // personne dans le journal.
  const storage = fakeStorage([
    item({ id: "matin", ownerKey: "caissier-1" }),
    item({ id: "soir", ownerKey: "caissier-2" }),
  ])
  const sent: string[] = []

  await drainQueue({
    storage,
    fetch: async (_url, init) => {
      sent.push((init.headers as Record<string, string>)["Idempotency-Key"])
      return jsonResponse(201)
    },
    ownerKey: "caissier-2",
  })

  assert.equal(sent.length, 1, "une seule opération est partie")
  assert.equal(storage.rows.has("matin"), true, "celle du matin attend son propriétaire")
  assert.equal(storage.rows.has("soir"), false)
})

test("une ligne déjà refusée n'est pas renvoyée toute seule", async () => {
  // Elle attend une décision humaine : renvoyer ou abandonner.
  const storage = fakeStorage([item({ id: "a", status: "failed" })])
  let calls = 0

  const result = await drainQueue({
    storage,
    fetch: async () => {
      calls += 1
      return jsonResponse(201)
    },
    ownerKey: "caissier-1",
  })

  assert.equal(calls, 0)
  assert.equal(result.sent, 0)
  assert.equal(storage.rows.size, 1)
})

test("seules les opérations autonomes et idempotentes sont mises en file", async () => {
  assert.equal(isQueueable("/api/v1/washes", "POST"), true)
  assert.equal(isQueueable("/api/v1/expenses", "POST"), true)

  // L'ouverture de caisse est exclue volontairement : un lavage en espèces
  // enregistré ensuite désignerait une session qui n'existe pas encore côté
  // serveur, et serait refusé à l'arrivée.
  assert.equal(isQueueable("/api/v1/cash-sessions", "POST"), false)
  // Une annulation n'est pas rejouable à l'aveugle : l'état a pu changer.
  assert.equal(isQueueable("/api/v1/washes/abc/cancel", "POST"), false)
  // Seules les créations : une modification différée écraserait une valeur
  // que quelqu'un d'autre a pu corriger entre-temps.
  assert.equal(isQueueable("/api/v1/washes", "PATCH"), false)
  assert.equal(isQueueable("/api/v1/washes", "DELETE"), false)
})

test("une chaîne de requête ne trompe pas la liste des routes autorisées", async () => {
  assert.equal(isQueueable("/api/v1/washes?v=3", "POST"), true)
  assert.equal(isQueueable("/api/v1/washes-export", "POST"), false)
})

test("toute route de la liste est une création, jamais une modification", async () => {
  // Garde-fou de relecture : si quelqu'un ajoute un jour une route à la
  // liste, ce test rappelle la règle au lieu de la laisser se perdre.
  for (const route of QUEUEABLE_ROUTES) {
    assert.ok(route.startsWith("/api/v1/"), `${route} doit être une route d'API`)
    assert.ok(!route.includes(":"), `${route} ne doit pas dépendre d'un identifiant de chemin`)
  }
})

test("une panne réseau se distingue d'une réponse du serveur", async () => {
  assert.equal(isNetworkError(new TypeError("Failed to fetch")), true)
  assert.equal(isNetworkError(new Error("500")), false)
})

test("une file vide ne fait aucun appel", async () => {
  const storage = fakeStorage()
  let calls = 0
  const result = await drainQueue({
    storage,
    fetch: async () => {
      calls += 1
      return jsonResponse(201)
    },
    ownerKey: "caissier-1",
  })
  assert.equal(calls, 0)
  assert.equal(result.sent, 0)
})
