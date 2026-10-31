/**
 * Historique des opérations et traçabilité.
 *
 * La table `audit_logs` était alimentée depuis le début par les routes
 * sensibles — lavages, dépenses, caisse, remboursements, accès — mais rien
 * ne permettait de la lire. La promesse « historique et traçabilité » était
 * donc tenue côté écriture et invisible côté utilisateur.
 *
 * Ce routeur expose la lecture, avec filtres et pagination. Il n'expose
 * **aucune** écriture : un journal qui peut être modifié depuis l'interface
 * ne vaut rien comme preuve. La correction d'une erreur passe par une
 * nouvelle opération, jamais par la retouche de l'historique.
 */

import { Router } from "express"
import { z } from "zod"
import type { Pool } from "pg"
import { getPool } from "./db.ts"
import { asyncRoute, tenant, requirePermission } from "./http.ts"
import { requireCapability } from "./entitlements.ts"
import { HttpError } from "./auth.ts"

function db(): Pool {
  const pool = getPool()
  if (!pool) {
    throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  }
  return pool
}

/**
 * Libellés français des actions journalisées.
 *
 * Une clé technique (`cash_session.closed`) ne dit rien à un gérant. La
 * traduction vit côté serveur pour que l'export CSV et l'écran affichent
 * exactement la même chose.
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "wash.created": "Lavage enregistré",
  "wash.cancelled": "Lavage annulé",
  "payment.refunded": "Encaissement remboursé",
  "cash_session.closed": "Caisse clôturée",
  "expense.created": "Dépense enregistrée",
  "expense.updated": "Dépense modifiée",
  "expense.deleted": "Dépense supprimée",
  "member.access_updated": "Accès d’un membre modifié",
  "member.permission_granted": "Permission accordée",
  "member.permission_revoked": "Permission retirée",
  "member.permission_reset": "Permission réinitialisée",
  "access.denied": "Tentative refusée",
  "onboarding.completed": "Mise en service terminée",
  "backup.exported": "Sauvegarde exportée",

  // Référentiel du catalogue. Un changement de tarif ou de catégorie touche
  // l'argent du client : il doit laisser une trace, comme un lavage annulé.
  "vehicle_category.created": "Catégorie de véhicule créée",
  "vehicle_category.updated": "Catégorie de véhicule modifiée",
  "vehicle_category.deleted": "Catégorie de véhicule supprimée",
  "vehicle_category.imported": "Types de véhicules ajoutés au catalogue",
  "service.created": "Prestation créée",
  "service.updated": "Prestation modifiée",
  "service.consumables_updated": "Consommation de stock d’une prestation modifiée",
  "service.deleted": "Prestation supprimée",

  // Interventions de l'éditeur sur l'abonnement. Elles sont journalisées chez
  // le client et non dans un registre séparé : une action invisible de celui
  // qui la subit serait une porte dérobée, pas une administration.
  "subscription.upgrade_requested": "Activation demandée",
  "subscription.activated": "Forfait activé",
  "subscription.suspended": "Abonnement suspendu",
  "subscription.trial_extended": "Essai prolongé",
  "subscription.request_declined": "Demande d’activation déclinée",
}

/** Catégories d'entité, pour filtrer sans connaître les noms de tables. */
export const AUDIT_ENTITY_LABELS: Record<string, string> = {
  wash: "Lavage",
  payment: "Encaissement",
  cash_session: "Caisse",
  expense: "Dépense",
  organization_member: "Membre",
  organization: "Station",
  backup: "Sauvegarde",
  subscription: "Abonnement",
  plan: "Forfait",
  vehicle_category: "Catégorie de véhicule",
  service: "Prestation",
}

export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action
}

export function auditEntityLabel(entityType: string): string {
  return AUDIT_ENTITY_LABELS[entityType] ?? entityType
}

/**
 * Une tentative refusée est une information de sécurité, pas une opération
 * courante : elle est signalée pour que l'écran puisse la distinguer.
 */
export function auditSeverity(action: string): "info" | "warning" {
  // Une tentative refusée et une suspension d'abonnement méritent toutes deux
  // d'être repérables d'un coup d'œil : la première signale un accès forcé, la
  // seconde explique pourquoi la station est soudain passée en lecture seule.
  return action === "access.denied" || action === "subscription.suspended" ? "warning" : "info"
}

const querySchema = z.object({
  action: z.string().trim().max(60).optional(),
  entity_type: z.string().trim().max(40).optional(),
  actor_user_id: z.string().uuid().optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date de début invalide (AAAA-MM-JJ).")
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date de fin invalide (AAAA-MM-JJ).")
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export function createAuditLogRouter(): Router {
  const r = Router()

  /**
   * GET /api/v1/audit-logs
   *
   * Toujours filtré sur l'organisation du porteur de session : un
   * identifiant d'une autre station ne remonte jamais, même fourni
   * explicitement en paramètre.
   */
  r.get(
    "/audit-logs",
    requirePermission("audit:read"),
    requireCapability("audit.read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const parsed = querySchema.safeParse(req.query)
      if (!parsed.success) {
        throw new HttpError(
          400,
          "invalid_query",
          parsed.error.issues[0]?.message ?? "Filtres invalides."
        )
      }
      const q = parsed.data

      if (q.from && q.to && q.from > q.to) {
        throw new HttpError(
          400,
          "invalid_range",
          "La date de début doit précéder la date de fin."
        )
      }

      const where: string[] = ["a.organization_id = $1::uuid"]
      const params: unknown[] = [t.organizationId]

      if (q.action) {
        params.push(q.action)
        where.push(`a.action = $${params.length}`)
      }
      if (q.entity_type) {
        params.push(q.entity_type)
        where.push(`a.entity_type = $${params.length}`)
      }
      if (q.actor_user_id) {
        params.push(q.actor_user_id)
        where.push(`a.actor_user_id = $${params.length}::uuid`)
      }
      if (q.from) {
        params.push(q.from)
        where.push(`a.created_at >= $${params.length}::date`)
      }
      if (q.to) {
        // Borne incluse : `to` désigne la journée entière, pas son instant zéro.
        params.push(q.to)
        where.push(`a.created_at < ($${params.length}::date + INTERVAL '1 day')`)
      }

      const whereSql = where.join(" AND ")

      const totalQ = await db().query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM audit_logs a WHERE ${whereSql}`,
        params
      )

      const rowsQ = await db().query(
        `SELECT a.id, a.action, a.entity_type, a.entity_id, a.metadata,
                a.created_at, a.actor_user_id,
                COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), u.email)
                  AS actor_name
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE ${whereSql}
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.limit, q.offset]
      )

      res.json({
        entries: rowsQ.rows.map((row) => ({
          id: row.id,
          action: row.action,
          action_label: auditActionLabel(row.action),
          entity_type: row.entity_type,
          entity_label: auditEntityLabel(row.entity_type),
          entity_id: row.entity_id,
          actor_user_id: row.actor_user_id,
          // Une opération automatique ou un compte supprimé n'a pas de nom.
          actor_name: row.actor_name ?? "Système",
          severity: auditSeverity(row.action),
          metadata: row.metadata ?? {},
          created_at: row.created_at,
        })),
        total: totalQ.rows[0]?.count ?? 0,
        limit: q.limit,
        offset: q.offset,
      })
    })
  )

  /**
   * GET /api/v1/audit-logs/filters
   *
   * Les valeurs réellement présentes dans l'historique de cette station.
   * Proposer la liste complète des actions possibles remplirait le filtre
   * d'options qui ne renvoient rien.
   */
  r.get(
    "/audit-logs/filters",
    requirePermission("audit:read"),
    requireCapability("audit.read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)

      const actionsQ = await db().query<{ action: string; count: number }>(
        `SELECT action, COUNT(*)::int AS count
           FROM audit_logs WHERE organization_id = $1::uuid
          GROUP BY action ORDER BY action`,
        [t.organizationId]
      )

      const entitiesQ = await db().query<{ entity_type: string }>(
        `SELECT DISTINCT entity_type FROM audit_logs
          WHERE organization_id = $1::uuid ORDER BY entity_type`,
        [t.organizationId]
      )

      const actorsQ = await db().query(
        `SELECT DISTINCT a.actor_user_id AS id,
                COALESCE(NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), u.email)
                  AS name
           FROM audit_logs a
           JOIN users u ON u.id = a.actor_user_id
          WHERE a.organization_id = $1::uuid
          ORDER BY name`,
        [t.organizationId]
      )

      res.json({
        actions: actionsQ.rows.map((row) => ({
          value: row.action,
          label: auditActionLabel(row.action),
          count: row.count,
        })),
        entity_types: entitiesQ.rows.map((row) => ({
          value: row.entity_type,
          label: auditEntityLabel(row.entity_type),
        })),
        actors: actorsQ.rows.map((row) => ({ value: row.id, label: row.name })),
      })
    })
  )

  return r
}
