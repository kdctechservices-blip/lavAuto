/**
 * Retrouver le chemin d'origine d'une requête API derrière une fonction
 * serverless.
 *
 * Le problème, constaté en production : sur Vercel, une fonction placée dans
 * `api/` ne reçoit pas l'URL complète. Pire, le nom de fichier attrape-tout
 * `api/[...slug].ts` n'y est **pas** traité comme un vrai joker multi-segments :
 * la plateforme ne génère qu'une route d'un seul segment (`/api/healthz`,
 * `/api/v1`), et tout ce qui est plus profond (`/api/v1/auth/me`,
 * `/api/v1/public/pricing`) tombe sur son 404 générique **sans jamais appeler
 * la fonction**. C'est exactement la panne observée : les routes à un segment
 * répondaient, toutes les autres renvoyaient 404.
 *
 * La correction ne peut donc pas venir du nom du fichier. `vercel.json` déclare
 * une réécriture explicite qui envoie tout `/api/...` vers une fonction unique,
 * en plaçant le chemin dans un paramètre de requête :
 *
 *   { "source": "/api/:path*", "destination": "/api?__washpilot_api_path=:path*" }
 *
 * Ce module reconstitue le chemin à partir de ce paramètre. Il accepte aussi
 * les deux autres sources possibles, parce que le comportement de la
 * plateforme n'est pas garanti sur ce point d'un projet à l'autre :
 *
 *   1. `__washpilot_api_path` — notre réécriture explicite (source fiable) ;
 *   2. `req.query.slug` — l'ancienne route attrape-tout, conservée pour que le
 *      code fonctionne encore si un déploiement la sert ;
 *   3. `req.url` — quand la plateforme transmet l'URL d'origine intacte ;
 *   4. `?path=` — paramètre que Vercel ajoute de lui-même quand un segment
 *      nommé `:path*` n'est pas réutilisé dans la destination.
 *
 * Cette fonction est pure pour une raison simple : c'est de la logique de
 * routage. Une erreur ici rend l'API entière muette, et il faut pouvoir la
 * vérifier sans déployer (`tests/vercel-url.test.ts`).
 */

/** Nom du paramètre posé par la réécriture de `vercel.json`. */
export const API_PATH_PARAM = "__washpilot_api_path"

/** Segments tels que Vercel les fournit (`string`, tableau, ou absents). */
export type SlugInput = string | string[] | undefined | null

export interface RestoreInput {
  /** Segments après `/api`, issus de l'ancienne route dynamique. */
  slug?: SlugInput
  /** Chaîne de requête brute (`?limit=2`), si connue. */
  search?: string
  /** URL reçue par la fonction. */
  url?: string
  /** Chemin transmis par la réécriture (`__washpilot_api_path`). */
  pathOverride?: SlugInput
}

export interface RestoredPath {
  /** URL complète à donner à Express, ou `null` si le chemin est introuvable. */
  url: string | null
  /** D'où vient le chemin — lisible dans les journaux d'incident. */
  source: "rewrite" | "slug" | "url" | "none"
}

/**
 * Décode un segment sans jamais lever.
 *
 * Une URL malformée (`%ZZ`) ferait lever `decodeURIComponent` : la fonction
 * serverless échouerait alors sur une 500 opaque au lieu de répondre son 404
 * habituel. Un identifiant illisible ne trouve simplement aucune route.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Normalise les segments : ni vide, ni barre oblique, ni préfixe `api`. */
function normalizeSegments(slug: SlugInput): string[] {
  const raw = Array.isArray(slug) ? slug : typeof slug === "string" ? slug.split("/") : []
  return raw
    .map((segment) => decodeSegment(String(segment)).replace(/^\/+|\/+$/g, ""))
    .filter((segment) => segment.length > 0)
}

function withSearch(path: string, search: string): string {
  if (!search) return path
  const query = search.startsWith("?") ? search : `?${search}`
  return query === "?" ? path : `${path}${query}`
}

/** Sépare une URL brute en chemin et chaîne de requête. */
function splitUrl(raw: string): { urlPath: string; search: string } {
  const index = raw.indexOf("?")
  if (index === -1) return { urlPath: raw, search: "" }
  return { urlPath: raw.slice(0, index), search: raw.slice(index) }
}

function parseSearch(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
}

function formatSearch(params: URLSearchParams): string {
  const query = params.toString()
  return query ? `?${query}` : ""
}

/**
 * Reconstruit `/api/<segments><query>`.
 *
 * Ordre de préférence : la réécriture explicite, puis les segments dynamiques,
 * puis l'URL si elle porte déjà le chemin, puis le paramètre `path` ajouté par
 * la plateforme. Si aucune source ne donne de chemin, on renvoie `null` plutôt
 * qu'un `/api` nu : mieux vaut un 404 explicite qu'une requête servie sur la
 * mauvaise route.
 *
 * Les paramètres internes (`__washpilot_api_path`, et `path` lorsqu'il a servi
 * de chemin) sont retirés de la chaîne de requête : ils ne doivent jamais
 * atteindre les routeurs métier. Les autres — `limit`, `from`, `to`, filtres —
 * sont conservés, sans quoi la pagination et les rapports perdraient leur sens.
 */
export function restoreApiPath(input: RestoreInput): RestoredPath {
  const rawUrl = (input.url ?? "").trim()
  const { urlPath, search: urlSearch } = splitUrl(rawUrl)
  const params = parseSearch(input.search ?? urlSearch)

  // 1. Chemin fourni explicitement par la réécriture de `vercel.json`.
  const fromRewrite = normalizeSegments(input.pathOverride ?? params.get(API_PATH_PARAM))
  params.delete(API_PATH_PARAM)
  if (fromRewrite.length > 0) {
    return { url: withSearch(`/api/${fromRewrite.join("/")}`, formatSearch(params)), source: "rewrite" }
  }

  // 2. Ancienne route attrape-tout (`req.query.slug`).
  const segments = normalizeSegments(input.slug)
  if (segments.length > 0) {
    return { url: withSearch(`/api/${segments.join("/")}`, formatSearch(params)), source: "slug" }
  }

  // 3. URL d'origine intacte.
  if (urlPath.startsWith("/api/") && urlPath.length > "/api/".length) {
    return { url: withSearch(urlPath, formatSearch(params)), source: "url" }
  }

  // 4. La plateforme a remplacé l'URL par celle de la destination et laissé la
  //    suite du chemin dans `?path=`. On ne s'en sert que si l'URL ne porte plus
  //    le chemin (sinon un `?path=` métier serait pris pour la route).
  const autoPath = normalizeSegments(params.get("path"))
  if ((urlPath === "/api" || urlPath === "/api/") && autoPath.length > 0) {
    params.delete("path")
    return { url: withSearch(`/api/${autoPath.join("/")}`, formatSearch(params)), source: "rewrite" }
  }

  // 5. Racine de l'API : légitime, elle répond un 404 JSON explicite.
  if (urlPath === "/api" || urlPath === "/api/") {
    return { url: withSearch("/api", formatSearch(params)), source: "url" }
  }

  return { url: null, source: "none" }
}
