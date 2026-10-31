import { Router } from "express"
import { getPool } from "./db.ts"
import { HttpError } from "./auth.ts"
import { asyncRoute, parseId, requirePermission, tenant } from "./http.ts"
import { getUtilityInsights } from "./utility-analysis.ts"

export function createUtilityInsightsRouter(): Router {
  const r = Router()

  r.get(
    "/utility-insights",
    requirePermission("expense:read"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const siteId = parseId(req.query.site_id as string)
      const pool = getPool()
      if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
      const client = await pool.connect()
      try {
        const site = await client.query(
          "SELECT 1 FROM sites WHERE id=$1::uuid AND organization_id=$2::uuid",
          [siteId, t.organizationId],
        )
        if (!site.rowCount) throw new HttpError(404, "site_not_found", "Station introuvable.")
        const dateQ = await client.query("SELECT CURRENT_DATE::text AS end_date")
        const insights = await getUtilityInsights(
          client,
          t.organizationId,
          siteId,
          String(dateQ.rows[0].end_date).slice(0, 10),
        )
        res.json(insights)
      } finally {
        client.release()
      }
    }),
  )

  return r
}
