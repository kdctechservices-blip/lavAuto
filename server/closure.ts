import type { Router } from "express"
import { z } from "zod"
import type { Pool } from "pg"
import { getPool } from "./db.ts"
import { asyncRoute, body, tenant, requirePermission, parseId, HttpError } from "./http.ts"
import { adminDb } from "./platform-admin.ts"
import { logConsoleAction } from "./console-auth.ts"

// ---------------------------------------------------------------------------
// Demande de clôture émise par le client
//
// Jusqu'ici, un gérant qui voulait quitter WashPilot devait le demander par
// l'assistance et attendre qu'un humain s'en saisisse. Un client doit pouvoir
// sortir sans négocier : c'est une question de loyauté, et accessoirement la
// meilleure façon d'apprendre pourquoi il part.
//
// Ce que cette demande n'est PAS — et c'est l'essentiel :
//
//   • Ce n'est pas une suppression. Rien ne s'efface, rien ne se ferme. La
//     station continue d'encaisser exactement comme avant. Un gérant qui
//     clique un soir de découragement ne perd pas sa caisse du lendemain.
//   • Ce n'est pas irréversible. Tant que l'éditeur n'a pas tranché, le
//     client retire sa demande d'un clic.
//   • Ce n'est pas automatique. L'effacement réel reste la décision de
//     l'éditeur, qui dispose déjà pour cela d'une suppression en deux temps.
//
// Le motif est obligatoire et un peu long à écrire — vingt caractères. Ce
// n'est pas une friction de rétention : c'est la seule information qui a de
// la valeur dans un départ. « trop cher » et « je ferme la station » ne
// demandent pas la même réponse.
//
// Les routes vivent sous `/subscription`, ce qui n'est pas qu'un rangement :
// ce préfixe est exempté du blocage en lecture seule. Un client dont l'essai
// est échu est précisément celui qui veut partir ; lui répondre « payez
// d'abord » serait grotesque.
// ---------------------------------------------------------------------------

const PENDING = "pending"

function db(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

type ClosureRow = {
  id: string
  reason: string
  status: string
  created_at: string
  requested_by_email: string
  resolution_note: string | null
  resolved_at: string | null
}

function publicShape(row: ClosureRow) {
  return {
    id: row.id,
    reason: row.reason,
    status: row.status,
    created_at: row.created_at,
    requested_by_email: row.requested_by_email,
    resolution_note: row.resolution_note,
    resolved_at: row.resolved_at,
  }
}

/**
 * Marque comme « acceptée » la demande en attente d'une station.
 *
 * Appelée quand l'éditeur programme effectivement la clôture. Sans cela, la
 * demande resterait indéfiniment dans la file alors qu'elle a été exaucée, et
 * l'éditeur la traiterait deux fois.
 *
 * Exportée pour être appelable depuis la route de suppression, et testable
 * directement : par l'API, un contrôle de statut en amont peut masquer ce que
 * cette fonction fait réellement.
 */
export async function acceptPendingClosure(
  pool: Pool,
  organizationId: string,
  operatorEmail: string,
  note: string,
): Promise<boolean> {
  const q = await pool.query(
    `UPDATE closure_requests
        SET status = 'accepted', resolved_by_email = $2, resolution_note = $3, resolved_at = now()
      WHERE organization_id = $1::uuid AND status = '${PENDING}'`,
    [organizationId, operatorEmail, note],
  )
  return (q.rowCount ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Côté client
// ---------------------------------------------------------------------------

export function registerClosureRoutes(r: Router): void {
  // GET /api/v1/subscription/closure — l'état de ma demande, s'il y en a une.
  r.get(
    "/subscription/closure",
    requirePermission("subscription:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query(
        `SELECT id, reason, status, created_at, requested_by_email, resolution_note, resolved_at
           FROM closure_requests
          WHERE organization_id = $1::uuid
          ORDER BY created_at DESC
          LIMIT 1`,
        [t.organizationId],
      )
      const row = q.rows[0] as ClosureRow | undefined
      // Une demande résolue n'est pas « en cours » : on la renvoie quand même,
      // pour que le client voie la réponse de l'éditeur, mais le drapeau dit
      // clairement s'il reste quelque chose en attente.
      res.json({
        request: row ? publicShape(row) : null,
        pending: row?.status === PENDING,
      })
    }),
  )

  // POST /api/v1/subscription/closure — demander la clôture.
  r.post(
    "/subscription/closure",
    requirePermission("subscription:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(
        z
          .object({ reason: z.string().trim().min(20).max(1000) })
          .strip(),
        req.body,
      )

      const pool = db()
      const who = await pool.query("SELECT email FROM users WHERE id = $1::uuid", [t.userId])
      const email = String(who.rows[0]?.email ?? "")

      // L'index partiel garantit l'unicité d'une demande en attente ; on
      // traduit sa violation en message métier plutôt qu'en erreur 500.
      try {
        const q = await pool.query(
          `INSERT INTO closure_requests(organization_id, requested_by, requested_by_email, reason)
           VALUES($1::uuid, $2::uuid, $3, $4)
           RETURNING id, reason, status, created_at, requested_by_email, resolution_note, resolved_at`,
          [t.organizationId, t.userId, email, input.reason],
        )
        await pool.query(
          `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
           VALUES($1::uuid, $2::uuid, 'account.closure_requested', 'organization', $1::text, $3::jsonb)`,
          [t.organizationId, t.userId, JSON.stringify({ reason: input.reason })],
        )
        res.status(201).json({ request: publicShape(q.rows[0] as ClosureRow), pending: true })
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code === "23505") {
          throw new HttpError(
            409,
            "closure_already_requested",
            "Une demande de clôture est déjà en cours d'examen.",
          )
        }
        throw error
      }
    }),
  )

  // POST /api/v1/subscription/closure/cancel — finalement, je reste.
  r.post(
    "/subscription/closure/cancel",
    requirePermission("subscription:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const pool = db()
      const q = await pool.query(
        `UPDATE closure_requests
            SET status = 'cancelled', resolved_at = now()
          WHERE organization_id = $1::uuid AND status = '${PENDING}'
          RETURNING id`,
        [t.organizationId],
      )
      if (!q.rowCount) {
        throw new HttpError(
          404,
          "closure_request_not_found",
          "Aucune demande de clôture en cours.",
        )
      }
      await pool.query(
        `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES($1::uuid, $2::uuid, 'account.closure_cancelled', 'organization', $1::text, '{}'::jsonb)`,
        [t.organizationId, t.userId],
      )
      res.json({ request: null, pending: false })
    }),
  )
}

// ---------------------------------------------------------------------------
// Côté éditeur
// ---------------------------------------------------------------------------

export function registerClosureConsoleRoutes(r: Router): void {
  // GET /api/v1/console/closure-requests — la file des départs annoncés.
  r.get(
    "/closure-requests",
    asyncRoute(async (req, res) => {
      const status = String(req.query.status ?? PENDING)
      if (!["pending", "cancelled", "accepted", "declined", "all"].includes(status)) {
        throw new HttpError(400, "invalid_status", "Statut de filtre inconnu.")
      }
      const q = await adminDb().query(
        `SELECT c.id, c.organization_id, o.name AS organization_name, c.reason, c.status,
                c.requested_by_email, c.created_at, c.resolution_note, c.resolved_at,
                c.resolved_by_email
           FROM closure_requests c
           JOIN organizations o ON o.id = c.organization_id
          WHERE ($1 = 'all' OR c.status = $1)
          ORDER BY c.created_at DESC
          LIMIT 200`,
        [status],
      )
      res.json({ requests: q.rows })
    }),
  )

  // POST /api/v1/console/closure-requests/:id/decline — refuser, en expliquant.
  //
  // Refuser une demande de départ n'est pas retenir quelqu'un de force : la
  // station reste libre de ne plus payer. C'est répondre « voici pourquoi je
  // pense que vous devriez rester », ou « votre contrat court jusqu'en mars ».
  // Le motif est donc obligatoire, et le client le lit.
  r.post(
    "/closure-requests/:id/decline",
    asyncRoute(async (req, res) => {
      const id = parseId(req.params.id)
      const operator = req.operator!
      const input = body(
        z.object({ note: z.string().trim().min(10).max(1000) }).strip(),
        req.body,
      )

      const pool = adminDb()
      const q = await pool.query(
        `UPDATE closure_requests
            SET status = 'declined', resolved_by_email = $2, resolution_note = $3, resolved_at = now()
          WHERE id = $1::uuid AND status = '${PENDING}'
          RETURNING organization_id`,
        [id, operator.email, input.note],
      )
      if (!q.rowCount) {
        throw new HttpError(
          404,
          "closure_request_not_found",
          "Cette demande n'existe pas ou a déjà été traitée.",
        )
      }

      const organizationId = String(q.rows[0].organization_id)
      await logConsoleAction(pool, operator, "closure.declined", organizationId, null, {
        note: input.note,
      })
      res.json({ id, status: "declined" })
    }),
  )
}
