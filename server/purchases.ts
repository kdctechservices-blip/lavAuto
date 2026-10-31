// ---------------------------------------------------------------------------
// Fournisseurs et achats.
//
// Deux règles gouvernent ce module, et elles expliquent presque tout le code
// qui suit.
//
// 1. **Seul ce qui est reçu augmente le stock.** La colonne s'appelle
//    `received_milli`, pas `quantity_milli` : à la saisie, on compte ce qu'il
//    y a dans le sac, pas ce qui figure sur le bon de commande. En station on
//    repart avec la marchandise, donc l'achat et la réception sont le même
//    geste — mais le mot « reçu » reste, parce que c'est lui qui dit quoi
//    taper quand le vendeur en a mis dix-huit au lieu de vingt.
//
// 2. **Un achat produit une dépense, et une seule.** L'argent n'est pas
//    ressaisi à la main à côté de la marchandise : c'est l'achat qui écrit la
//    dépense, liée par `expenses.purchase_id`, sous index unique. Le double
//    comptage n'est donc pas découragé par une consigne, il est impossible à
//    écrire. Ressaisir une dépense « achat Omo » en plus resterait possible —
//    aucune base n'empêche un humain de taper deux fois — mais le produit, lui,
//    ne le fait jamais dans le dos de l'utilisateur.
//
// Un achat ne se modifie pas et ne se supprime pas : il s'annule. L'annulation
// contrepasse les entrées de stock et marque la dépense annulée, sans rien
// effacer. Si la caisse qui a payé est encore ouverte, l'argent y est remis ;
// si elle est close, on n'y touche pas — une journée arrêtée ne se réécrit pas.
// ---------------------------------------------------------------------------

import { Router } from "express"
import { z } from "zod"
import type { Pool } from "pg"
import { getPool } from "./db.ts"
import { asyncRoute, body, tenant, parseId, requirePermission } from "./http.ts"
import { HttpError } from "./auth.ts"
import { requireCapability } from "./entitlements.ts"
import { fingerprint, withIdempotency } from "./idempotency.ts"

function db(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

type TxClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
}

/**
 * Bornes volontairement basses.
 *
 * Elles ne protègent pas d'un abus mais d'un dérapage arithmétique : le total
 * d'une ligne vaut `reçu × coût ÷ 1000`, et deux plafonds à dix millions
 * garantissent que ce produit reste très en deçà de l'entier sûr de
 * JavaScript. Le total de l'achat est vérifié séparément contre la capacité
 * d'un `integer` PostgreSQL.
 */
const receivedMilli = z.number().int().positive().max(10_000_000)
const unitCost = z.number().int().min(0).max(10_000_000)

/** Plafond d'un `integer` PostgreSQL, gardé avec de la marge. */
const TOTAL_MAX_CENTS = 2_000_000_000

export const purchaseValidators = {
  supplier: z
    .object({
      name: z.string().trim().min(2).max(160),
      phone: z.string().trim().max(40).optional(),
      contact_name: z.string().trim().max(160).optional(),
      notes: z.string().trim().max(1000).optional(),
    })
    .strip(),
  supplierUpdate: z
    .object({
      name: z.string().trim().min(2).max(160).optional(),
      phone: z.string().trim().max(40).nullable().optional(),
      contact_name: z.string().trim().max(160).nullable().optional(),
      notes: z.string().trim().max(1000).nullable().optional(),
      is_active: z.boolean().optional(),
    })
    .strip(),
  purchase: z
    .object({
      supplier_id: z.string().uuid().nullable().optional(),
      site_id: z.string().uuid().optional(),
      invoice_reference: z.string().trim().max(120).optional(),
      purchase_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format AAAA-MM-JJ.")
        .optional(),
      payment_method: z.enum(["cash", "orange_money", "mtn_momo", "moov_money", "wave", "other"]),
      cash_session_id: z.string().uuid().optional(),
      items: z
        .array(
          z
            .object({
              product_id: z.string().uuid(),
              received_milli: receivedMilli,
              unit_cost_cents: unitCost,
            })
            .strip(),
        )
        .min(1)
        .max(50),
    })
    .strip(),
  cancel: z.object({ reason: z.string().trim().min(3).max(500) }).strip(),
}

const SUPPLIER_FIELDS = `id, name, phone, contact_name, notes, is_active, created_at`

/**
 * Montant d'une ligne, en centimes entiers.
 *
 * Les quantités sont en millièmes d'unité et les coûts en centimes par unité :
 * la division par mille est donc inévitable. On arrondit une fois, ici, plutôt
 * que de laisser filer un flottant dans la base. En pratique on achète des
 * sachets entiers et la division tombe juste ; l'arrondi ne sert qu'aux unités
 * fractionnables comme le litre.
 */
export function lineTotalCents(receivedMilliValue: number, unitCostCents: number): number {
  return Math.round((receivedMilliValue * unitCostCents) / 1000)
}

export function createPurchaseRouter() {
  const r = Router()

  // -------------------------------------------------------------------------
  // Fournisseurs
  // -------------------------------------------------------------------------

  r.get(
    "/suppliers",
    requirePermission("supplier:manage"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query(
        `SELECT ${SUPPLIER_FIELDS} FROM suppliers WHERE organization_id=$1::uuid ORDER BY is_active DESC, name`,
        [t.organizationId],
      )
      res.json(q.rows)
    }),
  )

  r.post(
    "/suppliers",
    requirePermission("supplier:manage"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(purchaseValidators.supplier, req.body)
      const pool = db()

      const existing = await pool.query(
        "SELECT 1 FROM suppliers WHERE organization_id=$1::uuid AND lower(name)=lower($2)",
        [t.organizationId, input.name],
      )
      if (existing.rowCount) {
        throw new HttpError(409, "duplicate_supplier", "Un fournisseur porte déjà ce nom.")
      }

      const q = await pool.query(
        `INSERT INTO suppliers(organization_id, name, phone, contact_name, notes)
         VALUES($1,$2,$3,$4,$5) RETURNING ${SUPPLIER_FIELDS}`,
        [t.organizationId, input.name, input.phone || null, input.contact_name || null, input.notes || null],
      )
      await pool.query(
        "INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id) VALUES($1,$2,'supplier.created','supplier',$3)",
        [t.organizationId, t.userId, q.rows[0].id],
      )
      res.status(201).json(q.rows[0])
    }),
  )

  r.patch(
    "/suppliers/:id",
    requirePermission("supplier:manage"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(purchaseValidators.supplierUpdate, req.body)
      const pool = db()

      const current = await pool.query("SELECT id FROM suppliers WHERE id=$1::uuid AND organization_id=$2::uuid", [
        id,
        t.organizationId,
      ])
      if (!current.rowCount) throw new HttpError(404, "supplier_not_found", "Fournisseur introuvable.")

      if (input.name !== undefined) {
        const clash = await pool.query(
          "SELECT 1 FROM suppliers WHERE organization_id=$1::uuid AND lower(name)=lower($2) AND id<>$3::uuid",
          [t.organizationId, input.name, id],
        )
        if (clash.rowCount) throw new HttpError(409, "duplicate_supplier", "Un fournisseur porte déjà ce nom.")
      }

      const q = await pool.query(
        `UPDATE suppliers SET
           name = COALESCE($3, name),
           phone = CASE WHEN $4::boolean THEN $5 ELSE phone END,
           contact_name = CASE WHEN $6::boolean THEN $7 ELSE contact_name END,
           notes = CASE WHEN $8::boolean THEN $9 ELSE notes END,
           is_active = COALESCE($10, is_active),
           updated_at = now()
         WHERE id=$1::uuid AND organization_id=$2::uuid
         RETURNING ${SUPPLIER_FIELDS}`,
        [
          id,
          t.organizationId,
          input.name ?? null,
          input.phone !== undefined,
          input.phone ?? null,
          input.contact_name !== undefined,
          input.contact_name ?? null,
          input.notes !== undefined,
          input.notes ?? null,
          input.is_active ?? null,
        ],
      )
      res.json(q.rows[0])
    }),
  )

  // -------------------------------------------------------------------------
  // Achats
  // -------------------------------------------------------------------------

  r.get(
    "/purchases",
    requirePermission("purchase:manage"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query(
        `SELECT pu.id, pu.reference, pu.invoice_reference, pu.purchase_date, pu.total_cents,
                pu.payment_method, pu.status, pu.cancelled_at, pu.cancellation_reason, pu.created_at,
                pu.supplier_id, s.name AS supplier_name,
                u.first_name, u.last_name,
                (SELECT count(*) FROM purchase_items pi WHERE pi.purchase_id = pu.id) AS line_count
         FROM purchases pu
         LEFT JOIN suppliers s ON s.id = pu.supplier_id AND s.organization_id = pu.organization_id
         LEFT JOIN users u ON u.id = pu.created_by
         WHERE pu.organization_id=$1::uuid
         ORDER BY pu.purchase_date DESC, pu.created_at DESC LIMIT 200`,
        [t.organizationId],
      )
      res.json(q.rows)
    }),
  )

  r.get(
    "/purchases/:id",
    requirePermission("purchase:manage"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const pool = db()

      const q = await pool.query(
        `SELECT pu.id, pu.reference, pu.invoice_reference, pu.purchase_date, pu.total_cents,
                pu.payment_method, pu.status, pu.cancelled_at, pu.cancellation_reason, pu.created_at,
                pu.site_id, pu.supplier_id, s.name AS supplier_name,
                u.first_name, u.last_name
         FROM purchases pu
         LEFT JOIN suppliers s ON s.id = pu.supplier_id AND s.organization_id = pu.organization_id
         LEFT JOIN users u ON u.id = pu.created_by
         WHERE pu.id=$1::uuid AND pu.organization_id=$2::uuid`,
        [id, t.organizationId],
      )
      if (!q.rowCount) throw new HttpError(404, "purchase_not_found", "Achat introuvable.")

      const items = await pool.query(
        `SELECT pi.id, pi.product_id, pi.product_name_snapshot, pi.received_milli, pi.unit_cost_cents,
                p.unit
         FROM purchase_items pi
         LEFT JOIN products p ON p.id = pi.product_id
         WHERE pi.purchase_id=$1::uuid AND pi.organization_id=$2::uuid
         ORDER BY pi.created_at, pi.product_name_snapshot`,
        [id, t.organizationId],
      )
      res.json({ purchase: q.rows[0], items: items.rows })
    }),
  )

  r.post(
    "/purchases",
    requirePermission("purchase:manage"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(purchaseValidators.purchase, req.body)
      const pool = db()

      // Deux lignes sur le même produit dans le même achat : on refuse plutôt
      // que de cumuler en silence. L'utilisateur s'est trompé de ligne, et un
      // cumul muet lui cacherait son erreur.
      const ids = input.items.map((item) => item.product_id)
      if (new Set(ids).size !== ids.length) {
        throw new HttpError(400, "duplicate_product", "Un même produit figure deux fois. Regroupez-le sur une seule ligne.")
      }

      const total = input.items.reduce((sum, item) => sum + lineTotalCents(item.received_milli, item.unit_cost_cents), 0)
      if (total > TOTAL_MAX_CENTS) {
        throw new HttpError(400, "amount_too_large", "Le montant total de cet achat dépasse la limite autorisée.")
      }

      await withIdempotency(pool, req, res, t.organizationId, fingerprint({ op: "purchase", ...input }), async () => {
        const client = await pool.connect()
        try {
          await client.query("BEGIN")

          let siteId: string | null = input.site_id ?? null
          if (siteId) {
            const siteQ = await client.query("SELECT 1 FROM sites WHERE id=$1::uuid AND organization_id=$2::uuid", [
              siteId,
              t.organizationId,
            ])
            if (!siteQ.rowCount) throw new HttpError(400, "invalid_site", "Station invalide.")
          }

          if (input.supplier_id) {
            const supplierQ = await client.query(
              "SELECT is_active FROM suppliers WHERE id=$1::uuid AND organization_id=$2::uuid",
              [input.supplier_id, t.organizationId],
            )
            if (!supplierQ.rowCount) throw new HttpError(404, "supplier_not_found", "Fournisseur introuvable.")
            if (!supplierQ.rows[0].is_active) {
              throw new HttpError(409, "supplier_archived", "Ce fournisseur est archivé. Réactivez-le pour lui rattacher un achat.")
            }
          }

          // Espèces : l'argent sort du tiroir, donc une caisse doit être
          // ouverte. Même exigence que pour une dépense saisie à la main —
          // c'est le même mouvement d'argent, il n'y a pas de raison que
          // l'achat y échappe.
          let cashSessionId: string | null = null
          if (input.payment_method === "cash") {
            if (!input.cash_session_id) {
              throw new HttpError(400, "cash_session_required", "Une session de caisse ouverte est requise pour un achat réglé en espèces.")
            }
            const sessionQ = await client.query(
              "SELECT id, site_id, status FROM cash_sessions WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
              [input.cash_session_id, t.organizationId],
            )
            if (!sessionQ.rowCount || sessionQ.rows[0].status !== "open") {
              throw new HttpError(400, "cash_session_invalid", "Session de caisse introuvable ou clôturée.")
            }
            cashSessionId = String(sessionQ.rows[0].id)
            if (!siteId) siteId = sessionQ.rows[0].site_id as string | null
          }

          // Les produits sont verrouillés dans un ordre stable : deux achats
          // simultanés portant sur les mêmes produits ne peuvent pas
          // s'interbloquer en les prenant dans des sens opposés.
          const ordered = [...input.items].sort((a, b) => a.product_id.localeCompare(b.product_id))
          const produits = new Map<string, { name: string; unitCostCents: number }>()
          for (const item of ordered) {
            const productQ = await client.query(
              "SELECT id, name, is_active, unit_cost_cents FROM products WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
              [item.product_id, t.organizationId],
            )
            if (!productQ.rowCount) throw new HttpError(404, "product_not_found", "Produit introuvable.")
            if (!productQ.rows[0].is_active) {
              throw new HttpError(409, "product_archived", "Un produit de cet achat est archivé. Réactivez-le avant de l'approvisionner.")
            }
            produits.set(item.product_id, {
              name: String(productQ.rows[0].name),
              unitCostCents: Number(productQ.rows[0].unit_cost_cents),
            })
          }

          const purchaseQ = await client.query(
            `INSERT INTO purchases(organization_id, site_id, supplier_id, reference, invoice_reference,
               purchase_date, total_cents, payment_method, cash_session_id, created_by)
             VALUES($1,$2,$3,
               'ACH-' || to_char(now(),'YYYYMMDD') || '-' || upper(substr(md5(random()::text),1,6)),
               $4, COALESCE($5::date, CURRENT_DATE), $6, $7, $8, $9)
             RETURNING id, reference, purchase_date, total_cents, payment_method, status, created_at`,
            [
              t.organizationId,
              siteId,
              input.supplier_id ?? null,
              input.invoice_reference || null,
              input.purchase_date ?? null,
              total,
              input.payment_method,
              cashSessionId,
              t.userId,
            ],
          )
          const purchase = purchaseQ.rows[0]
          const purchaseId = String(purchase.id)

          for (const item of input.items) {
            const nom = produits.get(item.product_id)?.name ?? "Produit"
            await client.query(
              `INSERT INTO purchase_items(organization_id, purchase_id, product_id, product_name_snapshot,
                 received_milli, unit_cost_cents)
               VALUES($1,$2,$3,$4,$5,$6)`,
              [t.organizationId, purchaseId, item.product_id, nom, item.received_milli, item.unit_cost_cents],
            )
            // L'entrée en stock, et elle seule, fait monter le niveau. Le coût
            // unitaire est figé ici : si le même produit est racheté plus cher
            // le mois prochain, ce mouvement-ci gardera le prix payé ce jour-là.
            await client.query(
              `INSERT INTO stock_movements(organization_id, product_id, site_id, purchase_id, kind,
                 quantity_milli, unit_cost_cents, reason, created_by)
               VALUES($1,$2,$3,$4,'entry',$5,$6,'Réception d''un achat',$7)`,
              [t.organizationId, item.product_id, siteId, purchaseId, item.received_milli, item.unit_cost_cents, t.userId],
            )

            // Le prix qu'on vient de payer devient le cout de reference du
            // produit. Sans cela, la fiche gardait indefiniment un chiffre
            // saisi a la main le premier jour, et chaque lavage valorisait sa
            // consommation a ce vieux prix : la marge affichee etait fausse,
            // toujours dans le sens flatteur.
            //
            // C'est le DERNIER PRIX PAYE qui est retenu, pas une moyenne.
            // Deux raisons. D'abord le stock peut etre negatif dans ce produit
            // — une rupture n'a jamais le droit de bloquer un lavage — et une
            // moyenne ponderee par une quantite negative ne veut plus rien
            // dire. Ensuite c'est le chiffre que le gerant reconnait : il a
            // paye 350 le sachet, sa fiche doit afficher 350.
            //
            // L'historique n'est pas touche : chaque mouvement deja ecrit
            // garde le cout qui etait vrai ce jour-la.
            const ancienCout = produits.get(item.product_id)?.unitCostCents ?? 0
            // Un cout nul n'ecrase rien : recevoir un echantillon gratuit ne
            // doit pas faire croire que le produit ne coute plus rien, ce qui
            // rendrait toutes les marges parfaites.
            if (item.unit_cost_cents > 0 && item.unit_cost_cents !== ancienCout) {
              await client.query(
                "UPDATE products SET unit_cost_cents=$1, unit_cost_updated_at=now() WHERE id=$2::uuid AND organization_id=$3::uuid",
                [item.unit_cost_cents, item.product_id, t.organizationId],
              )
              await client.query(
                `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
                 VALUES($1,$2,'product.cost_changed','product',$3::text,$4::jsonb)`,
                [
                  t.organizationId,
                  t.userId,
                  item.product_id,
                  JSON.stringify({
                    from_cents: ancienCout,
                    to_cents: item.unit_cost_cents,
                    purchase_id: purchaseId,
                    purchase_reference: purchase.reference ?? null,
                  }),
                ],
              )
            }
          }

          // La dépense, écrite une fois pour toutes par l'achat lui-même.
          let expenseId: string | null = null
          if (total > 0) {
            const libelle = `Achat ${purchase.reference}`
            const expenseQ = await client.query(
              `INSERT INTO expenses(organization_id, site_id, category, amount_cents, payment_method,
                 cash_session_id, description, reference, purchase_id, created_by)
               VALUES($1,$2,'supply',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
              [
                t.organizationId,
                siteId,
                total,
                input.payment_method,
                cashSessionId,
                libelle,
                input.invoice_reference || null,
                purchaseId,
                t.userId,
              ],
            )
            expenseId = String(expenseQ.rows[0].id)

            if (cashSessionId) {
              await client.query(
                `INSERT INTO cash_movements(organization_id, cash_session_id, type, amount_cents, source, description, expense_id, created_by)
                 VALUES($1,$2,'exit',$3,'expense',$4,$5,$6)`,
                [t.organizationId, cashSessionId, total, libelle, expenseId, t.userId],
              )
            }
          }

          await client.query(
            "INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id) VALUES($1,$2,'purchase.created','purchase',$3)",
            [t.organizationId, t.userId, purchaseId],
          )
          await client.query("COMMIT")
          return { status: 201, body: { ...purchase, expense_id: expenseId } }
        } catch (error) {
          await client.query("ROLLBACK")
          throw error
        } finally {
          client.release()
        }
      })
    }),
  )

  r.post(
    "/purchases/:id/cancel",
    requirePermission("purchase:manage"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(purchaseValidators.cancel, req.body)
      const pool = db()
      const client = await pool.connect()
      try {
        await client.query("BEGIN")

        const purchaseQ = await client.query(
          "SELECT id, status, cash_session_id, reference FROM purchases WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
          [id, t.organizationId],
        )
        if (!purchaseQ.rowCount) throw new HttpError(404, "purchase_not_found", "Achat introuvable.")
        if (purchaseQ.rows[0].status === "cancelled") {
          throw new HttpError(409, "purchase_already_cancelled", "Cet achat est déjà annulé.")
        }
        const purchase = purchaseQ.rows[0]

        const rendu = await reversePurchaseEntries(client, t.organizationId, id, t.userId)

        // La dépense n'est pas effacée : elle est marquée annulée. Le
        // rapprochement d'un relevé reste possible, et l'historique garde la
        // trace qu'une sortie d'argent a bien été saisie puis reprise.
        await client.query(
          "UPDATE expenses SET status='cancelled' WHERE organization_id=$1::uuid AND purchase_id=$2::uuid AND status<>'cancelled'",
          [t.organizationId, id],
        )

        // L'argent ne revient au tiroir que si la journée est encore ouverte.
        // Une caisse close a été comptée et signée : la rouvrir par un
        // mouvement rétroactif rendrait faux le comptage déjà validé.
        let caisseRecreditee = false
        if (purchase.cash_session_id) {
          const sessionQ = await client.query("SELECT status FROM cash_sessions WHERE id=$1::uuid AND organization_id=$2::uuid", [
            purchase.cash_session_id,
            t.organizationId,
          ])
          if (sessionQ.rowCount && sessionQ.rows[0].status === "open") {
            const montant = await client.query(
              "SELECT amount_cents FROM expenses WHERE organization_id=$1::uuid AND purchase_id=$2::uuid",
              [t.organizationId, id],
            )
            if (montant.rowCount) {
              await client.query(
                `INSERT INTO cash_movements(organization_id, cash_session_id, type, amount_cents, source, description, created_by)
                 VALUES($1,$2,'entry',$3,'adjustment',$4,$5)`,
                [
                  t.organizationId,
                  purchase.cash_session_id,
                  montant.rows[0].amount_cents,
                  `Achat ${purchase.reference} annulé : remboursement en caisse`,
                  t.userId,
                ],
              )
              caisseRecreditee = true
            }
          }
        }

        await client.query(
          `UPDATE purchases SET status='cancelled', cancelled_at=now(), cancellation_reason=$3, cancelled_by=$4
           WHERE id=$1::uuid AND organization_id=$2::uuid`,
          [id, t.organizationId, input.reason, t.userId],
        )
        await client.query(
          `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
           VALUES($1,$2,'purchase.cancelled','purchase',$3,$4)`,
          [t.organizationId, t.userId, id, JSON.stringify({ reason: input.reason, lignes_rendues: rendu })],
        )
        await client.query("COMMIT")
        res.json({
          id,
          status: "cancelled",
          reversed_lines: rendu,
          cash_refunded: caisseRecreditee,
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

/**
 * Retire du stock ce qu'un achat annulé n'aurait jamais dû y faire entrer.
 *
 * Contrepassation, jamais suppression : l'entrée d'origine reste lisible dans
 * l'historique du produit. Le `NOT EXISTS` sur `reverses_movement_id` fait le
 * reste — une annulation rejouée ne retire pas la marchandise deux fois.
 *
 * Le stock peut passer en négatif si les sachets ont déjà été consommés entre
 * l'achat et son annulation. C'est voulu, et c'est la même règle que partout
 * ailleurs dans le produit : un négatif est un signal rouge qui appelle un
 * inventaire, jamais un blocage qui empêcherait de corriger une erreur.
 */
export async function reversePurchaseEntries(
  client: TxClient,
  organizationId: string,
  purchaseId: string,
  userId: string | null,
): Promise<number> {
  const aContrepasser = await client.query(
    `SELECT m.id, m.product_id, m.site_id, m.quantity_milli, m.unit_cost_cents
     FROM stock_movements m
     WHERE m.organization_id=$1::uuid AND m.purchase_id=$2::uuid AND m.kind='entry'
       AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = m.id)`,
    [organizationId, purchaseId],
  )
  for (const mouvement of aContrepasser.rows) {
    await client.query(
      `INSERT INTO stock_movements(organization_id, product_id, site_id, purchase_id, kind, quantity_milli,
         unit_cost_cents, reason, reverses_movement_id, created_by)
       VALUES($1,$2,$3,$4,'reversal',$5,$6,'Achat annulé : entrée reprise',$7,$8)`,
      [
        organizationId,
        mouvement.product_id,
        mouvement.site_id,
        purchaseId,
        -Number(mouvement.quantity_milli),
        mouvement.unit_cost_cents,
        mouvement.id,
        userId,
      ],
    )
  }
  return aContrepasser.rows.length
}
