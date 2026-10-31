/**
 * Gestion des comptes depuis la console de l'éditeur.
 *
 * Ces routes existent pour une raison concrète : **le support reçoit l'appel
 * d'une personne, pas d'une station.** « Bonjour, je n'arrive plus à me
 * connecter » arrive sans nom de station, souvent sans que l'appelant sache
 * s'il est propriétaire ou caissier. Le reste de la console est organisé par
 * station ; il fallait une entrée par personne.
 *
 * Deux distinctions structurent tout le module, et les confondre est
 * exactement ce qui a cassé la première version :
 *
 *   - **l'appartenance** (`organization_members.status`) dit si quelqu'un
 *     travaille encore dans *cette* station ;
 *   - **le compte** (`users.status`) dit si la personne peut se connecter,
 *     *où que ce soit*.
 *
 * Quelqu'un qui travaille sur deux stations peut quitter l'une sans perdre
 * l'autre. Et un compte compromis doit pouvoir être bloqué partout d'un
 * seul geste. Ce sont deux besoins réels, donc deux gestes.
 */

import type { Router } from "express"
import type { Pool, PoolClient } from "pg"
import { z } from "zod"
import { asyncRoute, body, parseId } from "./http.ts"
import { HttpError } from "./auth.ts"
import { adminDb, auditPlatformAction } from "./platform-admin.ts"
import { logConsoleAction } from "./console-auth.ts"
import { ROLES, ROLE_LABELS, type Role } from "./permissions.ts"

type Queryable = Pick<Pool | PoolClient, "query">

/** Motif obligatoire : une action sur le compte d'autrui doit s'expliquer. */
const reasonField = z
  .string()
  .trim()
  .min(5, "Indiquez en quelques mots la raison de cette intervention.")
  .max(300)

/**
 * Les stations où cette personne est le dernier propriétaire actif.
 *
 * Sert de garde-fou partagé : retirer son rôle, suspendre son appartenance
 * ou bloquer son compte laisserait chacune de ces stations sans personne
 * pour inviter, facturer ou gérer l'équipe. Le client appellerait le
 * lendemain pour un problème que l'éditeur aurait lui-même créé.
 *
 * `excludeOrganizationId` sert au cas du changement de rôle, où l'on teste
 * une station précise.
 */
async function soleOwnerOf(
  pool: Queryable,
  userId: string,
  only?: string,
): Promise<Array<{ organization_id: string; name: string }>> {
  const q = await pool.query(
    `SELECT o.id AS organization_id, o.name
       FROM organization_members m
       JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1::uuid
        AND m.role = 'owner'
        AND m.status = 'active'
        AND ($2::uuid IS NULL OR m.organization_id = $2::uuid)
        AND o.deletion_requested_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM organization_members other
           WHERE other.organization_id = m.organization_id
             AND other.user_id <> m.user_id
             AND other.role = 'owner'
             AND other.status = 'active')`,
    [userId, only ?? null],
  )
  return q.rows as Array<{ organization_id: string; name: string }>
}

function lastOwnerError(stations: Array<{ name: string }>): HttpError {
  const names = stations.map((s) => s.name).join(", ")
  return new HttpError(
    409,
    "last_owner",
    `Cette personne est le dernier propriétaire actif de : ${names}. Nommez d'abord un autre propriétaire.`,
  )
}

/** Fiche d'un compte : qui il est, où il travaille, depuis quand. */
const ACCOUNT_SELECT = `u.id, u.email, u.first_name, u.last_name, u.phone, u.status,
  u.created_at,
  (SELECT max(s.last_used_at) FROM auth_sessions s WHERE s.user_id = u.id) AS last_seen_at,
  (SELECT count(*)::int FROM auth_sessions s
    WHERE s.user_id = u.id AND s.expires_at > now()) AS active_sessions,
  (SELECT count(*)::int FROM organization_members m WHERE m.user_id = u.id) AS memberships`

export function registerAccountRoutes(r: Router): void {
  // -------------------------------------------------------------------------
  // GET /api/v1/console/accounts — retrouver une personne dans tout le parc.
  //
  // Recherche sur l'adresse, le nom et le téléphone : au téléphone, on n'a
  // pas toujours l'orthographe exacte, mais on a presque toujours l'un des
  // trois.
  // -------------------------------------------------------------------------
  r.get(
    "/accounts",
    asyncRoute(async (req, res) => {
      const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : ""
      const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 200)

      const values: unknown[] = []
      let where = ""
      if (search) {
        values.push(`%${search.toLowerCase()}%`)
        where = `WHERE lower(u.email) LIKE $1
                    OR lower(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) LIKE $1
                    OR coalesce(u.phone,'') LIKE $1`
      }

      const q = await adminDb().query(
        `SELECT ${ACCOUNT_SELECT} FROM users u ${where}
          ORDER BY u.created_at DESC LIMIT ${limit}`,
        values,
      )
      res.json({ accounts: q.rows, query: search })
    }),
  )

  // -------------------------------------------------------------------------
  // GET /api/v1/console/accounts/:userId — la personne et toutes ses stations.
  // -------------------------------------------------------------------------
  r.get(
    "/accounts/:userId",
    asyncRoute(async (req, res) => {
      const userId = parseId(req.params.userId)
      const pool = adminDb()

      const q = await pool.query(`SELECT ${ACCOUNT_SELECT} FROM users u WHERE u.id = $1::uuid`, [
        userId,
      ])
      if (!q.rowCount) throw new HttpError(404, "not_found", "Ce compte n'existe pas.")

      const memberships = await pool.query(
        `SELECT m.organization_id, o.name AS organization_name, o.slug,
                m.role, m.status, m.created_at, m.disabled_at,
                o.deletion_requested_at,
                (SELECT count(*)::int FROM member_permissions mp
                  WHERE mp.organization_id = m.organization_id AND mp.user_id = m.user_id)
                  AS permission_overrides
           FROM organization_members m
           JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = $1::uuid
          ORDER BY (m.role = 'owner') DESC, o.name ASC`,
        [userId],
      )

      const sessions = await pool.query(
        `SELECT created_at, last_used_at, expires_at
           FROM auth_sessions WHERE user_id = $1::uuid AND expires_at > now()
          ORDER BY last_used_at DESC NULLS LAST LIMIT 10`,
        [userId],
      )

      res.json({
        account: q.rows[0],
        memberships: memberships.rows,
        sessions: sessions.rows,
        // Signalé à part : c'est la contrainte qui bloquera la plupart des
        // gestes, autant que l'opérateur la voie avant d'essayer.
        sole_owner_of: await soleOwnerOf(pool, userId),
      })
    }),
  )

  // -------------------------------------------------------------------------
  // POST /api/v1/console/accounts/:userId/status — bloquer le compte partout.
  //
  // Le geste fort : la personne ne se connecte plus nulle part. Réservé au
  // compte compromis ou au départ définitif. Pour retirer quelqu'un d'une
  // seule station, c'est l'appartenance qu'il faut suspendre.
  //
  // `users.status` n'accepte que 'active' ou 'inactive' — la première version
  // de cette route écrivait 'disabled' et tombait en 500 sur la contrainte.
  // -------------------------------------------------------------------------
  r.post(
    "/accounts/:userId/status",
    asyncRoute(async (req, res) => {
      const userId = parseId(req.params.userId)
      const operator = req.operator!
      const input = body(
        z.object({ status: z.enum(["active", "inactive"]), reason: reasonField }).strip(),
        req.body,
      )

      const pool = adminDb()
      const current = await pool.query(
        "SELECT email, status FROM users WHERE id = $1::uuid",
        [userId],
      )
      if (!current.rowCount) throw new HttpError(404, "not_found", "Ce compte n'existe pas.")
      const { email } = current.rows[0] as { email: string; status: string }

      if (input.status === "inactive") {
        const blocking = await soleOwnerOf(pool, userId)
        if (blocking.length) throw lastOwnerError(blocking)
      }

      await pool.query("UPDATE users SET status = $2, updated_at = now() WHERE id = $1::uuid", [
        userId,
        input.status,
      ])
      if (input.status === "inactive") {
        // Bloquer sans couper les sessions ouvertes ne bloquerait rien avant
        // leur expiration — jusqu'à trente jours.
        await pool.query("DELETE FROM auth_sessions WHERE user_id = $1::uuid", [userId])
      }

      // La trace est portée dans chaque station concernée : le propriétaire
      // doit pouvoir constater chez lui qu'un de ses comptes a été bloqué.
      const orgs = await pool.query(
        `SELECT m.organization_id, o.name FROM organization_members m
           JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = $1::uuid`,
        [userId],
      )
      const action = input.status === "active" ? "account.enabled" : "account.disabled"
      for (const row of orgs.rows as Array<{ organization_id: string; name: string }>) {
        await auditPlatformAction(pool, row.organization_id, operator.email, action, userId, {
          email,
          reason: input.reason,
        })
      }
      await logConsoleAction(pool, operator, action, null, null, {
        email,
        reason: input.reason,
        organizations: orgs.rows.length,
      })

      res.json({ user_id: userId, email, status: input.status })
    }),
  )

  // -------------------------------------------------------------------------
  // POST /api/v1/console/accounts/:userId/revoke-sessions — déconnecter partout.
  //
  // Le geste du téléphone perdu. Il ne bloque pas le compte : la personne
  // peut se reconnecter avec son mot de passe. C'est volontaire — couper
  // l'accès et forcer une reconnexion sont deux réponses différentes, et
  // celle-ci est la plus légère.
  // -------------------------------------------------------------------------
  r.post(
    "/accounts/:userId/revoke-sessions",
    asyncRoute(async (req, res) => {
      const userId = parseId(req.params.userId)
      const operator = req.operator!
      const input = body(z.object({ reason: reasonField }).strip(), req.body)

      const pool = adminDb()
      const current = await pool.query("SELECT email FROM users WHERE id = $1::uuid", [userId])
      if (!current.rowCount) throw new HttpError(404, "not_found", "Ce compte n'existe pas.")
      const { email } = current.rows[0] as { email: string }

      const removed = await pool.query("DELETE FROM auth_sessions WHERE user_id = $1::uuid", [
        userId,
      ])

      await logConsoleAction(pool, operator, "account.sessions_revoked", null, null, {
        email,
        reason: input.reason,
        sessions: removed.rowCount ?? 0,
      })

      res.json({ user_id: userId, email, revoked: removed.rowCount ?? 0 })
    }),
  )

  // -------------------------------------------------------------------------
  // POST .../members/:userId/role — changer le rôle, transférer la propriété.
  //
  // Le cas qui justifie cette route : le propriétaire a quitté l'entreprise,
  // personne ne peut plus administrer la station. Sans elle, le client est
  // dans une impasse dont il ne peut pas sortir seul — précisément la
  // situation où il appelle l'éditeur.
  //
  // Transférer la propriété se fait en deux temps assumés : nommer le nouveau
  // propriétaire, puis rétrograder l'ancien. Le garde-fou `last_owner`
  // n'autorise la seconde étape qu'une fois la première faite, ce qui rend
  // l'ordre impossible à inverser.
  // -------------------------------------------------------------------------
  r.post(
    "/organizations/:id/members/:userId/role",
    asyncRoute(async (req, res) => {
      const organizationId = parseId(req.params.id)
      const userId = parseId(req.params.userId)
      const operator = req.operator!
      const input = body(
        z.object({ role: z.enum(ROLES), reason: reasonField }).strip(),
        req.body,
      )

      const pool = adminDb()
      const client = await pool.connect()
      try {
        await client.query("BEGIN")

        // `FOR UPDATE` : deux opérateurs qui rétrogradent les deux derniers
        // propriétaires en même temps passeraient tous deux le garde-fou.
        const currentQ = await client.query(
          `SELECT m.role, m.status, u.email, o.name AS organization_name
             FROM organization_members m
             JOIN users u ON u.id = m.user_id
             JOIN organizations o ON o.id = m.organization_id
            WHERE m.organization_id = $1::uuid AND m.user_id = $2::uuid
            FOR UPDATE OF m`,
          [organizationId, userId],
        )
        if (!currentQ.rowCount) {
          throw new HttpError(404, "member_not_found", "Ce compte n'appartient pas à cette station.")
        }
        const current = currentQ.rows[0] as {
          role: Role
          status: string
          email: string
          organization_name: string
        }

        if (current.role === input.role) {
          throw new HttpError(409, "role_unchanged", `Ce compte est déjà ${ROLE_LABELS[input.role]}.`)
        }

        if (current.role === "owner" && input.role !== "owner") {
          const blocking = await soleOwnerOf(client, userId, organizationId)
          if (blocking.length) throw lastOwnerError(blocking)
        }

        await client.query(
          `UPDATE organization_members
              SET role = $3, updated_at = now()
            WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
          [organizationId, userId, input.role],
        )

        // Les exceptions accordées l'ont été pour l'ancien périmètre. Les
        // conserver donnerait au nouveau rôle des droits que personne n'a
        // consciemment décidés — un caissier rétrogradé depuis gérant
        // garderait l'accès au journal d'audit.
        const dropped = await client.query(
          "DELETE FROM member_permissions WHERE organization_id = $1::uuid AND user_id = $2::uuid",
          [organizationId, userId],
        )

        await auditPlatformAction(
          client as unknown as Pool,
          organizationId,
          operator.email,
          "member.role_changed",
          userId,
          {
            email: current.email,
            before: current.role,
            after: input.role,
            reason: input.reason,
            permission_overrides_cleared: dropped.rowCount ?? 0,
          },
        )
        await client.query("COMMIT")

        // Sur la connexion déjà ouverte : appeler le pool ici laisserait un
        // code tenter la requête pendant que le client est encore tenu.
        await logConsoleAction(
          client,
          operator,
          "member.role_changed",
          organizationId,
          current.organization_name,
          { email: current.email, before: current.role, after: input.role, reason: input.reason },
        )

        res.json({
          user_id: userId,
          email: current.email,
          role: input.role,
          role_label: ROLE_LABELS[input.role],
          previous_role: current.role,
          permission_overrides_cleared: dropped.rowCount ?? 0,
        })
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {})
        throw error
      } finally {
        client.release()
      }
    }),
  )
}
