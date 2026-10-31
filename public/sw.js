/*
 * Service worker de WashPilot CI — écrit à la main.
 *
 * Pas de Workbox : une station ivoirienne télécharge cette application en 3G,
 * et le produit s'interdit toute dépendance supplémentaire. Ce fichier est
 * volontairement court et lisible plutôt que générique.
 *
 * Ce qu'il permet, concrètement : le caissier ouvre l'application alors que
 * le réseau est tombé, et l'écran s'affiche au lieu du dinosaure du
 * navigateur. Les prestations et les tarifs sont là, puisqu'ils ont été vus
 * plus tôt dans la journée. Il peut enregistrer ses lavages — c'est la file
 * d'attente, côté application, qui s'en charge (src/lib/offline-queue.ts).
 *
 * ---------------------------------------------------------------------------
 * Trois stratégies, une par nature de ressource
 * ---------------------------------------------------------------------------
 *
 *   • **Navigation** (ouvrir l'application) : réseau d'abord, cache ensuite.
 *     L'inverse servirait une version périmée à quelqu'un qui a du réseau.
 *
 *   • **Fichiers de l'application** (JS, CSS, images) : cache d'abord. Leurs
 *     noms contiennent une empreinte qui change à chaque version : ce qui est
 *     en cache sous ce nom-là ne sera jamais périmé.
 *
 *   • **Lectures d'API du catalogue** : réseau d'abord, repli sur la dernière
 *     réponse connue. C'est ce qui permet de composer un lavage hors ligne.
 *     La liste est courte et fermée — on ne met en cache que ce qui est
 *     nécessaire à l'encaissement.
 *
 * Ce qui n'est JAMAIS mis en cache, et c'est délibéré :
 *   • toute écriture (POST, PATCH, DELETE) — elle passe par la file ;
 *   • les rapports, les revenus, le journal : un chiffre d'affaires périmé
 *     affiché sans avertissement est pire qu'une page qui dit « hors ligne » ;
 *   • la console de l'éditeur, qui n'a rien à faire sur le téléphone d'une
 *     station.
 */

// v2 : les fichiers dont le téléchargement échoue obtiennent désormais une
// réponse explicite au lieu d'une promesse rejetée (voir assetCacheFirst).
// v3 : une page d'erreur de la plateforme (504 pendant un déploiement) n'est
// plus enregistrée comme coque de l'application ; la montée de version purge
// les caches où elle aurait pu l'être.
// Changer la version purge les caches des versions précédentes à l'activation.
const VERSION = "v3"
const SHELL_CACHE = `washpilot-shell-${VERSION}`
const ASSET_CACHE = `washpilot-assets-${VERSION}`
const API_CACHE = `washpilot-api-${VERSION}`

/** Le strict minimum pour que l'application s'ouvre sans réseau. */
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/brand/icon-192.png"]

/**
 * Lectures d'API conservées pour l'encaissement hors ligne.
 *
 * Exactement ce dont l'écran « nouveau lavage » a besoin : où, quel véhicule,
 * quelle prestation, quel laveur. Rien de plus.
 */
const CACHEABLE_API = [
  "/api/v1/services",
  "/api/v1/sites",
  "/api/v1/vehicle-categories",
  "/api/v1/workers",
]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // `addAll` échoue en bloc si une seule entrée manque : on tolère les
      // absences plutôt que de laisser l'installation échouer entièrement.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("activate", (event) => {
  const keep = new Set([SHELL_CACHE, ASSET_CACHE, API_CACHE])
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  )
})

/**
 * Vider les données mises en cache.
 *
 * Appelé à la déconnexion. Sans cela, le catalogue et les tarifs d'une
 * station resteraient lisibles sur l'appareil après le départ du caissier —
 * sur un téléphone partagé, ce n'est pas acceptable.
 */
self.addEventListener("message", (event) => {
  if (event.data === "clear-api-cache") {
    event.waitUntil(caches.delete(API_CACHE))
  }
})

function isCacheableApi(url) {
  return CACHEABLE_API.some((path) => url.pathname === path)
}

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return

  const url = new URL(request.url)
  // On ne se mêle pas de ce qui n'est pas à nous : polices, images externes,
  // et tout ce qui vit sur une autre origine.
  if (url.origin !== self.location.origin) return
  // La console de l'éditeur ne doit rien laisser sur l'appareil.
  if (url.pathname.startsWith("/console")) return

  if (url.pathname.startsWith("/api/")) {
    if (isCacheableApi(url)) event.respondWith(apiNetworkFirst(request))
    return
  }

  if (request.mode === "navigate") {
    event.respondWith(navigationNetworkFirst(request))
    return
  }

  event.respondWith(assetCacheFirst(request))
})

async function navigationNetworkFirst(request) {
  const cached = (await caches.match("/index.html")) || (await caches.match("/"))
  try {
    const response = await fetch(request)
    // On ne met en cache que la vraie application. Une page d'erreur de la
    // plateforme (502, 504 pendant un déploiement) enregistrée comme
    // `/index.html` condamnerait l'appareil à réafficher cette page à chaque
    // ouverture hors ligne — et même en ligne, tant que le cache n'est pas
    // vidé. Ce défaut a été constaté en production : après un 504, la station
    // ouvrait l'application sur une page « Gateway Timeout ».
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE)
      cache.put("/index.html", response.clone())
      return response
    }
    // Une réponse en erreur n'apporte rien à l'utilisateur : la coque en
    // cache est plus utile qu'un 504, et elle est la même application.
    return cached ?? response
  } catch {
    if (cached) return cached
    return new Response(
      "<!doctype html><meta charset=utf-8><title>Hors connexion</title>" +
        "<p style='font-family:system-ui;padding:2rem'>Application indisponible hors connexion " +
        "pour le moment. Rouvrez-la une fois connecté : elle restera ensuite utilisable sans réseau.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    )
  }
}

async function assetCacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) return cached
  try {
    const response = await fetch(request)
    if (response.ok && response.type === "basic") {
      const cache = await caches.open(ASSET_CACHE)
      cache.put(request, response.clone())
    }
    return response
  } catch {
    // Pas de repli possible pour un fichier jamais vu : le réseau a échoué et
    // le cache ne l'a jamais vu. On renvoie une réponse explicite plutôt que
    // de laisser la promesse se rejeter : un rejet ici apparaît dans la
    // console comme « TypeError: Failed to fetch » sans le moindre contexte,
    // et l'écran reste blanc sans que personne ne sache pourquoi.
    return new Response("Ressource indisponible hors connexion.", {
      status: 504,
      statusText: "Gateway Timeout",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    })
  }
}

async function apiNetworkFirst(request) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      const cache = await caches.open(API_CACHE)
      cache.put(request, response.clone())
    }
    return response
  } catch {
    const cached = await caches.match(request)
    if (cached) return cached
    // Même raison que pour les fichiers : une réponse lisible vaut mieux
    // qu'une promesse rejetée. Le client d'API traduit ce code en message.
    return new Response(
      JSON.stringify({
        error: {
          code: "network_unavailable",
          message: "Réseau indisponible et aucune copie en cache pour cette lecture.",
        },
      }),
      {
        status: 504,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    )
  }
}
