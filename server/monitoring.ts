/**
 * Surveillance technique.
 *
 * Jusqu'ici, une erreur 500 partait dans `console.error` et disparaissait.
 * Ce n'est pas une hypothèse : la route de suspension d'un membre a répondu
 * 500 pendant toute une version sans que personne ne le sache, et c'est un
 * test écrit après coup qui l'a révélée, pas la production. Un incident se
 * découvrait par l'appel d'un client.
 *
 * ## Deux registres, deux usages
 *
 * **`request_metrics`** agrège *toutes* les requêtes par tranches de cinq
 * minutes : route, méthode, classe de statut, nombre, durée cumulée et
 * maximale. Agréger plutôt qu'échantillonner donne des taux **exacts** — « 0,3 %
 * d'erreurs » est un comptage, pas une estimation — pour un volume borné par
 * le nombre de routes et non par le trafic. Une station très active ne fait
 * pas gonfler la table.
 *
 * **`error_events`** garde le détail de ce qui a mal tourné : pile d'appel,
 * corps de la requête, station, personne. Réservé aux pannes (5xx) et aux
 * requêtes anormalement lentes, parce que c'est là qu'on a besoin de
 * reproduire.
 *
 * ## Le corps des requêtes, et la seule chose qu'on refuse d'y mettre
 *
 * Enregistrer le corps a été demandé explicitement, en connaissance de cause :
 * il contient des montants et des noms de clients, et c'est ce qui permet de
 * reproduire un bug à l'identique. Soit.
 *
 * **Les identifiants de connexion en sont exclus.** Un corps de `POST
 * /auth/login` contient un mot de passe en clair ; l'écrire dans une table
 * que personne ne surveille, c'est transformer un outil de diagnostic en
 * fuite de données. Aucun mot de passe n'est jamais nécessaire pour
 * comprendre une erreur. `redactBody()` masque ces champs avant écriture, et
 * `tests/monitoring.test.ts` le vérifie sur chaque route d'authentification
 * réelle du produit.
 */

import type { Pool, PoolClient } from "pg"

type Queryable = Pick<Pool | PoolClient, "query">

/** Tranche d'agrégation. Cinq minutes : assez fin pour voir un pic, assez
 *  large pour que la table reste petite. */
export const BUCKET_MINUTES = 5

/** Au-delà, une requête est considérée anormalement lente et détaillée. */
export const SLOW_REQUEST_MS = 2000

/** Taille maximale du corps conservé, en caractères. */
export const MAX_BODY_CHARS = 4000

/** Rétention : les détails d'erreur vivent moins longtemps que les compteurs. */
export const ERROR_RETENTION_DAYS = 30
export const METRICS_RETENTION_DAYS = 90

// ---------------------------------------------------------------------------
// Masquage
// ---------------------------------------------------------------------------

/**
 * Champs dont la valeur n'est jamais écrite.
 *
 * Volontairement généreuse : le coût d'un masquage de trop est un diagnostic
 * un peu moins commode ; le coût d'un masquage manquant est un mot de passe
 * en clair dans une table de supervision.
 */
const SENSITIVE_KEYS = new Set([
  "password",
  "passwd",
  "pwd",
  "current_password",
  "new_password",
  "password_confirmation",
  "confirm_password",
  "pin",
  "cvv",
  "card_number",
  "secret",
  "apikey",
  "authorization",
  "cookie",
])

/** Un nom de champ désigne-t-il un identifiant de connexion ? */
export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase()
  if (SENSITIVE_KEYS.has(k)) return true
  return (
    k.includes("password") ||
    k.includes("passwd") ||
    k.includes("secret") ||
    k.endsWith("token") ||
    k.endsWith("_key")
  )
}

export const REDACTED = "[masqué]"

/**
 * Copie d'une valeur dont les identifiants de connexion sont remplacés.
 *
 * Récursive, profondeur bornée : un corps imbriqué à l'excès (ou cyclique par
 * accident) ne doit pas faire tomber le serveur **à l'intérieur du
 * gestionnaire d'erreurs**, là où plus rien ne rattraperait l'exception.
 */
export function redactBody(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[trop profond]"
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactBody(item, depth + 1))
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactBody(item, depth + 1)
    }
    return out
  }
  if (typeof value === "string" && value.length > MAX_BODY_CHARS) {
    return `${value.slice(0, MAX_BODY_CHARS)}… [tronqué]`
  }
  return value
}

/** Corps prêt à être stocké : masqué, puis borné en taille. */
export function prepareBody(body: unknown): unknown {
  if (body === undefined || body === null) return null
  if (typeof body === "object" && Object.keys(body as object).length === 0) return null
  const redacted = redactBody(body)
  const serialized = JSON.stringify(redacted)
  if (serialized && serialized.length > MAX_BODY_CHARS) {
    return { _tronque: true, _taille: serialized.length, apercu: serialized.slice(0, MAX_BODY_CHARS) }
  }
  return redacted
}

// ---------------------------------------------------------------------------
// Normalisation des routes
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REFERENCE_RE = /^[A-Z]{2}-[A-Z0-9]{6,}$/
const LONG_OPAQUE_RE = /^[A-Za-z0-9_-]{20,}$/

/**
 * Remplace les identifiants d'un chemin par des marqueurs.
 *
 * Sans cela, `/api/v1/washes/<uuid>` créerait une ligne de métrique par
 * lavage : la table de supervision grossirait avec le trafic exactement comme
 * les données qu'elle est censée surveiller, et aucun taux ne serait
 * calculable par route. La normalisation est donc ce qui rend l'agrégation
 * possible, pas une coquetterie.
 */
export function normalizeRoute(path: string): string {
  const clean = path.split("?")[0].replace(/\/+$/, "") || "/"
  const segments = clean.split("/").map((segment) => {
    if (!segment) return segment
    if (UUID_RE.test(segment)) return ":id"
    if (/^\d+$/.test(segment)) return ":n"
    if (REFERENCE_RE.test(segment)) return ":ref"
    // Jeton de session, de réinitialisation : opaque et sans intérêt ici.
    if (LONG_OPAQUE_RE.test(segment) && /\d/.test(segment)) return ":token"
    return segment
  })
  const normalized = segments.join("/") || "/"
  // Garde-fou de cardinalité : un chemin inattendu ne doit pas pouvoir
  // inventer des milliers de routes distinctes.
  return normalized.length > 120 ? `${normalized.slice(0, 120)}…` : normalized
}

/** 200 → "2xx". Regrouper par classe suffit pour un taux d'erreur. */
export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`
}

/** Début de la tranche de cinq minutes contenant `date`. */
export function bucketStart(date: Date): Date {
  const d = new Date(date)
  d.setUTCSeconds(0, 0)
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / BUCKET_MINUTES) * BUCKET_MINUTES)
  return d
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

export interface RequestObservation {
  method: string
  route: string
  status: number
  durationMs: number
  at?: Date
}

/**
 * Compte une requête dans sa tranche.
 *
 * `ON CONFLICT … DO UPDATE` : une seule requête SQL par appel HTTP, et aucune
 * course entre deux requêtes simultanées sur la même tranche.
 */
export async function recordRequest(
  pool: Queryable,
  observation: RequestObservation,
): Promise<void> {
  const bucket = bucketStart(observation.at ?? new Date())
  await pool.query(
    `INSERT INTO request_metrics
       (bucket_start, method, route, status_class, requests, total_duration_ms, max_duration_ms, slow_requests)
     VALUES($1,$2,$3,$4,1,$5,$6,$7)
     ON CONFLICT (bucket_start, method, route, status_class) DO UPDATE
       SET requests = request_metrics.requests + 1,
           total_duration_ms = request_metrics.total_duration_ms + EXCLUDED.total_duration_ms,
           max_duration_ms = greatest(request_metrics.max_duration_ms, EXCLUDED.max_duration_ms),
           slow_requests = request_metrics.slow_requests + EXCLUDED.slow_requests`,
    [
      bucket,
      observation.method,
      observation.route,
      statusClass(observation.status),
      Math.round(observation.durationMs),
      Math.round(observation.durationMs),
      observation.durationMs >= SLOW_REQUEST_MS ? 1 : 0,
    ],
  )
}

export interface ErrorObservation {
  method: string
  route: string
  path: string
  status: number
  code: string
  message: string
  stack?: string | null
  durationMs: number
  organizationId?: string | null
  userId?: string | null
  operatorEmail?: string | null
  body?: unknown
  kind?: "error" | "slow"
}

/** Enregistre le détail d'une panne ou d'une lenteur. */
export async function recordErrorEvent(
  pool: Queryable,
  observation: ErrorObservation,
): Promise<void> {
  await pool.query(
    `INSERT INTO error_events
       (kind, method, route, path, status, code, message, stack, duration_ms,
        organization_id, user_id, operator_email, request_body)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::uuid,$11::uuid,$12,$13::jsonb)`,
    [
      observation.kind ?? "error",
      observation.method,
      observation.route,
      observation.path.slice(0, 300),
      observation.status,
      observation.code,
      observation.message.slice(0, 1000),
      observation.stack ? observation.stack.slice(0, 4000) : null,
      Math.round(observation.durationMs),
      observation.organizationId ?? null,
      observation.userId ?? null,
      observation.operatorEmail ?? null,
      JSON.stringify(prepareBody(observation.body)),
    ],
  )
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/** Vue d'ensemble : taux, latence, routes les plus en souffrance. */
export async function monitoringOverview(
  pool: Queryable,
  options: { hours?: number } = {},
) {
  const hours = Math.min(Math.max(options.hours ?? 24, 1), 24 * 30)

  const totals = await pool.query(
    `SELECT coalesce(sum(requests),0)::bigint AS requests,
            coalesce(sum(requests) FILTER (WHERE status_class = '5xx'),0)::bigint AS server_errors,
            coalesce(sum(requests) FILTER (WHERE status_class = '4xx'),0)::bigint AS client_errors,
            coalesce(sum(slow_requests),0)::bigint AS slow,
            coalesce(sum(total_duration_ms),0)::bigint AS total_duration_ms,
            coalesce(max(max_duration_ms),0)::int AS max_duration_ms
       FROM request_metrics
      WHERE bucket_start >= now() - make_interval(hours => $1)`,
    [hours],
  )

  const series = await pool.query(
    `SELECT bucket_start,
            sum(requests)::int AS requests,
            coalesce(sum(requests) FILTER (WHERE status_class = '5xx'),0)::int AS errors,
            coalesce(sum(slow_requests),0)::int AS slow,
            CASE WHEN sum(requests) > 0
                 THEN round(sum(total_duration_ms)::numeric / sum(requests))::int
                 ELSE 0 END AS avg_duration_ms
       FROM request_metrics
      WHERE bucket_start >= now() - make_interval(hours => $1)
      GROUP BY bucket_start ORDER BY bucket_start ASC`,
    [hours],
  )

  // Les routes qui échouent, puis celles qui traînent. Deux questions
  // différentes : « qu'est-ce qui est cassé » et « qu'est-ce qui rame ».
  const failing = await pool.query(
    `SELECT method, route,
            sum(requests)::int AS requests,
            coalesce(sum(requests) FILTER (WHERE status_class = '5xx'),0)::int AS errors
       FROM request_metrics
      WHERE bucket_start >= now() - make_interval(hours => $1)
      GROUP BY method, route
     HAVING coalesce(sum(requests) FILTER (WHERE status_class = '5xx'),0) > 0
      ORDER BY errors DESC LIMIT 10`,
    [hours],
  )

  const slowest = await pool.query(
    `SELECT method, route,
            sum(requests)::int AS requests,
            round(sum(total_duration_ms)::numeric / nullif(sum(requests),0))::int AS avg_duration_ms,
            max(max_duration_ms)::int AS max_duration_ms
       FROM request_metrics
      WHERE bucket_start >= now() - make_interval(hours => $1)
      GROUP BY method, route
     HAVING sum(requests) >= 5
      ORDER BY avg_duration_ms DESC NULLS LAST LIMIT 10`,
    [hours],
  )

  const row = totals.rows[0]
  const requests = Number(row.requests)
  const serverErrors = Number(row.server_errors)

  return {
    window_hours: hours,
    totals: {
      requests,
      server_errors: serverErrors,
      client_errors: Number(row.client_errors),
      slow: Number(row.slow),
      // Le chiffre qui dit si le service va bien. Arrondi à deux décimales :
      // en dessous, « 0 % » laisserait croire qu'il n'y a aucune erreur.
      error_rate: requests > 0 ? Math.round((serverErrors / requests) * 10000) / 100 : 0,
      avg_duration_ms: requests > 0 ? Math.round(Number(row.total_duration_ms) / requests) : 0,
      max_duration_ms: Number(row.max_duration_ms),
    },
    series: series.rows,
    failing_routes: failing.rows,
    slowest_routes: slowest.rows,
    server_time: new Date().toISOString(),
  }
}

/** Les incidents détaillés, du plus récent au plus ancien. */
export async function listErrorEvents(
  pool: Queryable,
  options: { kind?: string | null; route?: string | null; limit?: number } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const values: unknown[] = []
  const conditions: string[] = []
  if (options.kind) {
    values.push(options.kind)
    conditions.push(`e.kind = $${values.length}`)
  }
  if (options.route) {
    values.push(options.route)
    conditions.push(`e.route = $${values.length}`)
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""

  const q = await pool.query(
    `SELECT e.id, e.kind, e.method, e.route, e.path, e.status, e.code, e.message,
            e.duration_ms, e.organization_id, e.user_id, e.operator_email, e.occurred_at,
            o.name AS organization_name,
            nullif(trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')), '') AS user_name,
            u.email AS user_email
       FROM error_events e
       LEFT JOIN organizations o ON o.id = e.organization_id
       LEFT JOIN users u ON u.id = e.user_id
       ${where}
      ORDER BY e.occurred_at DESC LIMIT ${limit}`,
    values,
  )
  return q.rows
}

/** Un incident, avec son corps de requête et sa pile d'appel. */
export async function getErrorEvent(pool: Queryable, id: string) {
  const q = await pool.query(
    `SELECT e.*, o.name AS organization_name, u.email AS user_email
       FROM error_events e
       LEFT JOIN organizations o ON o.id = e.organization_id
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.id = $1::uuid`,
    [id],
  )
  return q.rows[0] ?? null
}

/**
 * Regroupe les incidents récents par route et message.
 *
 * Vingt fois la même panne est **un** problème, pas vingt. Sans ce
 * regroupement, une erreur en boucle noierait toutes les autres et la liste
 * deviendrait illisible au moment précis où elle servirait le plus.
 */
export async function errorGroups(pool: Queryable, options: { hours?: number } = {}) {
  const hours = Math.min(Math.max(options.hours ?? 24, 1), 24 * 30)
  const q = await pool.query(
    `SELECT method, route, code, message,
            count(*)::int AS occurrences,
            count(DISTINCT organization_id)::int AS organizations,
            min(occurred_at) AS first_seen,
            max(occurred_at) AS last_seen,
            (array_agg(id ORDER BY occurred_at DESC))[1] AS latest_id
       FROM error_events
      WHERE occurred_at >= now() - make_interval(hours => $1) AND kind = 'error'
      GROUP BY method, route, code, message
      ORDER BY occurrences DESC, last_seen DESC LIMIT 50`,
    [hours],
  )
  return q.rows
}

/**
 * Purge les enregistrements expirés.
 *
 * Une table de supervision qui grossit sans fin finit par être le problème
 * qu'elle devait signaler.
 */
export async function purgeMonitoring(pool: Queryable): Promise<{ errors: number; metrics: number }> {
  const errors = await pool.query(
    `DELETE FROM error_events WHERE occurred_at < now() - make_interval(days => $1)`,
    [ERROR_RETENTION_DAYS],
  )
  const metrics = await pool.query(
    `DELETE FROM request_metrics WHERE bucket_start < now() - make_interval(days => $1)`,
    [METRICS_RETENTION_DAYS],
  )
  return { errors: errors.rowCount ?? 0, metrics: metrics.rowCount ?? 0 }
}
