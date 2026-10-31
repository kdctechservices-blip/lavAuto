import test from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_FAILURE,
  performMutation,
  readBody,
  type MutationDeps,
} from "../src/lib/mutation.ts"

/**
 * Le bloc d'écriture était recopié vingt-huit fois. Ces tests fixent le
 * comportement unique qui les remplace, et surtout les deux pièges qui
 * faisaient déjà diverger les copies : une `Response` brute dont personne ne
 * vérifie `ok`, et un corps qu'on ne peut lire qu'une fois.
 */

function reponse(status: number, body: string | null, json = true): Response {
  const headers = json ? { "content-type": "application/json" } : {}
  return new Response(body, { status, headers })
}

function deps(overrides: Partial<MutationDeps> = {}): MutationDeps {
  return {
    fetch: async () => reponse(200, JSON.stringify({ id: "1" })),
    confirm: () => true,
    ...overrides,
  }
}

test("écriture réussie : rend la donnée et le message de succès", async () => {
  const out = await performMutation<{ id: string }>(
    { url: "/api/v1/x", success: "C'est enregistré." },
    deps(),
  )
  assert.equal(out.ok, true)
  assert.deepEqual(out.data, { id: "1" })
  assert.equal(out.success, "C'est enregistré.")
  assert.equal(out.error, null)
})

test("un 400 n'est jamais pris pour un succès", async () => {
  // Le piège d'origine : `apiFetch` rend une Response brute, et le code qui
  // ne regarde pas `ok` affiche « enregistré » sur un refus.
  const out = await performMutation(
    { url: "/api/v1/x", success: "Enregistré." },
    deps({ fetch: async () => reponse(400, JSON.stringify({ error: { message: "Montant invalide." } })) }),
  )
  assert.equal(out.ok, false)
  assert.equal(out.success, null)
  assert.equal(out.error, "Montant invalide.")
})

test("le message du serveur prime sur le message de repli", async () => {
  const out = await performMutation(
    { url: "/api/v1/x", failure: "Repli." },
    deps({ fetch: async () => reponse(409, JSON.stringify({ error: { message: "Session déjà ouverte." } })) }),
  )
  assert.equal(out.error, "Session déjà ouverte.")
})

test("un échec muet porte quand même le code HTTP", async () => {
  // Sans corps, l'utilisateur mérite au moins de savoir qu'il s'est passé
  // quelque chose, et le développeur de savoir quoi.
  const out = await performMutation(
    { url: "/api/v1/x", failure: "Impossible d'enregistrer." },
    deps({ fetch: async () => reponse(500, null) }),
  )
  assert.equal(out.ok, false)
  assert.match(out.error ?? "", /Impossible d'enregistrer\./)
  assert.match(out.error ?? "", /500/)
})

test("sans message fourni, le repli par défaut s'applique", async () => {
  const out = await performMutation(
    { url: "/api/v1/x" },
    deps({ fetch: async () => reponse(503, null) }),
  )
  assert.match(out.error ?? "", new RegExp(DEFAULT_FAILURE.slice(0, 20)))
})

test("une panne réseau est un résultat, jamais une exception", async () => {
  // Obliger chaque appelant à entourer l'appel d'un try est exactement ce
  // qu'on supprime : la fonction ne doit pas pouvoir lever.
  const out = await performMutation(
    { url: "/api/v1/x" },
    deps({ fetch: async () => { throw new Error("Failed to fetch") } }),
  )
  assert.equal(out.ok, false)
  assert.equal(out.error, "Failed to fetch")
})

test("confirmation refusée : rien n'est envoyé, et ce n'est pas une erreur", async () => {
  let appels = 0
  const out = await performMutation(
    { url: "/api/v1/x", confirm: "Vraiment ?", success: "Fait." },
    deps({
      confirm: () => false,
      fetch: async () => { appels += 1; return reponse(200, "{}") },
    }),
  )
  assert.equal(appels, 0, "aucune requête ne doit partir")
  assert.equal(out.cancelled, true)
  assert.equal(out.ok, false)
  assert.equal(out.error, null, "un refus n'est pas une erreur à afficher")
  assert.equal(out.success, null)
})

test("confirmation acceptée : la requête part", async () => {
  let appels = 0
  await performMutation(
    { url: "/api/v1/x", confirm: "Vraiment ?" },
    deps({ confirm: () => true, fetch: async () => { appels += 1; return reponse(200, "{}") } }),
  )
  assert.equal(appels, 1)
})

test("le verbe et le corps arrivent au serveur sous la forme attendue", async () => {
  let vu: { url: string; options: RequestInit } | null = null
  await performMutation(
    { url: "/api/v1/services/7", method: "PATCH", body: { is_active: false } },
    deps({
      fetch: async (url, options) => {
        vu = { url, options }
        return reponse(200, "{}")
      },
    }),
  )
  assert.ok(vu)
  const appel = vu as unknown as { url: string; options: RequestInit }
  assert.equal(appel.url, "/api/v1/services/7")
  assert.equal(appel.options.method, "PATCH")
  assert.equal(appel.options.body, '{"is_active":false}', "le corps est sérialisé ici, pas chez l'appelant")
})

test("POST est le verbe par défaut", async () => {
  let methode: string | undefined
  await performMutation({ url: "/api/v1/x" }, deps({
    fetch: async (_u, o) => { methode = o.method as string; return reponse(200, "{}") },
  }))
  assert.equal(methode, "POST")
})

test("sans corps, aucun corps n'est envoyé", async () => {
  // `JSON.stringify(undefined)` vaut undefined : envoyer la clé quand même
  // ferait partir un corps vide sur un DELETE.
  let options: RequestInit | undefined
  await performMutation({ url: "/api/v1/x", method: "DELETE" }, deps({
    fetch: async (_u, o) => { options = o; return reponse(204, null) },
  }))
  assert.equal("body" in (options ?? {}), false)
})

test("une réponse sans contenu reste un succès", async () => {
  const out = await performMutation({ url: "/api/v1/x", method: "DELETE", success: "Supprimé." }, deps({
    fetch: async () => reponse(204, null),
  }))
  assert.equal(out.ok, true)
  assert.equal(out.data, null)
  assert.equal(out.success, "Supprimé.")
})

test("une réponse qui n'est pas du JSON ne disparaît pas en silence", async () => {
  const out = await performMutation({ url: "/api/v1/x" }, deps({
    fetch: async () => reponse(502, "<html>Bad Gateway</html>", false),
  }))
  assert.equal(out.ok, false)
  assert.match(out.error ?? "", /Bad Gateway/)
})

test("un corps non JSON très long est borné", async () => {
  const out = await performMutation({ url: "/api/v1/x" }, deps({
    fetch: async () => reponse(500, "x".repeat(5000), false),
  }))
  assert.ok((out.error ?? "").length <= 500, "on ne déverse pas une page entière")
})

test("readBody ne lit le corps qu'une fois", async () => {
  // Le piège exact rencontré dans ce dépôt : lire deux fois rend le corps
  // inutilisable. readBody doit donc rendre la donnée ET le message.
  const r = reponse(400, JSON.stringify({ error: { message: "Refusé." } }))
  const { data, message } = await readBody<{ error: { message: string } }>(r)
  assert.equal(message, "Refusé.")
  assert.ok(data)
  await assert.rejects(async () => {
    await r.json()
  }, "le corps est bien consommé : c'est pourquoi une seule lecture est permise")
})

test("les en-têtes passent au serveur, clé d'idempotence comprise", async () => {
  let vus: HeadersInit | undefined
  await performMutation(
    { url: "/api/v1/expenses", headers: { "Idempotency-Key": "abc-123" }, body: { amount: 500 } },
    deps({ fetch: async (_u, o) => { vus = o.headers; return reponse(201, "{}") } }),
  )
  assert.deepEqual(vus, { "Idempotency-Key": "abc-123" })
})

test("sans en-tête fourni, aucun en-tête n'est imposé", async () => {
  // apiFetch pose déjà Accept et Content-Type : on ne les écrase pas.
  let options: RequestInit | undefined
  await performMutation({ url: "/api/v1/x" }, deps({
    fetch: async (_u, o) => { options = o; return reponse(200, "{}") },
  }))
  assert.equal("headers" in (options ?? {}), false)
})

test("une confirmation asynchrone (dialogue) bloque l'envoi jusqu'à la réponse", async () => {
  // `ConfirmProvider` rend une promesse : l'écriture ne doit partir qu'une
  // fois l'utilisateur avoir répondu, et ne jamais partir s'il refuse.
  let appels = 0
  const refuse = await performMutation(
    { url: "/api/v1/x", confirm: "Annuler ce lavage ?" },
    deps({
      confirm: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return false
      },
      fetch: async () => {
        appels += 1
        return reponse(200, "{}")
      },
    }),
  )

  assert.equal(appels, 0)
  assert.equal(refuse.cancelled, true)
  assert.equal(refuse.error, null)

  const accepte = await performMutation(
    { url: "/api/v1/x", confirm: "Annuler ce lavage ?", success: "Lavage annulé." },
    deps({
      confirm: async () => true,
      fetch: async () => {
        appels += 1
        return reponse(200, "{}")
      },
    }),
  )

  assert.equal(appels, 1)
  assert.equal(accepte.ok, true)
  assert.equal(accepte.success, "Lavage annulé.")
})
