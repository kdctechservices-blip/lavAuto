/**
 * Parcours de souscription côté client.
 *
 * Le client ne « demande » plus une activation : il ouvre une **intention de
 * paiement**, paie, puis déclare sa référence de transaction. L'éditeur n'a
 * plus qu'à confronter cette référence à son relevé mobile money et cliquer.
 *
 * Pourquoi une intention plutôt qu'un simple e-mail à l'assistance :
 *
 * - elle porte un identifiant unique que le client mentionne en payant, ce
 *   qui transforme un rapprochement manuel pénible en comparaison exacte ;
 * - elle est idempotente par construction (`reference` UNIQUE), donc prête à
 *   recevoir le webhook d'un agrégateur sans rien changer ;
 * - elle garde une trace de ce qui a été *tenté*, pas seulement de ce qui a
 *   abouti. Un client qui paie mal, deux fois, ou pas du tout laisse une
 *   trace exploitable.
 *
 * Le mode d'encaissement est choisi par `PAYMENT_PROVIDER` :
 *
 * - `manual` (défaut) — aucun contrat marchand requis. Le serveur rend les
 *   instructions de paiement, le client paie hors application, l'éditeur
 *   valide depuis le back-office.
 * - un agrégateur (CinetPay, PayDunya…) — le serveur rendrait une URL de
 *   paiement et l'activation se ferait sans intervention humaine.
 *
 * Dans les deux cas l'activation passe par `activateSubscription()`.
 */

import { Router } from "express"
import { z } from "zod"
import { randomBytes } from "node:crypto"
import { asyncRoute, body, tenant, requirePermission } from "./http.ts"
import { HttpError } from "./auth.ts"
import { getPool } from "./db.ts"
import { env } from "./env.ts"

function db() {
  const pool = getPool()
  if (!pool) {
    throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  }
  return pool
}

/**
 * Référence courte, lisible au téléphone et sans ambiguïté phonétique.
 *
 * Le client doit pouvoir la dicter à un agent Orange Money ou la recopier
 * dans un motif de transfert Wave. On exclut donc I, O, 0 et 1, qui se
 * confondent, et on reste en majuscules.
 */
function newReference(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const bytes = randomBytes(8)
  let out = ""
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return `WP-${out}`
}

/** Les intentions au-delà de cette durée ne sont plus payables. */
const INTENT_TTL_HOURS = 48

export function createCheckoutRouter() {
  const r = Router()

  // -------------------------------------------------------------------------
  // POST /api/v1/subscription/checkout — ouvrir une intention de paiement.
  // -------------------------------------------------------------------------
  r.post(
    "/subscription/checkout",
    requirePermission("subscription:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(
        z
          .object({
            plan_code: z.string().trim().min(1).max(40),
            months: z.number().int().min(1).max(12).default(1),
          })
          .strip(),
        req.body,
      )

      const pool = db()
      const planQ = await pool.query(
        "SELECT code, name, price_cents FROM plans WHERE code = $1",
        [input.plan_code],
      )
      if (!planQ.rowCount) throw new HttpError(404, "plan_not_found", "Forfait introuvable.")
      const plan = planQ.rows[0] as { code: string; name: string; price_cents: number }

      if (plan.price_cents <= 0) {
        throw new HttpError(
          400,
          "plan_not_payable",
          "Ce forfait n'est pas payant : aucune intention de paiement n'est nécessaire.",
        )
      }

      // Une intention récente et non réglée est réutilisée plutôt que
      // dupliquée. Sinon un client qui clique trois fois se retrouve avec
      // trois références, en paie une, et personne ne sait laquelle.
      const existing = await pool.query(
        `SELECT reference, plan_code, months, amount_cents, provider, status, created_at
           FROM payment_intents
          WHERE organization_id = $1::uuid
            AND status = 'pending'
            AND plan_code = $2
            AND months = $3
            AND created_at > now() - ($4 || ' hours')::interval
          ORDER BY created_at DESC
          LIMIT 1`,
        [t.organizationId, plan.code, input.months, String(INTENT_TTL_HOURS)],
      )

      const amountCents = plan.price_cents * input.months
      let row = existing.rows[0] as
        | { reference: string; amount_cents: number; provider: string }
        | undefined

      if (!row) {
        const inserted = await pool.query(
          `INSERT INTO payment_intents(
             organization_id, reference, plan_code, months, amount_cents, provider, created_by, metadata)
           VALUES($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::jsonb)
           RETURNING reference, amount_cents, provider`,
          [
            t.organizationId,
            newReference(),
            plan.code,
            input.months,
            amountCents,
            env.PAYMENT_PROVIDER,
            t.userId,
            JSON.stringify({ plan_name: plan.name }),
          ],
        )
        row = inserted.rows[0] as { reference: string; amount_cents: number; provider: string }
      }

      res.status(201).json({
        reference: row.reference,
        plan_code: plan.code,
        plan_name: plan.name,
        months: input.months,
        amount_cents: row.amount_cents,
        provider: row.provider,
        expires_in_hours: INTENT_TTL_HOURS,
        // En mode manuel, le serveur rend les coordonnées d'encaissement.
        // Un agrégateur rendrait ici une `payment_url`.
        instructions:
          row.provider === "manual"
            ? {
                merchant_number: env.PAYMENT_MERCHANT_NUMBER || null,
                merchant_name: env.PAYMENT_MERCHANT_NAME || null,
                channels: ["Orange Money", "MTN MoMo", "Moov Money", "Wave"],
                message:
                  "Indiquez la référence ci-dessus dans le motif du transfert, puis déclarez votre paiement.",
              }
            : null,
      })
    }),
  )

  // -------------------------------------------------------------------------
  // POST /api/v1/subscription/checkout/:reference/declare
  //
  // Le client déclare avoir payé et donne la référence que son opérateur lui
  // a renvoyée. Cela n'active rien : une déclaration n'est pas un paiement.
  // Elle met l'intention en tête de la file de l'éditeur, avec de quoi la
  // vérifier en quelques secondes.
  // -------------------------------------------------------------------------
  r.post(
    "/subscription/checkout/:reference/declare",
    requirePermission("subscription:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(
        z
          .object({
            transaction_reference: z.string().trim().min(3).max(120),
            paid_with: z.string().trim().max(40).optional(),
          })
          .strip(),
        req.body,
      )

      const pool = db()
      const updated = await pool.query(
        `UPDATE payment_intents
            SET declared_reference = $3,
                declared_at = now(),
                metadata = metadata || $4::jsonb
          WHERE reference = $1
            AND organization_id = $2::uuid
            AND status = 'pending'
          RETURNING reference, plan_code, months, amount_cents`,
        [
          req.params.reference,
          t.organizationId,
          input.transaction_reference,
          JSON.stringify({ paid_with: input.paid_with ?? null }),
        ],
      )
      if (!updated.rowCount) {
        throw new HttpError(
          404,
          "payment_intent_not_found",
          "Aucune demande de paiement en attente ne correspond à cette référence.",
        )
      }

      // Journalisé chez le client : il doit pouvoir prouver sa déclaration.
      await pool.query(
        `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES($1::uuid, $2::uuid, 'subscription.payment_declared', 'subscription', $3::text, $4::jsonb)`,
        [
          t.organizationId,
          t.userId,
          req.params.reference,
          JSON.stringify({
            transaction_reference: input.transaction_reference,
            paid_with: input.paid_with ?? null,
          }),
        ],
      )

      res.json({
        reference: updated.rows[0].reference,
        status: "pending",
        message:
          "Paiement déclaré. L'activation intervient dès vérification, en général sous quelques heures ouvrées.",
      })
    }),
  )

  // -------------------------------------------------------------------------
  // GET /api/v1/subscription/checkout — l'état des demandes de la station.
  // -------------------------------------------------------------------------
  r.get(
    "/subscription/checkout",
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query(
        `SELECT reference, plan_code, months, amount_cents, provider, status,
                declared_reference, declared_at, created_at, settled_at
           FROM payment_intents
          WHERE organization_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT 20`,
        [t.organizationId],
      )
      res.json({ intents: q.rows })
    }),
  )

  return r
}
