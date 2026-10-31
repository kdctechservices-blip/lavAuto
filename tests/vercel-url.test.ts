/**
 * Reconstitution du chemin derrière une fonction serverless.
 *
 * C'est la pièce décisive du déploiement Vercel : sur cette plateforme, une
 * fonction de `api/` ne reçoit pas l'URL demandée, et le fichier attrape-tout
 * `api/[...slug].ts` ne couvre qu'**un** segment. Les chemins plus profonds
 * (`/api/v1/auth/me`) tombaient sur le 404 générique de la plateforme sans
 * même appeler la fonction. Ces tests couvrent les quatre sources possibles —
 * réécriture explicite, `?path=`, segments dynamiques, URL d'origine — et le
 * cas où aucune ne donne de chemin.
 */
import test from "node:test"
import assert from "node:assert/strict"

import { API_PATH_PARAM, restoreApiPath } from "../server/vercel-url.ts"

test("les segments dynamiques reconstituent le chemin complet", () => {
  assert.deepEqual(restoreApiPath({ slug: ["v1", "auth", "me"], url: "/api" }), {
    url: "/api/v1/auth/me",
    source: "slug",
  })
})

test("un slug fourni en chaîne est accepté", () => {
  assert.equal(restoreApiPath({ slug: "v1/washes", url: "/api" }).url, "/api/v1/washes")
})

test("la chaîne de requête est conservée", () => {
  assert.equal(
    restoreApiPath({ slug: ["v1", "washes"], search: "?limit=2&plate=1234", url: "/api" }).url,
    "/api/v1/washes?limit=2&plate=1234",
  )
  // Sans `?` initial, la même chose.
  assert.equal(
    restoreApiPath({ slug: ["v1", "washes"], search: "limit=2", url: "/api" }).url,
    "/api/v1/washes?limit=2",
  )
})

test("les segments encodés sont décodés, les barres superflues ignorées", () => {
  assert.equal(
    restoreApiPath({ slug: ["/v1/", "vehicles", "1234%20AB%2001"], url: "/api" }).url,
    "/api/v1/vehicles/1234 AB 01",
  )
  // Un segment vide (double barre) ne doit pas produire de `//`.
  assert.equal(restoreApiPath({ slug: ["v1", "", "sites"], url: "/api" }).url, "/api/v1/sites")
})

test("sans segments, une URL déjà complète est conservée", () => {
  assert.deepEqual(restoreApiPath({ url: "/api/v1/plans" }), {
    url: "/api/v1/plans",
    source: "url",
  })
})

test("la racine /api reste la racine, elle ne devient pas une fausse route", () => {
  assert.deepEqual(restoreApiPath({ url: "/api" }), { url: "/api", source: "url" })
  assert.deepEqual(restoreApiPath({ url: "/api/" }), { url: "/api", source: "url" })
})

test("un chemin introuvable renvoie null plutôt qu'une route inventée", () => {
  assert.deepEqual(restoreApiPath({ url: "/" }), { url: null, source: "none" })
  assert.deepEqual(restoreApiPath({ slug: [], url: "" }), { url: null, source: "none" })
  assert.deepEqual(restoreApiPath({ url: undefined }), { url: null, source: "none" })
})

test("les segments priment sur l'URL de la fonction", () => {
  // Vercel fournit `/api` dans `req.url` : c'est bien le slug qui fait foi.
  assert.equal(restoreApiPath({ slug: ["v1", "console", "metrics"], url: "/api" }).source, "slug")
})

// ---------------------------------------------------------------------------
// La réécriture de `vercel.json` — la vraie correction de la panne
//
// Sur Vercel, `api/[...slug].ts` n'est pas un joker multi-segments : seuls les
// chemins à un segment atteignaient la fonction, tout le reste tombait sur le
// 404 générique de la plateforme. `vercel.json` envoie donc tout `/api/...`
// vers la fonction en plaçant le chemin dans `__washpilot_api_path`.
test("le chemin transmis par la réécriture est reconstitué, quelle que soit sa profondeur", () => {
  assert.deepEqual(
    restoreApiPath({ url: `/api?${API_PATH_PARAM}=v1/auth/me` }),
    { url: "/api/v1/auth/me", source: "rewrite" },
  )
  assert.deepEqual(
    restoreApiPath({ url: `/api?${API_PATH_PARAM}=v1/public/pricing` }),
    { url: "/api/v1/public/pricing", source: "rewrite" },
  )
  // Un seul segment passe aussi par la réécriture.
  assert.equal(restoreApiPath({ url: `/api?${API_PATH_PARAM}=healthz` }).url, "/api/healthz")
})

test("le paramètre de réécriture peut être fourni directement", () => {
  assert.deepEqual(restoreApiPath({ pathOverride: ["v1", "washes"], url: "/api" }), {
    url: "/api/v1/washes",
    source: "rewrite",
  })
})

test("les filtres du visiteur survivent à la réécriture, le paramètre interne disparaît", () => {
  assert.equal(
    restoreApiPath({ url: `/api?${API_PATH_PARAM}=v1/washes&limit=2&plate=1234` }).url,
    "/api/v1/washes?limit=2&plate=1234",
  )
  // Un encodage dans le chemin est décodé, sans casser la requête.
  assert.equal(
    restoreApiPath({ url: `/api?${API_PATH_PARAM}=v1/vehicles/1234%20AB%2001&limit=1` }).url,
    "/api/v1/vehicles/1234 AB 01?limit=1",
  )
})

test("le paramètre `path` ajouté par la plateforme est accepté", () => {
  // Vercel place parfois les segments de `:path*` dans `?path=` lui-même.
  assert.deepEqual(restoreApiPath({ url: "/api?path=v1/reports/summary&from=2026-10-01" }), {
    url: "/api/v1/reports/summary?from=2026-10-01",
    source: "rewrite",
  })
  // Mais un `?path=` métier n'est jamais pris pour la route quand elle est
  // déjà lisible dans l'URL.
  assert.equal(restoreApiPath({ url: "/api/v1/washes?path=export" }).url, "/api/v1/washes?path=export")
})

test("une réécriture vide ne fabrique pas de fausse route", () => {
  assert.deepEqual(restoreApiPath({ url: `/api?${API_PATH_PARAM}=` }), { url: "/api", source: "url" })
})

test("une URL malformée ne lève pas : elle ne trouve aucune route", () => {
  assert.deepEqual(restoreApiPath({ slug: ["v1", "%ZZ"], url: "/api" }).url, "/api/v1/%ZZ")
})
