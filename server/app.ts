import express from "express"
import type { Express, NextFunction, Request, Response } from "express"
import { HttpError, requireSession } from "./auth.ts"
import { requireTenantContext } from "./tenant.ts"
import { createAuthRouter } from "./auth-router.ts"
import { createOnboardingRouter } from "./onboarding.ts"
import { createApiRouter } from "./api.ts"
import { createOperationsRouter } from "./operations.ts"
import { createUtilitiesRouter } from "./utilities.ts"
import { createUtilityInsightsRouter } from "./utility-insights.ts"
import { createTeamRouter } from "./team.ts"
import { createReportsRouter } from "./reports.ts"
import { createSubscriptionRouter } from "./subscription.ts"
import { createPaymentsRouter } from "./payments.ts"
import { createBackupRouter } from "./backup.ts"
import { createSupportRouter } from "./support.ts"
import { createCheckoutRouter } from "./checkout.ts"
import { createAccessRouter } from "./access.ts"
import { createNotificationsRouter } from "./notifications.ts"
import { createAuditLogRouter } from "./audit-log.ts"
import { createStockRouter } from "./stock.ts"
import { createPurchaseRouter } from "./purchases.ts"
import { createAttendanceRouter } from "./attendance.ts"
import { createAdminRouter } from "./admin.ts"
import { createConsoleAuthRouter, requireOperator } from "./console-auth.ts"
import { createPublicPricingRouter } from "./public-pricing.ts"
import { attachSubscription, blockWritesWhenReadOnly } from "./entitlements.ts"
import { captureIncident, monitorRequests } from "./monitoring-middleware.ts"

// ---------------------------------------------------------------------------
// Montage de l'API
//
// Extrait de server.ts pour que les tests d'autorisation exercent exactement
// la même pile de middlewares que la production : session → appartenance →
// abonnement → permissions. Tester une pile reconstituée à la main ne
// prouverait rien.
// ---------------------------------------------------------------------------

/**
 * Ordre des contrôles, du plus général au plus précis :
 *   1. `requireSession`        — qui êtes-vous ? (401 sinon)
 *   2. `requireTenantContext`  — de quelle station, avec quel rôle, et le
 *                                compte est-il toujours actif ? (403 sinon)
 *   3. `attachSubscription`    — que permet le forfait ?
 *   4. `requirePermission`     — posé par chaque route : cette personne a-t-elle
 *                                le droit ? (403 `forbidden` sinon)
 *   5. `requireCapability`     — posé par chaque route : l'organisation a-t-elle
 *                                acheté cette fonction ? (402
 *                                `plan_upgrade_required` sinon)
 *
 * L'ordre entre 4 et 5 n'est pas interchangeable. Le rôle se vérifie **avant**
 * le forfait : proposer de passer au forfait supérieur à un caissier qui n'aura
 * de toute façon pas le droit d'agir l'enverrait demander une dépense inutile à
 * son patron. Un refus de rôle est définitif pour cette personne ; un refus de
 * forfait est une invitation à acheter, et ne doit s'afficher que quand l'achat
 * débloquerait réellement quelque chose.
 */
export function mountApi(app: Express) {
  // Chronométrage de tout le trafic, console comprise. En tête, pour qu'un
  // rejet par un middleware amont soit compté lui aussi : une vague de 401
  // est un signal, et elle serait invisible depuis les routes.
  app.use(monitorRequests())

  app.use("/api/v1/auth", createAuthRouter())

  // -------------------------------------------------------------------------
  // Console de l'éditeur — montée AVANT `requireSession`, et c'est le point
  // central de la séparation.
  //
  // Rien de ce qui suit ne s'applique ici : ni la session de station, ni le
  // contexte de locataire, ni l'abonnement. La console a son propre cookie,
  // ses propres comptes, sa propre table de sessions. Une session de station,
  // même celle du créateur de l'application, ne franchit pas cette ligne —
  // `requireOperator` ne lit tout simplement pas ce cookie-là.
  //
  // C'est aussi la seule surface qui traverse volontairement l'isolation
  // entre clients : pour activer le forfait d'un client, il faut écrire chez
  // lui. La placer ici rend ce franchissement lisible au montage, plutôt que
  // caché dans une route.
  // -------------------------------------------------------------------------
  app.use("/api/v1/console/auth", createConsoleAuthRouter())
  app.use("/api/v1/console", requireOperator, createAdminRouter())

  // Grille tarifaire publique — avant `requireSession`, comme la console et
  // pour la raison inverse : ce que lit un visiteur sans compte.
  app.use("/api/v1/public", createPublicPricingRouter())

  app.use("/api/v1", requireSession)
  app.use("/api/v1", requireTenantContext)
  app.use("/api/v1", attachSubscription)
  app.use("/api/v1", blockWritesWhenReadOnly)
  app.use("/api/v1", createSubscriptionRouter())
  app.use("/api/v1", createOnboardingRouter())
  app.use("/api/v1", createApiRouter())
  app.use("/api/v1", createPaymentsRouter())
  app.use("/api/v1", createStockRouter())
  app.use("/api/v1", createPurchaseRouter())
  app.use("/api/v1", createAttendanceRouter())
  app.use("/api/v1", createBackupRouter())
  app.use("/api/v1", createSupportRouter())
  app.use("/api/v1", createCheckoutRouter())
  app.use("/api/v1", createAccessRouter())
  app.use("/api/v1", createNotificationsRouter())
  app.use("/api/v1", createNotificationsRouter())
  app.use("/api/v1", createAuditLogRouter())
  app.use("/api/v1", createTeamRouter())
  app.use("/api/v1", createReportsRouter())
  app.use("/api/v1", createOperationsRouter())
  app.use("/api/v1", createUtilitiesRouter())
  app.use("/api/v1", createUtilityInsightsRouter())

  app.use("/api/v1", (_req: Request, res: Response) => {
    res.status(404).json({ error: { code: "not_found", message: "Cette route API n'existe pas." } })
  })
  return app
}

/** Gestionnaire d'erreurs commun : une erreur ne fuit jamais de détail interne. */
export function apiErrorHandler(error: unknown, req: Request, res: Response, next: NextFunction) {
  void next
  let status = error instanceof HttpError ? error.status : 500
  let code = error instanceof HttpError ? error.code : "internal_error"
  let message =
    error instanceof HttpError
      ? error.message
      : "Une erreur interne est survenue. Réessayez dans quelques instants."

  if (!(error instanceof HttpError) && typeof error === "object" && error !== null && "type" in error) {
    const type = (error as { type?: string }).type
    if (type === "entity.parse.failed") {
      status = 400
      code = "invalid_json"
      message = "Le corps de la requête n'est pas un JSON valide."
    }
  }
  if (status >= 500) {
    console.error("[api] Request failed:", error instanceof Error ? error.message : error)
    // Et surtout : on en garde la trace. Un `console.error` seul disparait
    // avec le processus, et c'est exactement ainsi qu'une route a pu rester
    // cassee en production sans que personne ne le sache.
    captureIncident(req, {
      status,
      code,
      message: error instanceof Error ? error.message : String(message),
      stack: error instanceof Error ? (error.stack ?? null) : null,
    })
  }
  res.status(status).json({ error: { code, message } })
}

/**
 * Application API seule (sans Vite ni fichiers statiques), utilisée par les
 * tests d'autorisation de bout en bout.
 */
export function createApiApp(): Express {
  const app = express()
  app.disable("x-powered-by")
  app.use(express.json({ limit: "1mb" }))
  mountApi(app)
  app.use(apiErrorHandler)
  return app
}
