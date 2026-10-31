// ---------------------------------------------------------------------------
// Stock : produits, catégories, mouvements.
//
// Un seul principe gouverne ce module : **le stock n'est jamais écrit, il est
// toujours recalculé**. Il n'existe pas de colonne « quantité en stock » dans
// la base ; le stock d'un produit est la somme signée de ses mouvements.
//
// Conséquences, toutes voulues :
//   • aucune route ne permet de « fixer » un stock. Pour le corriger, on
//     enregistre un inventaire, qui écrit l'écart constaté ;
//   • un mouvement ne se modifie ni ne se supprime. On le contrepasse par un
//     mouvement inverse qui le référence. Même le propriétaire ne peut pas
//     réécrire le passé ;
//   • chaque mouvement fige le coût unitaire du moment, comme `wash_items`
//     fige le prix d'une prestation.
// ---------------------------------------------------------------------------

import { Router } from "express"
import { z } from "zod"
import type { Pool } from "pg"
import { getPool } from "./db.ts"
import { asyncRoute, body, tenant, parseId, requirePermission } from "./http.ts"
import { HttpError } from "./auth.ts"
import { requireCapability } from "./entitlements.ts"
import { fingerprint, withIdempotency } from "./idempotency.ts"
import { signedQuantity, canApply, isLowStock, inventoryDelta, UNITS } from "./stock-rules.ts"

function db(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

/** Quantité en millièmes d'unité. Plafonnée à un million d'unités. */
const quantityMilli = z.number().int().positive().max(1_000_000_000)

export const stockValidators = {
  category: z
    .object({
      name: z.string().trim().min(1, "Donnez un nom à la catégorie.").max(120),
    })
    .strip(),
  product: z
    .object({
      name: z.string().trim().min(1, "Donnez un nom au produit.").max(200),
      category_id: z.string().uuid().nullable().optional(),
      unit: z.enum(UNITS).default("unite"),
      unit_cost_cents: z.number().int().min(0).max(100_000_000).default(0),
      low_stock_threshold_milli: z.number().int().min(0).max(1_000_000_000).default(0),
      initial_quantity_milli: z.number().int().min(0).max(1_000_000_000).default(0),
    })
    .strip(),
  productPatch: z
    .object({
      name: z.string().trim().min(1).max(200).optional(),
      category_id: z.string().uuid().nullable().optional(),
      unit_cost_cents: z.number().int().min(0).max(100_000_000).optional(),
      low_stock_threshold_milli: z.number().int().min(0).max(1_000_000_000).optional(),
      is_active: z.boolean().optional(),
    })
    .strip(),
  movement: z
    .object({
      product_id: z.string().uuid(),
      kind: z.enum(["entry", "exit"]),
      quantity_milli: quantityMilli,
      site_id: z.string().uuid().nullable().optional(),
      reason: z.string().trim().max(500).nullable().optional(),
      reference: z.string().trim().max(120).nullable().optional(),
    })
    .strip(),
  inventory: z
    .object({
      counted_milli: z.number().int().min(0).max(1_000_000_000),
      reason: z.string().trim().max(500).nullable().optional(),
    })
    .strip(),
  consumables: z
    .object({
      items: z
        .array(
          z.object({
            product_id: z.string().uuid(),
            quantity_milli: quantityMilli,
          }),
        )
        .max(20),
    })
    .strip(),
  reversal: z
    .object({
      reason: z.string().trim().min(1, "Indiquez pourquoi ce mouvement est annulé.").max(500),
    })
    .strip(),
}

const PRODUCT_FIELDS = `p.id, p.name, p.category_id, p.unit, p.unit_cost_cents, p.unit_cost_updated_at,
  p.low_stock_threshold_milli, p.is_active, p.created_at`

const MOVEMENT_FIELDS = `m.id, m.product_id, m.site_id, m.kind, m.quantity_milli,
  m.unit_cost_cents, m.reason, m.reference, m.reverses_movement_id, m.wash_id, m.purchase_id, m.created_at`

/**
 * Stock courant d'un produit, verrou posé.
 *
 * Le `FOR UPDATE` sur la ligne produit sérialise les mouvements concurrents :
 * sans lui, deux sorties simultanées pourraient chacune constater un stock
 * suffisant et le faire passer en négatif à elles deux.
 */
async function lockedStock(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> },
  organizationId: string,
  productId: string,
): Promise<{ product: Record<string, unknown>; stockMilli: number }> {
  const productQ = await client.query(
    `SELECT id, name, unit, unit_cost_cents, low_stock_threshold_milli, is_active
     FROM products WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE`,
    [productId, organizationId],
  )
  if (!productQ.rowCount) throw new HttpError(404, "product_not_found", "Produit introuvable.")

  const stockQ = await client.query(
    `SELECT COALESCE(SUM(quantity_milli),0)::int AS stock_milli
     FROM stock_movements WHERE product_id=$1::uuid AND organization_id=$2::uuid`,
    [productId, organizationId],
  )
  return {
    product: productQ.rows[0],
    stockMilli: Number(stockQ.rows[0].stock_milli ?? 0),
  }
}

/** Vérifie qu'une station appartient bien à l'organisation appelante. */
async function assertSite(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
  organizationId: string,
  siteId: string | null,
): Promise<void> {
  if (!siteId) return
  const q = await client.query("SELECT 1 FROM sites WHERE id=$1::uuid AND organization_id=$2::uuid", [
    siteId,
    organizationId,
  ])
  if (!q.rowCount) throw new HttpError(400, "invalid_site", "Station invalide.")
}

/**
 * Type minimal d'un client de transaction, pour que les deux fonctions
 * ci-dessous soient appelables depuis la transaction d'un lavage.
 */
type TxClient = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
}

/**
 * Déduit du stock ce qu'un lavage a consommé.
 *
 * Appelée **dans la transaction d'enregistrement du lavage** : si le lavage
 * échoue, rien n'est déduit ; s'il est enregistré, la déduction l'est aussi.
 *
 * Trois choix importants, tous assumés :
 *
 * 1. **Cette déduction n'est jamais refusée**, même si le stock tombe en
 *    négatif. Un lavage rendu est de l'argent qui rentre : refuser de
 *    l'enregistrer parce que le stock déclaré est faux serait absurde, et
 *    pousserait simplement à ne plus enregistrer les lavages. Le produit a
 *    réellement été utilisé — c'est le stock enregistré qui est faux, pas le
 *    lavage. Un stock négatif s'affiche en rouge et appelle un inventaire.
 *    C'est la différence avec une sortie manuelle, qui reste bloquée parce
 *    que son auteur peut corriger sa saisie sur-le-champ.
 *
 * 2. **La consommation ne touche pas au prix.** Le prix d'une prestation est
 *    fixé à la main dans sa fiche et ne se déduit d'aucun coût.
 *
 * 3. Chaque mouvement porte le `wash_id`, pour pouvoir contrepasser
 *    exactement ce qui a été déduit si le lavage est annulé.
 */
export async function consumeForWash(
  client: TxClient,
  organizationId: string,
  washId: string,
  items: readonly { service_id: string; quantity: number }[],
  userId: string | null,
): Promise<void> {
  if (items.length === 0) return

  // Une seule requête pour toutes les recettes concernées : un lavage à cinq
  // prestations ne doit pas déclencher cinq allers-retours.
  const serviceIds = [...new Set(items.map((item) => item.service_id))]
  const recettes = await client.query(
    `SELECT sc.service_id, sc.product_id, sc.quantity_milli, p.unit_cost_cents
     FROM service_consumables sc
     JOIN products p ON p.id = sc.product_id
     WHERE sc.organization_id=$1::uuid AND sc.service_id = ANY($2::uuid[]) AND p.is_active`,
    [organizationId, serviceIds],
  )
  if (!recettes.rowCount) return

  // Un même produit peut servir à plusieurs prestations du même lavage :
  // on cumule avant d'écrire, pour une ligne par produit plutôt qu'une par
  // couple prestation-produit.
  const parProduit = new Map<string, { quantite: number; cout: number }>()
  for (const item of items) {
    for (const recette of recettes.rows) {
      if (recette.service_id !== item.service_id) continue
      const productId = String(recette.product_id)
      const ajout = Number(recette.quantity_milli) * item.quantity
      const courant = parProduit.get(productId)
      if (courant) courant.quantite += ajout
      else parProduit.set(productId, { quantite: ajout, cout: Number(recette.unit_cost_cents) })
    }
  }

  for (const [productId, { quantite, cout }] of parProduit) {
    await client.query(
      `INSERT INTO stock_movements(organization_id, product_id, wash_id, kind, quantity_milli,
         unit_cost_cents, reason, created_by)
       VALUES($1,$2,$3,'consumption',$4,$5,'Consommation automatique du lavage',$6)`,
      [organizationId, productId, washId, -quantite, cout, userId],
    )
  }
}

/**
 * Rend au stock ce qu'un lavage annulé n'a finalement pas consommé.
 *
 * Contrepassation, jamais suppression : les mouvements d'origine restent
 * lisibles dans l'historique du produit, et l'index unique sur
 * `reverses_movement_id` garantit qu'une annulation rejouée ne rend pas le
 * produit deux fois.
 */
export async function reverseWashConsumption(
  client: TxClient,
  organizationId: string,
  washId: string,
  userId: string | null,
): Promise<void> {
  const aContrepasser = await client.query(
    `SELECT m.id, m.product_id, m.quantity_milli, m.unit_cost_cents
     FROM stock_movements m
     WHERE m.organization_id=$1::uuid AND m.wash_id=$2::uuid AND m.kind='consumption'
       AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r.reverses_movement_id = m.id)`,
    [organizationId, washId],
  )
  for (const mouvement of aContrepasser.rows) {
    await client.query(
      `INSERT INTO stock_movements(organization_id, product_id, wash_id, kind, quantity_milli,
         unit_cost_cents, reason, reverses_movement_id, created_by)
       VALUES($1,$2,$3,'reversal',$4,$5,'Lavage annulé : consommation rendue au stock',$6,$7)`,
      [
        organizationId,
        mouvement.product_id,
        washId,
        -Number(mouvement.quantity_milli),
        mouvement.unit_cost_cents,
        mouvement.id,
        userId,
      ],
    )
  }
}

export function createStockRouter() {
  const r = Router()

  // ------------------------------------------------------------ catégories --

  r.get(
    "/product-categories",
    requirePermission("stock:read"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query(
        `SELECT id, name, is_active, created_at FROM product_categories
         WHERE organization_id=$1::uuid ORDER BY name`,
        [t.organizationId],
      )
      res.json(q.rows)
    }),
  )

  r.post(
    "/product-categories",
    requirePermission("stock:manage"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(stockValidators.category, req.body)
      const existing = await db().query(
        "SELECT 1 FROM product_categories WHERE organization_id=$1::uuid AND lower(name)=lower($2)",
        [t.organizationId, input.name],
      )
      if (existing.rowCount) {
        throw new HttpError(409, "category_exists", "Une catégorie porte déjà ce nom.")
      }
      const q = await db().query(
        `INSERT INTO product_categories(organization_id, name) VALUES($1,$2)
         RETURNING id, name, is_active, created_at`,
        [t.organizationId, input.name],
      )
      res.status(201).json(q.rows[0])
    }),
  )

  // --------------------------------------------------------------- produits --

  // Le stock est calculé ici, par agrégation des mouvements. C'est la seule
  // définition du stock dans tout le produit.
  r.get(
    "/products",
    requirePermission("stock:read"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query(
        `SELECT ${PRODUCT_FIELDS}, c.name AS category_name,
                COALESCE(SUM(m.quantity_milli),0)::int AS stock_milli
         FROM products p
         LEFT JOIN product_categories c ON c.id = p.category_id
         LEFT JOIN stock_movements m ON m.product_id = p.id
         WHERE p.organization_id=$1::uuid
         GROUP BY p.id, c.name
         ORDER BY p.is_active DESC, p.name`,
        [t.organizationId],
      )
      res.json(
        q.rows.map((row) => ({
          ...row,
          low_stock: isLowStock(Number(row.stock_milli), Number(row.low_stock_threshold_milli)),
        })),
      )
    }),
  )

  r.post(
    "/products",
    requirePermission("stock:manage"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(stockValidators.product, req.body)
      const pool = db()
      const client = await pool.connect()
      try {
        await client.query("BEGIN")

        const existing = await client.query(
          "SELECT 1 FROM products WHERE organization_id=$1::uuid AND lower(name)=lower($2)",
          [t.organizationId, input.name],
        )
        if (existing.rowCount) {
          throw new HttpError(409, "product_exists", "Un produit porte déjà ce nom.")
        }

        if (input.category_id) {
          const catQ = await client.query(
            "SELECT 1 FROM product_categories WHERE id=$1::uuid AND organization_id=$2::uuid",
            [input.category_id, t.organizationId],
          )
          if (!catQ.rowCount) throw new HttpError(400, "invalid_category", "Catégorie invalide.")
        }

        const q = await client.query(
          `INSERT INTO products(organization_id, category_id, name, unit, unit_cost_cents,
             low_stock_threshold_milli, created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7)
           RETURNING id, name, category_id, unit, unit_cost_cents, low_stock_threshold_milli, is_active, created_at`,
          [
            t.organizationId,
            input.category_id ?? null,
            input.name,
            input.unit,
            input.unit_cost_cents,
            input.low_stock_threshold_milli,
            t.userId,
          ],
        )
        const product = q.rows[0]

        // Le stock d'ouverture est un mouvement comme un autre : il laisse une
        // trace datée et signée, au lieu d'apparaître de nulle part.
        if (input.initial_quantity_milli > 0) {
          await client.query(
            `INSERT INTO stock_movements(organization_id, product_id, kind, quantity_milli,
               unit_cost_cents, reason, created_by)
             VALUES($1,$2,'initial',$3,$4,'Stock initial à la création du produit',$5)`,
            [t.organizationId, product.id, input.initial_quantity_milli, input.unit_cost_cents, t.userId],
          )
        }

        await client.query(
          `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
           VALUES($1,$2,'product.created','product',$3,$4)`,
          [
            t.organizationId,
            t.userId,
            product.id,
            JSON.stringify({ name: product.name, initial_quantity_milli: input.initial_quantity_milli }),
          ],
        )
        await client.query("COMMIT")
        res.status(201).json({ ...product, stock_milli: input.initial_quantity_milli })
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }),
  )

  // Modifie la fiche produit — jamais son stock. Il n'existe volontairement
  // aucun champ de quantité dans ce validateur.
  r.patch(
    "/products/:id",
    requirePermission("stock:manage"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(stockValidators.productPatch, req.body)
      const client = await db().connect()
      try {
        await client.query("BEGIN")
        const oldQ = await client.query(
          `SELECT id, name, category_id, unit, unit_cost_cents, low_stock_threshold_milli, is_active
           FROM products WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE`,
          [id, t.organizationId],
        )
        if (!oldQ.rowCount) throw new HttpError(404, "product_not_found", "Produit introuvable.")
        const old = oldQ.rows[0]

        if (input.category_id) {
          const catQ = await client.query(
            "SELECT 1 FROM product_categories WHERE id=$1::uuid AND organization_id=$2::uuid",
            [input.category_id, t.organizationId],
          )
          if (!catQ.rowCount) throw new HttpError(400, "invalid_category", "Catégorie invalide.")
        }

        if (input.name && input.name.toLowerCase() !== String(old.name).toLowerCase()) {
          const dup = await client.query(
            "SELECT 1 FROM products WHERE organization_id=$1::uuid AND lower(name)=lower($2) AND id <> $3::uuid",
            [t.organizationId, input.name, id],
          )
          if (dup.rowCount) throw new HttpError(409, "product_exists", "Un produit porte déjà ce nom.")
        }

        const merged = { ...old, ...input }
        const q = await client.query(
          // Corriger le cout a la main efface la marque laissee par le dernier
          // achat : l'ecran ne doit pas continuer a annoncer « prix paye le... »
          // alors que le chiffre vient d'etre retape.
          `UPDATE products SET name=$3, category_id=$4, unit_cost_cents=$5,
             low_stock_threshold_milli=$6, is_active=$7,
             unit_cost_updated_at = CASE WHEN $5 <> unit_cost_cents THEN NULL ELSE unit_cost_updated_at END
           WHERE id=$1::uuid AND organization_id=$2::uuid
           RETURNING id, name, category_id, unit, unit_cost_cents, unit_cost_updated_at,
                     low_stock_threshold_milli, is_active, created_at`,
          [
            id,
            t.organizationId,
            merged.name,
            merged.category_id ?? null,
            merged.unit_cost_cents,
            merged.low_stock_threshold_milli,
            merged.is_active,
          ],
        )

        await client.query(
          `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
           VALUES($1,$2,'product.updated','product',$3,$4)`,
          [
            t.organizationId,
            t.userId,
            id,
            JSON.stringify({
              unit_cost_cents: { from: old.unit_cost_cents, to: merged.unit_cost_cents },
            }),
          ],
        )
        await client.query("COMMIT")
        res.json(q.rows[0])
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }),
  )

  // -------------------------------------------------------------- mouvements --

  r.get(
    "/stock-movements",
    requirePermission("stock:read"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const productId = typeof req.query.product_id === "string" ? parseId(req.query.product_id) : null
      const q = await db().query(
        `SELECT ${MOVEMENT_FIELDS}, p.name AS product_name, p.unit,
                u.first_name, u.last_name, w.reference AS wash_reference,
                pu.reference AS purchase_reference
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN users u ON u.id = m.created_by
         LEFT JOIN washes w ON w.id = m.wash_id AND w.organization_id = m.organization_id
         LEFT JOIN purchases pu ON pu.id = m.purchase_id AND pu.organization_id = m.organization_id
         WHERE m.organization_id=$1::uuid AND ($2::uuid IS NULL OR m.product_id=$2::uuid)
         ORDER BY m.created_at DESC LIMIT 200`,
        [t.organizationId, productId],
      )
      res.json(q.rows)
    }),
  )

  r.post(
    "/stock-movements",
    requirePermission("stock:move"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(stockValidators.movement, req.body)
      const pool = db()

      await withIdempotency(
        pool,
        req,
        res,
        t.organizationId,
        fingerprint({ op: "stock_movement", ...input }),
        async () => {
          const client = await pool.connect()
          try {
            await client.query("BEGIN")
            await assertSite(client, t.organizationId, input.site_id ?? null)

            const { product, stockMilli } = await lockedStock(client, t.organizationId, input.product_id)
            if (!product.is_active) {
              throw new HttpError(409, "product_archived", "Ce produit est archivé. Réactivez-le avant de le mouvementer.")
            }

            const signed = signedQuantity(input.kind, input.quantity_milli)
            if (!canApply(stockMilli, signed)) {
              throw new HttpError(
                409,
                "insufficient_stock",
                "Le stock disponible ne permet pas cette sortie. Enregistrez un inventaire si le stock réel est différent.",
              )
            }

            const q = await client.query(
              `INSERT INTO stock_movements(organization_id, product_id, site_id, kind, quantity_milli,
                 unit_cost_cents, reason, reference, created_by)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${MOVEMENT_FIELDS.replace(/m\./g, "")}`,
              [
                t.organizationId,
                input.product_id,
                input.site_id ?? null,
                input.kind,
                signed,
                product.unit_cost_cents,
                input.reason || null,
                input.reference || null,
                t.userId,
              ],
            )
            const movement = q.rows[0]

            await client.query(
              `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
               VALUES($1,$2,'stock.moved','stock_movement',$3,$4)`,
              [
                t.organizationId,
                t.userId,
                movement.id,
                JSON.stringify({
                  product_id: input.product_id,
                  kind: input.kind,
                  quantity_milli: signed,
                  stock_after_milli: stockMilli + signed,
                }),
              ],
            )
            await client.query("COMMIT")
            return { status: 201, body: { ...movement, stock_milli: stockMilli + signed } }
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

  // Inventaire : on n'écrit pas le stock compté, on écrit l'écart. Le
  // mouvement garde ainsi la mémoire de l'erreur au lieu de l'effacer.
  r.post(
    "/products/:id/inventory",
    requirePermission("stock:move"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(stockValidators.inventory, req.body)
      const client = await db().connect()
      try {
        await client.query("BEGIN")
        const { product, stockMilli } = await lockedStock(client, t.organizationId, id)
        const delta = inventoryDelta(input.counted_milli, stockMilli)

        if (delta === 0) {
          await client.query("COMMIT")
          res.json({ movement: null, stock_milli: stockMilli, delta_milli: 0 })
          return
        }

        const q = await client.query(
          `INSERT INTO stock_movements(organization_id, product_id, kind, quantity_milli,
             unit_cost_cents, reason, created_by)
           VALUES($1,$2,'inventory',$3,$4,$5,$6) RETURNING ${MOVEMENT_FIELDS.replace(/m\./g, "")}`,
          [
            t.organizationId,
            id,
            delta,
            product.unit_cost_cents,
            input.reason || `Inventaire physique : ${input.counted_milli} millièmes comptés`,
            t.userId,
          ],
        )

        await client.query(
          `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
           VALUES($1,$2,'stock.inventory','stock_movement',$3,$4)`,
          [
            t.organizationId,
            t.userId,
            q.rows[0].id,
            JSON.stringify({
              product_id: id,
              theorique_milli: stockMilli,
              compte_milli: input.counted_milli,
              ecart_milli: delta,
            }),
          ],
        )
        await client.query("COMMIT")
        res.status(201).json({ movement: q.rows[0], stock_milli: input.counted_milli, delta_milli: delta })
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }),
  )

  // Contrepassation : la seule façon d'annuler un mouvement. L'original reste
  // en base, intact et visible.
  r.post(
    "/stock-movements/:id/reverse",
    requirePermission("stock:move"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(stockValidators.reversal, req.body)
      const client = await db().connect()
      try {
        await client.query("BEGIN")
        const originalQ = await client.query(
          `SELECT id, product_id, site_id, kind, quantity_milli, unit_cost_cents
           FROM stock_movements WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE`,
          [id, t.organizationId],
        )
        if (!originalQ.rowCount) throw new HttpError(404, "movement_not_found", "Mouvement introuvable.")
        const original = originalQ.rows[0]

        if (original.kind === "reversal") {
          throw new HttpError(409, "already_reversal", "Une contrepassation ne peut pas être contrepassée.")
        }
        const alreadyQ = await client.query(
          "SELECT 1 FROM stock_movements WHERE reverses_movement_id=$1::uuid AND organization_id=$2::uuid",
          [id, t.organizationId],
        )
        if (alreadyQ.rowCount) {
          throw new HttpError(409, "already_reversed", "Ce mouvement a déjà été contrepassé.")
        }

        const { stockMilli } = await lockedStock(client, t.organizationId, String(original.product_id))
        const inverse = -Number(original.quantity_milli)
        if (!canApply(stockMilli, inverse)) {
          throw new HttpError(
            409,
            "insufficient_stock",
            "Annuler cette entrée rendrait le stock négatif : une partie a déjà été consommée.",
          )
        }

        const q = await client.query(
          `INSERT INTO stock_movements(organization_id, product_id, site_id, kind, quantity_milli,
             unit_cost_cents, reason, reverses_movement_id, created_by)
           VALUES($1,$2,$3,'reversal',$4,$5,$6,$7,$8) RETURNING ${MOVEMENT_FIELDS.replace(/m\./g, "")}`,
          [
            t.organizationId,
            original.product_id,
            original.site_id,
            inverse,
            original.unit_cost_cents,
            input.reason,
            id,
            t.userId,
          ],
        )

        await client.query(
          `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
           VALUES($1,$2,'stock.reversed','stock_movement',$3,$4)`,
          [
            t.organizationId,
            t.userId,
            q.rows[0].id,
            JSON.stringify({ reverses: id, reason: input.reason, quantity_milli: inverse }),
          ],
        )
        await client.query("COMMIT")
        res.status(201).json({ ...q.rows[0], stock_milli: stockMilli + inverse })
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    }),
  )

  // ------------------------------------------- recette d'une prestation --
  //
  // Ce que consomme une prestation appartient à sa fiche, au même titre que
  // son prix : c'est donc `service:manage` qui en décide, pas une permission
  // de stock. Un caissier qui enregistre un lavage déclenche la déduction
  // sans détenir le moindre droit sur le stock — c'est le système qui agit,
  // pas lui.

  r.get(
    "/services/:id/consumables",
    requirePermission("service:read"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const q = await db().query(
        `SELECT sc.product_id, sc.quantity_milli, p.name AS product_name, p.unit, p.is_active
         FROM service_consumables sc
         JOIN products p ON p.id = sc.product_id
         WHERE sc.organization_id=$1::uuid AND sc.service_id=$2::uuid
         ORDER BY p.name`,
        [t.organizationId, id],
      )
      res.json(q.rows)
    }),
  )

  // Remplace la recette entière. Plus simple à utiliser qu'un couple
  // ajouter/retirer, et sans état intermédiaire incohérent : à tout instant
  // la recette enregistrée est celle que le gérant a sous les yeux.
  r.put(
    "/services/:id/consumables",
    requirePermission("service:manage"),
    requireCapability("stock.manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(stockValidators.consumables, req.body)

      const client = await db().connect()
      try {
        await client.query("BEGIN")
        const serviceQ = await client.query(
          "SELECT id FROM services WHERE id=$1::uuid AND organization_id=$2::uuid FOR UPDATE",
          [id, t.organizationId],
        )
        if (!serviceQ.rowCount) throw new HttpError(404, "service_not_found", "Prestation introuvable.")

        const productIds = input.items.map((item) => item.product_id)
        if (new Set(productIds).size !== productIds.length) {
          throw new HttpError(400, "duplicate_product", "Un même produit ne peut figurer qu'une fois dans la recette.")
        }
        if (productIds.length > 0) {
          const connus = await client.query(
            "SELECT id FROM products WHERE organization_id=$1::uuid AND id = ANY($2::uuid[])",
            [t.organizationId, productIds],
          )
          if (connus.rowCount !== productIds.length) {
            throw new HttpError(400, "invalid_product", "Produit inconnu dans cette station.")
          }
        }

        await client.query(
          "DELETE FROM service_consumables WHERE organization_id=$1::uuid AND service_id=$2::uuid",
          [t.organizationId, id],
        )
        for (const item of input.items) {
          await client.query(
            `INSERT INTO service_consumables(organization_id, service_id, product_id, quantity_milli)
             VALUES($1,$2,$3,$4)`,
            [t.organizationId, id, item.product_id, item.quantity_milli],
          )
        }

        await client.query(
          `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
           VALUES($1,$2,'service.consumables_updated','service',$3,$4)`,
          [t.organizationId, t.userId, id, JSON.stringify({ count: input.items.length })],
        )
        await client.query("COMMIT")

        const q = await client.query(
          `SELECT sc.product_id, sc.quantity_milli, p.name AS product_name, p.unit, p.is_active
           FROM service_consumables sc JOIN products p ON p.id = sc.product_id
           WHERE sc.organization_id=$1::uuid AND sc.service_id=$2::uuid ORDER BY p.name`,
          [t.organizationId, id],
        )
        res.json(q.rows)
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
