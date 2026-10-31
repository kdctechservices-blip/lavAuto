import { Router } from "express"
import type { Pool } from "pg"
import { getPool } from "./db.ts"
import { asyncRoute, tenant, requirePermission, HttpError } from "./http.ts"

// ---------------------------------------------------------------------------
// Sauvegarde et récupération des données
//
// Deux niveaux complémentaires :
//   1. Export applicatif (ici) : un fichier JSON contenant **toutes** les
//      données de l'organisation, téléchargeable par le propriétaire à tout
//      moment, y compris quand l'essai est terminé (jamais de données prises
//      en otage). C'est une lecture : aucune restriction d'abonnement.
//   2. Sauvegarde serveur : `scripts/db-backup.sh` (pg_dump) pour la base
//      complète, documentée dans AUDIT-FONCTIONNEL.md.
// ---------------------------------------------------------------------------

function db(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

/** Requêtes d'export, dans l'ordre de restauration (parents puis enfants). */
export const EXPORT_QUERIES: { key: string; sql: string }[] = [
  { key: "organization", sql: "SELECT id, name, slug, onboarding_completed, created_at FROM organizations WHERE id=$1::uuid" },
  {
    key: "members",
    sql: `SELECT m.id, m.role, m.created_at, u.email, u.first_name, u.last_name, u.phone, u.status
          FROM organization_members m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id=$1::uuid ORDER BY m.created_at`,
  },
  { key: "subscription", sql: `SELECT s.status, s.current_period_end, s.created_at, s.updated_at, p.code AS plan_code, p.name AS plan_name
          FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.organization_id=$1::uuid` },
  { key: "sites", sql: "SELECT * FROM sites WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "service_categories", sql: "SELECT * FROM service_categories WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "vehicle_categories", sql: "SELECT * FROM vehicle_categories WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "services", sql: "SELECT * FROM services WHERE organization_id=$1::uuid ORDER BY created_at" },
  {
    key: "service_vehicle_prices",
    sql: `SELECT p.* FROM service_vehicle_prices p JOIN services s ON s.id = p.service_id
          WHERE s.organization_id=$1::uuid ORDER BY p.service_id`,
  },
  { key: "workers", sql: "SELECT * FROM workers WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "customers", sql: "SELECT * FROM customers WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "washes", sql: "SELECT * FROM washes WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "notifications", sql: "SELECT * FROM notifications WHERE organization_id=$1::uuid ORDER BY created_at" },
  {
    key: "wash_items",
    sql: `SELECT i.* FROM wash_items i JOIN washes w ON w.id = i.wash_id
          WHERE w.organization_id=$1::uuid ORDER BY i.wash_id`,
  },
  {
    key: "wash_assignments",
    sql: `SELECT a.* FROM wash_assignments a JOIN washes w ON w.id = a.wash_id
          WHERE w.organization_id=$1::uuid ORDER BY a.wash_id`,
  },
  { key: "payments", sql: "SELECT * FROM payments WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "cash_sessions", sql: "SELECT * FROM cash_sessions WHERE organization_id=$1::uuid ORDER BY opened_at" },
  { key: "cash_movements", sql: "SELECT * FROM cash_movements WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "utility_meters", sql: "SELECT * FROM utility_meters WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "utility_readings", sql: "SELECT * FROM utility_readings WHERE organization_id=$1::uuid ORDER BY reading_date, created_at" },
  { key: "utility_reading_photos", sql: "SELECT * FROM utility_reading_photos WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "expenses", sql: "SELECT * FROM expenses WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "product_categories", sql: "SELECT * FROM product_categories WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "products", sql: "SELECT * FROM products WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "stock_movements", sql: "SELECT * FROM stock_movements WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "service_consumables", sql: "SELECT * FROM service_consumables WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "suppliers", sql: "SELECT * FROM suppliers WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "purchases", sql: "SELECT * FROM purchases WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "purchase_items", sql: "SELECT * FROM purchase_items WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "work_schedules", sql: "SELECT * FROM work_schedules WHERE organization_id=$1::uuid ORDER BY created_at" },
  { key: "attendance_records", sql: "SELECT * FROM attendance_records WHERE organization_id=$1::uuid ORDER BY work_date" },
  { key: "closure_requests", sql: "SELECT * FROM closure_requests WHERE organization_id=$1::uuid ORDER BY created_at" },
  {
    key: "audit_logs",
    sql: `SELECT action, entity_type, entity_id, metadata, created_at FROM audit_logs
          WHERE organization_id=$1::uuid ORDER BY created_at DESC LIMIT 5000`,
  },
]

export interface BackupPayload {
  format: string
  version: number
  exported_at: string
  organization_id: string
  counts: Record<string, number>
  data: Record<string, unknown>
}

/** Construit l'export complet d'une organisation. */
export async function buildOrganizationBackup(pool: Pool, organizationId: string): Promise<BackupPayload> {
  const data: Record<string, unknown> = {}
  const counts: Record<string, number> = {}

  for (const { key, sql } of EXPORT_QUERIES) {
    const result = await pool.query(sql, [organizationId])
    if (key === "organization" || key === "subscription") {
      data[key] = result.rows[0] ?? null
      counts[key] = result.rowCount ?? 0
    } else {
      data[key] = result.rows
      counts[key] = result.rows.length
    }
  }

  return {
    format: "washpilot.backup",
    version: 1,
    exported_at: new Date().toISOString(),
    organization_id: organizationId,
    counts,
    data,
  }
}

/** Nom de fichier lisible et trié chronologiquement. */
export function backupFileName(organizationName: string | null, date = new Date()): string {
  const slug = (organizationName ?? "washpilot")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "washpilot"
  return `washpilot-sauvegarde-${slug}-${date.toISOString().slice(0, 10)}.json`
}

export function createBackupRouter() {
  const r = Router()

  // GET /api/v1/backup/summary — ce que contient la sauvegarde, sans la produire.
  r.get(
    "/backup/summary",
    requirePermission("data:export"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const pool = db()
      const [counts, last] = await Promise.all([
        pool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM washes WHERE organization_id=$1::uuid) AS washes,
             (SELECT COUNT(*)::int FROM payments WHERE organization_id=$1::uuid) AS payments,
             (SELECT COUNT(*)::int FROM expenses WHERE organization_id=$1::uuid) AS expenses,
             (SELECT COUNT(*)::int FROM utility_readings WHERE organization_id=$1::uuid) AS utility_readings,
             (SELECT COUNT(*)::int FROM cash_sessions WHERE organization_id=$1::uuid) AS cash_sessions,
             (SELECT COUNT(*)::int FROM workers WHERE organization_id=$1::uuid) AS workers,
             (SELECT COUNT(*)::int FROM services WHERE organization_id=$1::uuid) AS services,
             (SELECT COUNT(*)::int FROM sites WHERE organization_id=$1::uuid) AS sites`,
          [t.organizationId],
        ),
        pool.query(
          `SELECT created_at FROM audit_logs
           WHERE organization_id=$1::uuid AND action='backup.exported'
           ORDER BY created_at DESC LIMIT 1`,
          [t.organizationId],
        ),
      ])
      res.json({
        counts: counts.rows[0],
        last_export_at: last.rows[0]?.created_at ?? null,
      })
    }),
  )

  // GET /api/v1/backup/export — téléchargement de la sauvegarde complète.
  r.get(
    "/backup/export",
    requirePermission("data:export"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const pool = db()
      const payload = await buildOrganizationBackup(pool, t.organizationId)
      const organizationName =
        (payload.data.organization as { name?: string } | null)?.name ?? null

      await pool.query(
        `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES($1::uuid,$2::uuid,'backup.exported','organization',$1::text,$3::jsonb)`,
        [t.organizationId, t.userId, JSON.stringify({ counts: payload.counts })],
      )

      res.setHeader("Content-Type", "application/json; charset=utf-8")
      res.setHeader("Content-Disposition", `attachment; filename="${backupFileName(organizationName)}"`)
      res.send(JSON.stringify(payload, null, 2))
    }),
  )

  return r
}
