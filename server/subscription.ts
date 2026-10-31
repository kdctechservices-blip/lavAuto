import { Router } from "express"
import { z } from "zod"
import type { Pool } from "pg"
import { getPool } from "./db.ts"
import { asyncRoute, body, tenant, requirePermission, HttpError } from "./http.ts"
import { registerClosureRoutes } from "./closure.ts"
import { env } from "./env.ts"
import {
  TRIAL_DAYS,
  TRIAL_WARNING_DAYS,
  CAPABILITY_LABELS,
  invalidateSubscriptionCache,
  loadSubscriptionState,
} from "./entitlements.ts"
import { DOWNGRADE_GRACE_DAYS, loadSiteLimitState } from "./plan-limits.ts"

function db(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

export function createSubscriptionRouter() {
  const r = Router()

  // GET /api/v1/subscription — état de l'abonnement et droits associés.
  // Appelé par le compte à rebours : réponse légère, calculée côté serveur.
  r.get(
    "/subscription",
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const pool = db()
      const state = await loadSubscriptionState(pool, t.organizationId, { fresh: true })
      // Les limites voyagent avec l'abonnement : l'interface a besoin des deux
      // au même instant pour expliquer un bouton grisé sans second aller-retour.
      const sites = await loadSiteLimitState(pool, t.organizationId)
      res.json({
        ...state,
        warning_days: TRIAL_WARNING_DAYS,
        capability_labels: CAPABILITY_LABELS,
        limits: { sites },
        downgrade_grace_days: DOWNGRADE_GRACE_DAYS,
      })
    }),
  )

  // POST /api/v1/subscription/simulate — outil de démonstration.
  // Permet de visualiser l'essai à J-10, J-1 ou expiré sans attendre 14 jours.
  // Indisponible en production.
  if (env.NODE_ENV !== "production") {
    r.post(
      "/subscription/simulate",
      requirePermission("subscription:manage"),
      asyncRoute(async (req, res) => {
        const payload = body(
          z
            .object({
              // Jours restants : négatif ou nul = essai terminé.
              days_left: z.number().min(-365).max(TRIAL_DAYS),
              plan_code: z.string().trim().min(1).max(40).optional(),
              // Recule la date du changement de forfait, pour observer la fin
              // du délai de grâce sans attendre 14 jours.
              plan_changed_days_ago: z.number().min(0).max(400).optional(),
            })
            .strip(),
          req.body,
        )
        const t = tenant(req)
        const pool = db()

        const planQ = await pool.query("SELECT id FROM plans WHERE code=$1", [
          payload.plan_code ?? "starter",
        ])
        if (!planQ.rowCount) throw new HttpError(404, "plan_not_found", "Forfait introuvable.")

        const expired = payload.days_left <= 0
        await pool.query(
          `INSERT INTO subscriptions(organization_id, plan_id, status, current_period_end, plan_changed_at)
           VALUES($1::uuid, $2, $3, now() + ($4 || ' days')::interval, now())
           ON CONFLICT (organization_id) DO UPDATE
             SET plan_id=EXCLUDED.plan_id, status=EXCLUDED.status,
                 current_period_end=EXCLUDED.current_period_end,
                 plan_changed_at=CASE WHEN subscriptions.plan_id <> EXCLUDED.plan_id THEN now() ELSE subscriptions.plan_changed_at END,
                 updated_at=now()`,
          [t.organizationId, planQ.rows[0].id, expired ? "expired" : "trialing", String(payload.days_left)],
        )
        if (payload.plan_changed_days_ago !== undefined) {
          await pool.query(
            "UPDATE subscriptions SET plan_changed_at = now() - ($2 || ' days')::interval WHERE organization_id=$1::uuid",
            [t.organizationId, String(payload.plan_changed_days_ago)],
          )
        }

        invalidateSubscriptionCache(t.organizationId)
        const state = await loadSubscriptionState(pool, t.organizationId, { fresh: true })
        res.json({ ...state, simulated: true })
      }),
    )
  }

  // Demande de clôture émise par le client. Montée ici pour bénéficier du
  // préfixe `/subscription`, exempté du blocage en lecture seule.
  registerClosureRoutes(r)

  return r
}
