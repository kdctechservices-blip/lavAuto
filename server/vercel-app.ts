/**
 * Application Express servie par une fonction serverless (Vercel).
 *
 * La pile est la même que celle de `server.ts` — mêmes routeurs, mêmes
 * middlewares de session, d'abonnement et de permissions — à trois exceptions
 * près, toutes imposées par l'environnement :
 *
 *   • **La base est initialisée paresseusement.** Une fonction serverless
 *     démarre à froid par requête : on ne peut pas initialiser le schéma au
 *     chargement du module sans payer ce coût à chaque instance, ni faire
 *     échouer le démarrage quand la base est momentanément indisponible. On
 *     garde donc une promesse unique, réutilisée tant que l'instance vit.
 *
 *   • **Le planificateur de relances ne tourne pas.** Un processus qui
 *     s'endort entre deux requêtes n'a pas d'horloge. Les relances sont
 *     déclenchées par un cron (voir la route `/api/v1/cron/reminders`).
 *
 *   • **Le corps de requête peut déjà être lu.** Vercel analyse le JSON avant
 *     d'appeler la fonction ; `express.json()` lirait alors un flux vide.
 *
 * Aucune de ces différences ne change une règle métier.
 */
import type { Express, NextFunction, Request, Response } from "express"
import express from "express"

import { apiErrorHandler, mountApi } from "./app.ts"
import { initDatabaseSchema, getPool, isDatabaseReady } from "./db.ts"
import { runSubscriptionReminders } from "./reminders.ts"
import { runMonitoringAlerts } from "./monitoring-alerts.ts"
import { runScheduledReconciliation } from "./reconciliation.ts"
import { env } from "./env.ts"
import { API_PATH_PARAM, restoreApiPath } from "./vercel-url.ts"

/**
 * Requête telle que la fournit le runtime Node de Vercel : `IncomingMessage`
 * enrichie de `query` (paramètres + segments dynamiques), `body` (JSON déjà
 * analysé) et `cookies`.
 */
export interface ServerlessRequest extends Request {
  query: Record<string, string | string[] | undefined>
  _body?: boolean
}

type DatabaseState =
  | { status: "ready" }
  | { status: "pending" }
  | { status: "failed"; message: string }

let database: Promise<DatabaseState> | null = null

/**
 * Initialise la base une seule fois par instance.
 *
 * Les erreurs sont **capturées**, jamais propagées au démarrage du module :
 * une fonction qui ne se charge pas renvoie une page d'erreur opaque de la
 * plateforme. On préfère une réponse JSON qui dit quoi corriger.
 */
function ensureDatabase(): Promise<DatabaseState> {
  database ??= initDatabaseSchema()
    .then<DatabaseState>(() => ({ status: "ready" }))
    .catch<DatabaseState>((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error("[vercel] Initialisation de la base impossible :", message)
      return { status: "failed", message }
    })
  return database
}

/** Réinitialise l'état de la base — utilisé par les tests. */
export function resetServerlessDatabase(): void {
  database = null
}

/**
 * Vercel peut fournir le corps déjà analysé. `express.json()` s'arrête net
 * quand `req._body` est vrai : on le positionne pour qu'il ne tente pas de
 * relire un flux consommé (ce qui produirait un corps vide et un 400 obscur
 * sur chaque écriture).
 */
function keepPreParsedBody(req: ServerlessRequest, _res: Response, next: NextFunction) {
  if (req.body !== undefined && req.body !== null) req._body = true
  next()
}

/**
 * Relances d'échéance, déclenchées par un cron plutôt que par une horloge.
 *
 * Protégée par `CRON_SECRET` : sans ce secret, la route n'existe pas. Un
 * déclencheur ouvert permettrait à n'importe qui d'envoyer des e-mails aux
 * clients et de saturer le journal des relances.
 */
function cronAuthorized(req: Request): boolean {
  const secret = env.CRON_SECRET.trim()
  if (!secret) return false
  const header = req.get("authorization") ?? ""
  const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : ""
  const supplied = bearer || (req.get("x-cron-secret") ?? "").trim()
  if (supplied.length !== secret.length) return false
  // Comparaison à temps constant : une comparaison naïve laisse fuir la
  // longueur du préfixe correct, ce qui suffit à retrouver un secret court.
  let diff = 0
  for (let i = 0; i < secret.length; i += 1) {
    diff |= secret.charCodeAt(i) ^ supplied.charCodeAt(i)
  }
  return diff === 0
}

function buildApp(): Express {
  const app = express()

  app.disable("x-powered-by")
  // Derrière le répartiteur de Vercel : sans cela `req.secure` est faux et les
  // cookies de session partiraient sans le drapeau `Secure`.
  app.set("trust proxy", 1)

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin")
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    next()
  })

  app.use((req, res, next) => {
    // Toute réponse API est propre à une session : jamais de cache partagé.
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "private, no-store")
    next()
  })

  app.use(keepPreParsedBody)
  app.use(express.json({ limit: "1mb" }))

  // Sonde de vie : elle ne touche pas la base, donc elle répond même quand
  // celle-ci est en panne — c'est justement ce qu'on veut savoir.
  app.get(["/healthz", "/api/healthz"], (_req, res) => {
    res.json({ status: "ok", database: isDatabaseReady() ? "ready" : "unavailable" })
  })

  app.all("/api/v1/cron/reminders", async (req, res) => {
    if (!env.CRON_SECRET.trim()) {
      res.status(503).json({
        error: { code: "cron_not_configured", message: "CRON_SECRET n'est pas défini : les relances ne peuvent pas être déclenchées." },
      })
      return
    }
    if (!cronAuthorized(req)) {
      res.status(401).json({ error: { code: "unauthorized", message: "Jeton de cron invalide." } })
      return
    }
    const pool = getPool()
    if (!pool) {
      res.status(503).json({ error: { code: "database_unavailable", message: "Base de données indisponible." } })
      return
    }
    try {
      const [outcomes, alerts, reconciliation] = await Promise.all([
        runSubscriptionReminders(pool),
        runMonitoringAlerts(pool),
        runScheduledReconciliation(pool),
      ])
      res.json({
        ran_at: new Date().toISOString(),
        processed: outcomes.length,
        outcomes,
        alerts,
        reconciliation,
      })
    } catch (error) {
      console.error("[vercel] Relances échouées :", error instanceof Error ? error.message : error)
      res.status(500).json({ error: { code: "reminders_failed", message: "Les relances n'ont pas pu être exécutées." } })
    }
  })

  // Tout chemin /api/* hors /api/v1 n'existe pas : même règle que le serveur
  // classique, pour que les deux déploiements se comportent pareil.
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/v1")) return next()
    res.status(404).json({ error: { code: "not_found", message: "Cette route API n'existe pas." } })
  })

  mountApi(app)
  app.use(apiErrorHandler)
  return app
}

let application: Express | null = null

/** L'application, construite une fois par instance serverless. */
export function getServerlessApp(): Express {
  application ??= buildApp()
  return application
}

/**
 * Attend que la base soit prête, sans jamais lever.
 *
 * Renvoie la raison de l'échec pour que l'appelant réponde un 503 explicite :
 * « base indisponible » est une information dont l'exploitant a besoin, alors
 * qu'une page d'erreur de plateforme ne dit rien.
 */
export async function awaitDatabase(): Promise<DatabaseState> {
  return ensureDatabase()
}

/**
 * Point d'entrée de la fonction de `api/`.
 *
 * Le chemin est reconstitué à partir de la réécriture (`__washpilot_api_path`),
 * des segments dynamiques historiques ou de l'URL reçue, la base est attendue,
 * puis la requête est confiée à Express. Une base indisponible donne un `503`
 * explicite : c'est le symptôme le plus fréquent d'un premier déploiement
 * (variable `DATABASE_URL` oubliée chez l'hébergeur).
 */
export async function handleServerlessRequest(
  req: ServerlessRequest,
  res: Response,
  slug?: string | string[],
): Promise<void> {
  const restored = restoreApiPath({
    slug: slug ?? req.query?.slug,
    pathOverride: req.query?.[API_PATH_PARAM],
    url: req.url,
  })
  if (!restored.url) {
    res.status(404).json({
      error: {
        code: "not_found",
        message: "Cette route API n'existe pas.",
      },
    })
    return
  }

  const state = await awaitDatabase()
  if (state.status !== "ready") {
    res.status(503).json({
      error: {
        code: "database_unavailable",
        message:
          "La base de données n'est pas joignable. Vérifiez DATABASE_URL dans les variables d'environnement du déploiement.",
        detail: state.status === "failed" ? state.message.slice(0, 300) : "initialisation en cours",
      },
    })
    return
  }

  req.url = restored.url
  getServerlessApp()(req, res)
}
