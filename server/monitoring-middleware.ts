/**
 * Chronométrage et capture des incidents.
 *
 * Trois règles qui gouvernent tout ce fichier :
 *
 * 1. **La surveillance ne doit jamais casser ce qu'elle surveille.** Chaque
 *    écriture est détachée de la réponse et avale ses propres erreurs. Une
 *    base saturée doit dégrader la supervision, pas l'application.
 * 2. **Rien n'est écrit avant que le client ait sa réponse.** Tout passe par
 *    l'évènement `finish`, donc aucune latence ajoutée.
 * 3. **Un incident n'est enregistré qu'une fois.** Une panne lente ne doit pas
 *    apparaître à la fois comme erreur et comme lenteur.
 */

import type { NextFunction, Request, Response } from "express"
import { getPool, isDatabaseReady } from "./db.ts"
import { runWithoutTenant } from "./tenant-context.ts"
import {
  SLOW_REQUEST_MS,
  normalizeRoute,
  recordErrorEvent,
  recordRequest,
  type ErrorObservation,
} from "./monitoring.ts"

/** Marqueurs internes posés sur la requête, invisibles du reste du code. */
const START = Symbol("monitoring.start")
const LOGGED = Symbol("monitoring.logged")

interface Tracked extends Request {
  [START]?: bigint
  [LOGGED]?: boolean
}

/**
 * Gabarit de la route plutôt que chemin littéral.
 *
 * Express expose `req.route.path` une fois la route résolue : c'est la source
 * la plus fidèle (`/washes/:id` tel qu'il est déclaré). Quand la requête n'a
 * atteint aucune route — un 404, ou un rejet par un middleware amont —, on
 * retombe sur la normalisation par motif.
 */
export function routeTemplate(req: Request): string {
  const declared = (req as Request & { route?: { path?: string } }).route?.path
  if (declared) {
    const base = req.baseUrl || ""
    const joined = `${base}${declared === "/" ? "" : declared}` || "/"
    return normalizeRoute(joined)
  }
  return normalizeRoute(req.originalUrl || req.url || "/")
}

function durationMs(req: Tracked): number {
  const start = req[START]
  if (start === undefined) return 0
  return Number(process.hrtime.bigint() - start) / 1_000_000
}

/**
 * Écriture détachée : la supervision n'a pas le droit de faire tomber l'API.
 *
 * Le travail s'exécute **hors du contexte de locataire** : `finish` et les
 * erreurs arrivent depuis une requête de station, mais les métriques et
 * incidents sont des écritures système (multi-stations, tables sans RLS).
 * Sans cette sortie, elles passeraient — à tort — sous le rôle applicatif.
 */
function detach(run: () => Promise<unknown>): void {
  void runWithoutTenant(run).catch((error) => {
    console.error("[surveillance] enregistrement impossible:", error instanceof Error ? error.message : error)
  })
}

/**
 * Enregistre l'incident lié à la requête courante.
 *
 * Exporté pour que le gestionnaire d'erreurs puisse l'appeler avec la vraie
 * exception — pile d'appel comprise, qui n'est plus disponible depuis
 * `finish`.
 */
export function captureIncident(
  req: Request,
  observation: Omit<ErrorObservation, "method" | "route" | "path" | "durationMs">,
): void {
  const tracked = req as Tracked
  if (tracked[LOGGED]) return
  tracked[LOGGED] = true
  if (!isDatabaseReady()) return
  const pool = getPool()
  if (!pool) return

  detach(() =>
    recordErrorEvent(pool, {
      ...observation,
      method: req.method,
      route: routeTemplate(req),
      path: req.originalUrl || req.url || "/",
      durationMs: durationMs(tracked),
      organizationId: observation.organizationId ?? req.tenant?.organizationId ?? null,
      userId: observation.userId ?? req.tenant?.userId ?? req.auth?.userId ?? null,
      operatorEmail: observation.operatorEmail ?? req.operator?.email ?? null,
      body: observation.body ?? req.body,
    }),
  )
}

/**
 * Middleware de chronométrage, à monter avant toutes les routes.
 *
 * Il compte *tout* le trafic, et pas seulement les incidents : sans
 * dénominateur, « douze erreurs » ne veut rien dire. Douze erreurs sur douze
 * requêtes et douze sur cent mille décrivent deux situations sans rapport.
 */
export function monitorRequests() {
  return function monitoring(req: Request, res: Response, next: NextFunction) {
    const tracked = req as Tracked
    tracked[START] = process.hrtime.bigint()

    res.on("finish", () => {
      const elapsed = durationMs(tracked)
      if (!isDatabaseReady()) return
      const pool = getPool()
      if (!pool) return

      const route = routeTemplate(req)
      detach(() =>
        recordRequest(pool, {
          method: req.method,
          route,
          status: res.statusCode,
          durationMs: elapsed,
        }),
      )

      // Filet : une panne qui ne passe pas par le gestionnaire d'erreurs
      // (une route qui renvoie 500 elle-même) laisserait sinon un compteur
      // sans aucun detail exploitable.
      if (res.statusCode >= 500 && !tracked[LOGGED]) {
        captureIncident(req, {
          status: res.statusCode,
          code: "unhandled",
          message: "Réponse 5xx émise sans passer par le gestionnaire d'erreurs.",
          stack: null,
        })
        return
      }

      // Une requête lente qui a réussi reste un incident : c'est elle qu'on
      // retrouvera derriere « l'application rame le vendredi soir ».
      if (elapsed >= SLOW_REQUEST_MS && !tracked[LOGGED]) {
        captureIncident(req, {
          kind: "slow",
          status: res.statusCode,
          code: "slow_request",
          message: `Requête anormalement lente (${Math.round(elapsed)} ms).`,
          stack: null,
        })
      }
    })

    next()
  }
}
