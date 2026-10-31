import { Router } from "express"
import { z } from "zod"
import { asyncRoute, body, tenant, requirePermission, HttpError } from "./http.ts"
import { getPool } from "./db.ts"

// ---------------------------------------------------------------------------
// Notifications persistées
//
// La table `notifications` existait déjà et recevait bien des lignes — par
// exemple « Lavage terminé » à la clôture d'un lavage — mais **aucune route ne
// les lisait**. La base écrivait donc des faits que personne ne pouvait voir :
// une promesse silencieusement perdue, et le genre de moitié de fonctionnalité
// qu'on croit livrée parce que le code qui écrit existe.
//
// Ces routes ferment la boucle. Trois propriétés sont volontaires :
//
//   • **Portée par organisation.** Une notification ne traverse jamais
//     l'isolation entre stations, même si elle est adressée à un utilisateur.
//
//   • **`user_id` NULL = pour toute l'équipe.** C'est ainsi que le lavage
//     terminé est diffusé : le caissier et le laveur le voient tous les deux.
//     Une notification nominative ne s'affiche qu'à la personne concernée.
//
//   • **La lecture (`read_at`) est persistée**, et non seulement gardée dans le
//     navigateur : deux appareils de la même station doivent s'accorder sur ce
//     qui a été vu, sinon l'alerte revit à chaque changement d'appareil.
// ---------------------------------------------------------------------------

export const notificationValidators = {
  list: z
    .object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      unread_only: z
        .enum(["true", "false"])
        .default("false")
        .transform((value) => value === "true"),
    })
    .strip(),
}

const NOTIFICATION_FIELDS = `id, type, title, message, site_id, entity_type, entity_id, read_at, created_at`

/**
 * Une notification est visible par un membre si elle vise toute l'équipe
 * (`user_id IS NULL`) ou si elle le vise lui. Le filtre est répété dans chaque
 * requête d'écriture : une notification d'un autre membre ne se marque pas
 * lue, et l'identifiant d'une autre organisation ne se devine pas.
 *
 * Le rang du paramètre est explicite : selon la requête, l'utilisateur est le
 * deuxième ou le troisième. Le figer à `$2` faisait écrire `read_at` sur des
 * lignes d'autres stations — une erreur silencieuse, attrapée par
 * `tests/database-wiring.test.ts`.
 */
function visible(userParam: 2 | 3): string {
  return `(user_id IS NULL OR user_id = $${userParam}::uuid)`
}

export function createNotificationsRouter(): Router {
  const r = Router()

  // GET /api/v1/notifications — les dernières notifications de l'équipe.
  r.get(
    "/notifications",
    requirePermission("wash:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const query = body(notificationValidators.list, req.query)
      const pool = getPool()
      if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")

      const q = await pool.query(
        `SELECT ${NOTIFICATION_FIELDS}
           FROM notifications
          WHERE organization_id = $1::uuid
            AND ${visible(2)}
            ${query.unread_only ? "AND read_at IS NULL" : ""}
          ORDER BY created_at DESC
          LIMIT $3`,
        [t.organizationId, t.userId, query.limit],
      )

      const unread = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM notifications
          WHERE organization_id = $1::uuid AND ${visible(2)} AND read_at IS NULL`,
        [t.organizationId, t.userId],
      )

      res.json({
        notifications: q.rows.map((row) => ({
          id: String(row.id),
          type: String(row.type),
          title: String(row.title),
          message: String(row.message),
          site_id: row.site_id ? String(row.site_id) : null,
          entity_type: row.entity_type ? String(row.entity_type) : null,
          entity_id: row.entity_id ? String(row.entity_id) : null,
          read_at: row.read_at ? new Date(row.read_at as string).toISOString() : null,
          created_at: new Date(row.created_at as string).toISOString(),
        })),
        unread_count: Number(unread.rows[0]?.count ?? 0),
      })
    }),
  )

  // POST /api/v1/notifications/read-all — tout marquer lu.
  // Déclarée avant `/:id/read` pour que « read-all » ne soit pas pris pour un
  // identifiant : Express teste les routes dans l'ordre de déclaration.
  r.post(
    "/notifications/read-all",
    requirePermission("wash:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const pool = getPool()
      if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
      const q = await pool.query(
        `UPDATE notifications
            SET read_at = now()
          WHERE organization_id = $1::uuid AND ${visible(2)} AND read_at IS NULL
          RETURNING id`,
        [t.organizationId, t.userId],
      )
      res.json({ updated: q.rowCount ?? 0 })
    }),
  )

  // POST /api/v1/notifications/:id/read — marquer une notification comme vue.
  // Idempotent : revoir une notification déjà lue laisse sa date de lecture
  // intacte, plutôt que de la déplacer à chaque ouverture de l'écran.
  r.post(
    "/notifications/:id/read",
    requirePermission("wash:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const pool = getPool()
      if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
      const q = await pool.query(
        `UPDATE notifications
            SET read_at = COALESCE(read_at, now())
          WHERE id = $1::uuid AND organization_id = $2::uuid AND ${visible(3)}
          RETURNING id, read_at`,
        [req.params.id, t.organizationId, t.userId],
      )
      if (!q.rowCount) {
        throw new HttpError(404, "notification_not_found", "Cette notification n'existe pas.")
      }
      res.json({
        id: String(q.rows[0].id),
        read_at: new Date(q.rows[0].read_at as string).toISOString(),
      })
    }),
  )

  return r
}
