import { Router } from "express"
import { z } from "zod"
import type { Pool } from "pg"
import { getPool } from "./db.ts"
import { asyncRoute, body, tenant, parseId, requirePermission, HttpError } from "./http.ts"
import { fingerprint, withIdempotency } from "./idempotency.ts"
import { issueReceipt, receiptHistory, renderReceiptText } from "./receipt.ts"

// ---------------------------------------------------------------------------
// Encaissements
//
// Un lavage peut être réglé en plusieurs fois et par plusieurs canaux. Chaque
// encaissement est une ligne de `payments` :
//   • espèces                → « verified » tout de suite (l'argent est dans la caisse)
//   • Orange Money / MTN MoMo / Moov Money / Wave → « pending » tant que
//     l'opérateur n'a pas été vérifié, puis « verified » après confirmation.
// Le statut de règlement du lavage (`unpaid` / `partial` / `paid`) est toujours
// recalculé à partir de la somme des encaissements non remboursés.
// ---------------------------------------------------------------------------

export const PAYMENT_METHODS = [
  "cash",
  "orange_money",
  "mtn_momo",
  "moov_money",
  "wave",
  "other",
] as const

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Espèces",
  orange_money: "Orange Money",
  mtn_momo: "MTN MoMo",
  moov_money: "Moov Money",
  wave: "Wave",
  other: "Autre",
}

/** Canaux mobile money : l'argent n'arrive pas en caisse et doit être confirmé. */
export const MOBILE_MONEY_METHODS: PaymentMethod[] = [
  "orange_money",
  "mtn_momo",
  "moov_money",
  "wave",
]

export const paymentValidators = {
  /** Remboursement : le motif est obligatoire, c'est lui qui rend l'opération auditable. */
  refund: z
    .object({
      reason: z.string().trim().min(3).max(300),
    })
    .strip(),
  create: z
    .object({
      method: z.enum(PAYMENT_METHODS),
      amount_cents: z.number().int().min(1, "Le montant doit être supérieur à zéro.").max(100000000),
      reference: z.string().trim().max(80).nullable().optional(),
      cash_session_id: z.string().uuid().optional(),
    })
    .strip(),
  verify: z
    .object({
      reference: z.string().trim().max(80).nullable().optional(),
    })
    .strip(),
}

/** Statut d'un encaissement au moment de sa saisie. */
export function initialPaymentStatus(method: PaymentMethod): "verified" | "pending" {
  return method === "cash" ? "verified" : "pending"
}

/** Un encaissement mobile money doit-il être confirmé manuellement ? */
export function requiresConfirmation(method: string): boolean {
  return (MOBILE_MONEY_METHODS as string[]).includes(method) || method === "other"
}

/** Statut de règlement d'un lavage, déduit des encaissements. */
export function resolvePaymentStatus(totalCents: number, paidCents: number): "unpaid" | "partial" | "paid" {
  if (totalCents <= 0) return "paid"
  if (paidCents <= 0) return "unpaid"
  if (paidCents >= totalCents) return "paid"
  return "partial"
}

/** Alias explicite utilisé par l'interface et les tests. */
export const resolveWashPaymentStatus = resolvePaymentStatus

/**
 * Solde restant dû sur un lavage.
 * Un paiement remboursé ne compte pas : le client doit de nouveau régler.
 */
export function remainingDueCents(
  totalCents: number,
  payments: readonly { amount_cents: number; status: string }[],
): number {
  const paid = payments
    .filter((payment) => payment.status !== "refunded")
    .reduce((sum, payment) => sum + payment.amount_cents, 0)
  return Math.max(0, totalCents - paid)
}

function db(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

const PAYMENT_FIELDS = `p.id, p.wash_id, p.method, p.amount_cents, p.status, p.reference,
  p.created_at, w.reference AS wash_reference, w.site_id, w.total_cents AS wash_total_cents`

export function createPaymentsRouter() {
  const r = Router()

  // ---------------------------------------------------------------------------
  // POST /api/v1/washes/:id/receipt — émettre le reçu 80 mm d'un lavage.
  //
  // POST et non GET, parce que l'émission n'est pas une lecture : elle attribue
  // un numéro de copie et laisse une trace. Ouvrir le reçu, c'est l'émettre.
  // Un GET silencieux permettrait d'imprimer autant de papiers qu'on veut sans
  // que le compteur de duplicata bouge, ce qui viderait la mention DUPLICATA de
  // son sens.
  //
  // Permission `payment:read` : remettre au client la preuve de ce qu'il a payé
  // appartient à qui voit les encaissements — le caissier, le gérant, le
  // propriétaire. Un agent de lavage ne voit pas les paiements et n'imprime pas.
  // ---------------------------------------------------------------------------
  r.post(
    "/washes/:id/receipt",
    requirePermission("payment:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const washId = parseId(req.params.id)
      const receipt = await issueReceipt(db(), {
        organizationId: t.organizationId,
        washId,
        userId: t.userId,
      })
      // Le rendu texte accompagne les données : une station dont le pilote
      // d'imprimante n'accepte que du texte brut l'envoie tel quel.
      const text = renderReceiptText(receipt)
      // Si demandé, inclure l'URL WhatsApp dans la réponse
      const jsonResponse: { receipt: typeof receipt; text: string; whatsappUrl?: string } = { receipt, text }
      if (req.query.send_whatsapp === "true") {
        const { sendReceiptViaWhatsApp } = await import("./receipt.ts")
        const result = await sendReceiptViaWhatsApp(db(), t.organizationId, washId, text)
        jsonResponse.whatsappUrl = result.whatsappUrl
      }
      res.status(201).json(jsonResponse)
    }),
  )

  // GET /api/v1/washes/:id/receipt/history — combien de papiers circulent.
  r.get(
    "/washes/:id/receipt/history",
    requirePermission("payment:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const washId = parseId(req.params.id)
      res.json({ issues: await receiptHistory(db(), t.organizationId, washId) })
    }),
  )

  // GET /api/v1/payments?status=pending&method=wave&limit=100
  // Suivi des encaissements, canal par canal.
  r.get(
    "/payments",
    requirePermission("payment:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const filters = body(
        z
          .object({
            status: z.enum(["pending", "verified", "refunded", "all"]).default("all"),
            method: z.enum([...PAYMENT_METHODS, "all"]).default("all"),
            limit: z.coerce.number().int().min(1).max(200).default(100),
          })
          .strip(),
        {
          status: req.query.status ?? "all",
          method: req.query.method ?? "all",
          limit: req.query.limit ?? 100,
        },
      )

      const conditions = ["p.organization_id=$1::uuid"]
      const args: unknown[] = [t.organizationId]
      if (filters.status !== "all") {
        args.push(filters.status)
        conditions.push(`p.status=$${args.length}`)
      }
      if (filters.method !== "all") {
        args.push(filters.method)
        conditions.push(`p.method=$${args.length}`)
      }
      args.push(filters.limit)

      const [list, totals] = await Promise.all([
        db().query(
          `SELECT ${PAYMENT_FIELDS}
           FROM payments p JOIN washes w ON w.id = p.wash_id
           WHERE ${conditions.join(" AND ")}
           ORDER BY p.created_at DESC
           LIMIT $${args.length}`,
          args,
        ),
        // Totaux par canal : la réponse sert directement de tableau de suivi.
        db().query(
          `SELECT method,
             COUNT(*)::int AS payment_count,
             COALESCE(SUM(amount_cents),0)::int AS amount_cents,
             COALESCE(SUM(amount_cents) FILTER (WHERE status='verified'),0)::int AS verified_cents,
             COALESCE(SUM(amount_cents) FILTER (WHERE status='pending'),0)::int AS pending_cents
           FROM payments
           WHERE organization_id=$1::uuid AND status <> 'refunded'
           GROUP BY method ORDER BY amount_cents DESC`,
          [t.organizationId],
        ),
      ])

      res.json({ payments: list.rows, totals_by_method: totals.rows })
    }),
  )

  // POST /api/v1/washes/:id/payments — encaisser (ou compléter) un lavage.
  r.post(
    "/washes/:id/payments",
    requirePermission("payment:create"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const washId = parseId(req.params.id)
      const input = body(paymentValidators.create, req.body)
      const pool = db()

      await withIdempotency(
        pool,
        req,
        res,
        t.organizationId,
        fingerprint({ op: "wash-payment", wash: washId, ...input }),
        async () => {
          const client = await pool.connect()
          try {
            await client.query("BEGIN")

            const washQ = await client.query(
              `SELECT id, reference, site_id, status, total_cents
               FROM washes WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE`,
              [washId, t.organizationId],
            )
            if (!washQ.rowCount) throw new HttpError(404, "wash_not_found", "Lavage introuvable.")
            const wash = washQ.rows[0]
            if (wash.status === "cancelled") {
              throw new HttpError(409, "wash_cancelled", "Ce lavage est annulé : aucun encaissement n’est possible.")
            }

            const paidQ = await client.query(
              "SELECT COALESCE(SUM(amount_cents),0)::int AS paid FROM payments WHERE wash_id=$1::uuid AND status <> 'refunded'",
              [washId],
            )
            const alreadyPaid = Number(paidQ.rows[0].paid)
            const due = Number(wash.total_cents) - alreadyPaid
            if (due <= 0) {
              throw new HttpError(409, "wash_already_paid", "Ce lavage est déjà intégralement réglé.")
            }
            if (input.amount_cents > due) {
              throw new HttpError(
                400,
                "amount_exceeds_due",
                `Le montant dépasse le solde restant (${(due / 100).toLocaleString("fr-CI")} FCFA).`,
              )
            }

            // Espèces : l'argent entre physiquement dans une caisse ouverte.
            // Si l'appelant ne précise pas la session, on prend celle qui est
            // ouverte sur la station du lavage (cas courant : une seule caisse).
            let cashSessionId: string | null = null
            if (input.method === "cash") {
              const sessionQ = input.cash_session_id
                ? await client.query(
                    `SELECT id FROM cash_sessions
                     WHERE id=$1::uuid AND organization_id=$2::uuid AND site_id=$3::uuid AND status='open'
                     FOR UPDATE`,
                    [input.cash_session_id, t.organizationId, wash.site_id],
                  )
                : await client.query(
                    `SELECT id FROM cash_sessions
                     WHERE organization_id=$1::uuid AND site_id=$2::uuid AND status='open'
                     ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`,
                    [t.organizationId, wash.site_id],
                  )
              if (!sessionQ.rowCount) {
                throw new HttpError(
                  400,
                  input.cash_session_id ? "cash_session_invalid" : "cash_session_required",
                  input.cash_session_id
                    ? "Session de caisse introuvable, fermée ou d’une autre station."
                    : "Aucune session de caisse ouverte sur cette station : ouvrez la caisse avant d’encaisser des espèces.",
                )
              }
              cashSessionId = sessionQ.rows[0].id
            }

            const status = initialPaymentStatus(input.method)
            const paymentQ = await client.query(
              `INSERT INTO payments(organization_id, wash_id, method, amount_cents, status, reference)
               VALUES($1,$2,$3,$4,$5,$6)
               RETURNING id, wash_id, method, amount_cents, status, reference, created_at`,
              [t.organizationId, washId, input.method, input.amount_cents, status, input.reference?.trim() || null],
            )
            const payment = paymentQ.rows[0]

            if (cashSessionId) {
              await client.query(
                `INSERT INTO cash_movements(organization_id, cash_session_id, type, amount_cents, source, description, wash_id, created_by)
                 VALUES($1,$2,'entry',$3,'wash',$4,$5,$6)`,
                [t.organizationId, cashSessionId, input.amount_cents, `Encaissement lavage ${wash.reference}`, washId, t.userId],
              )
            }

            const paymentStatus = resolvePaymentStatus(Number(wash.total_cents), alreadyPaid + input.amount_cents)
            await client.query("UPDATE washes SET payment_status=$2 WHERE id=$1::uuid", [washId, paymentStatus])

            await client.query(
              `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
               VALUES($1,$2,'payment.recorded','payment',$3,$4)`,
              [
                t.organizationId,
                t.userId,
                payment.id,
                JSON.stringify({ wash_id: washId, method: input.method, amount_cents: input.amount_cents }),
              ],
            )

            await client.query("COMMIT")
            return {
              status: 201,
              body: {
                payment,
                wash: { id: washId, payment_status: paymentStatus, remaining_cents: due - input.amount_cents },
              },
            }
          } catch (error) {
            await client.query("ROLLBACK")
            throw error
          } finally {
            client.release()
          }
        },
      )
    }),
  )

  // POST /api/v1/payments/:id/verify — confirmer la réception d'un paiement
  // mobile money après contrôle du SMS / relevé opérateur.
  r.post(
    "/payments/:id/verify",
    requirePermission("payment:verify"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(paymentValidators.verify, req.body ?? {})
      const pool = db()
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        const paymentQ = await client.query(
          "SELECT id, status, method, amount_cents, wash_id FROM payments WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
          [id, t.organizationId],
        )
        if (!paymentQ.rowCount) throw new HttpError(404, "payment_not_found", "Encaissement introuvable.")
        const payment = paymentQ.rows[0]
        if (payment.status === "verified") {
          throw new HttpError(409, "payment_already_verified", "Cet encaissement est déjà confirmé.")
        }
        if (payment.status === "refunded") {
          throw new HttpError(409, "payment_refunded", "Cet encaissement a été remboursé.")
        }

        const updatedQ = await client.query(
          `UPDATE payments SET status='verified', reference=COALESCE($3, reference)
           WHERE id=$1::uuid AND organization_id=$2::uuid
           RETURNING id, wash_id, method, amount_cents, status, reference, created_at`,
          [id, t.organizationId, input.reference?.trim() || null],
        )
        await client.query(
          `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
           VALUES($1,$2,'payment.verified','payment',$3,$4)`,
          [t.organizationId, t.userId, id, JSON.stringify({ method: payment.method, amount_cents: payment.amount_cents })],
        )
        await client.query("COMMIT")
        res.json(updatedQ.rows[0])
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }),
  )

  // POST /api/v1/payments/:id/refund — annuler un encaissement déjà enregistré.
  //
  // Un encaissement n'est jamais supprimé : il passe en « remboursé », avec un
  // motif obligatoire et, pour les espèces, une sortie de caisse correspondante.
  // L'historique reste donc complet pour le rapprochement de caisse.
  r.post(
    "/payments/:id/refund",
    requirePermission("payment:cancel"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(paymentValidators.refund, req.body ?? {})
      const pool = db()
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        const paymentQ = await client.query(
          `SELECT p.id, p.status, p.method, p.amount_cents, p.wash_id,
                  w.reference AS wash_reference, w.site_id, w.total_cents
           FROM payments p JOIN washes w ON w.id = p.wash_id
           WHERE p.id=$1::uuid AND p.organization_id=$2::uuid FOR UPDATE OF p`,
          [id, t.organizationId],
        )
        if (!paymentQ.rowCount) throw new HttpError(404, "payment_not_found", "Encaissement introuvable.")
        const payment = paymentQ.rows[0]
        if (payment.status === "refunded") {
          throw new HttpError(409, "payment_already_refunded", "Cet encaissement est déjà remboursé.")
        }

        // Espèces : l'argent ressort physiquement de la caisse ouverte.
        if (payment.method === "cash") {
          const sessionQ = await client.query(
            `SELECT id FROM cash_sessions
             WHERE organization_id=$1::uuid AND site_id=$2::uuid AND status='open'
             ORDER BY opened_at DESC LIMIT 1 FOR UPDATE`,
            [t.organizationId, payment.site_id],
          )
          if (!sessionQ.rowCount) {
            throw new HttpError(
              400,
              "cash_session_required",
              "Ouvrez la caisse avant de rembourser un encaissement en espèces.",
            )
          }
          await client.query(
            `INSERT INTO cash_movements(organization_id, cash_session_id, type, amount_cents, source, description, wash_id, created_by)
             VALUES($1,$2,'exit',$3,'refund',$4,$5,$6)`,
            [
              t.organizationId,
              sessionQ.rows[0].id,
              payment.amount_cents,
              `Remboursement lavage ${payment.wash_reference} — ${input.reason}`,
              payment.wash_id,
              t.userId,
            ],
          )
        }

        const updatedQ = await client.query(
          `UPDATE payments SET status='refunded'
           WHERE id=$1::uuid AND organization_id=$2::uuid
           RETURNING id, wash_id, method, amount_cents, status, reference, created_at`,
          [id, t.organizationId],
        )

        // Le lavage redevient dû à hauteur du montant remboursé.
        const paidQ = await client.query(
          `SELECT COALESCE(SUM(amount_cents),0)::int AS paid FROM payments
           WHERE wash_id=$1::uuid AND status <> 'refunded'`,
          [payment.wash_id],
        )
        const paymentStatus = resolvePaymentStatus(Number(payment.total_cents), Number(paidQ.rows[0].paid))
        await client.query("UPDATE washes SET payment_status=$2 WHERE id=$1::uuid", [
          payment.wash_id,
          paymentStatus,
        ])

        await client.query(
          `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
           VALUES($1,$2,'payment.refunded','payment',$3,$4)`,
          [
            t.organizationId,
            t.userId,
            id,
            JSON.stringify({
              method: payment.method,
              amount_cents: payment.amount_cents,
              reason: input.reason,
              wash_id: payment.wash_id,
            }),
          ],
        )

        await client.query("COMMIT")
        res.json({
          payment: updatedQ.rows[0],
          wash: { id: payment.wash_id, payment_status: paymentStatus },
        })
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }),
  )

  return r
}
