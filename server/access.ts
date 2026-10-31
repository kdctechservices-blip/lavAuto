import { Router } from "express"
import { z } from "zod"
import type { Pool, PoolClient } from "pg"
import { getPool } from "./db.ts"
import { asyncRoute, body, tenant, parseId, requirePermission, assertPermission, HttpError } from "./http.ts"
import { hashPassword } from "./auth.ts"
import { assertOrganizationUserCapacity } from "./tenant.ts"
import {
  PERMISSIONS,
  PERMISSION_LABELS,
  ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  OWNER_ONLY_PERMISSIONS,
  GRANTABLE_PERMISSIONS,
  effectivePermissions,
  isPermission,
  isRole,
  type Permission,
  type Role,
} from "./permissions.ts"

// ---------------------------------------------------------------------------
// Gestion des accès
//
// Le propriétaire attribue les rôles, accorde des exceptions et désactive les
// accès. Les garde-fous sont posés ici parce qu'ils relèvent du métier, pas de
// la simple vérification d'un droit :
//   • personne ne modifie son propre rôle ni ses propres droits ;
//   • une station conserve toujours au moins un propriétaire actif ;
//   • les permissions réservées au propriétaire ne sont jamais déléguées ;
//   • toute tentative refusée et toute modification acceptée sont journalisées.
// ---------------------------------------------------------------------------

function db(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

/** Journalise une action sensible (acceptée ou refusée). */
async function audit(
  client: Pool | PoolClient,
  organizationId: string,
  actorUserId: string,
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
) {
  await client.query(
    `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
     VALUES($1::uuid,$2::uuid,$3,'member',$4::text,$5::jsonb)`,
    [organizationId, actorUserId, action, entityId, JSON.stringify(metadata)],
  )
}

const MEMBER_SELECT = `m.user_id, m.role, m.status, m.created_at, m.disabled_at,
  u.email, u.first_name, u.last_name, u.phone`

interface MemberRow {
  user_id: string
  role: string
  status: string
  created_at: string
  disabled_at: string | null
  email: string
  first_name: string | null
  last_name: string | null
  phone: string | null
}

/** Nombre de propriétaires actifs restants, hors membre visé. */
async function activeOwnerCount(client: Pool | PoolClient, organizationId: string, excludeUserId?: string) {
  const q = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM organization_members
     WHERE organization_id=$1::uuid AND role='owner' AND status='active'
       AND ($2::uuid IS NULL OR user_id <> $2::uuid)`,
    [organizationId, excludeUserId ?? null],
  )
  return Number(q.rows[0].count)
}

export function createAccessRouter() {
  const r = Router()

  // GET /api/v1/me/permissions — ce que l'utilisateur connecté a le droit de faire.
  // Accessible à tous les membres : c'est la source unique utilisée par
  // l'interface pour afficher ou masquer les actions.
  r.get(
    "/me/permissions",
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      res.json({
        user_id: t.userId,
        organization_id: t.organizationId,
        role: t.role,
        role_label: isRole(t.role) ? ROLE_LABELS[t.role] : t.role,
        permissions: [...t.permissions].sort(),
        permission_labels: PERMISSION_LABELS,
      })
    }),
  )

  // GET /api/v1/access/roles — référentiel, pour l'écran de gestion des accès.
  r.get(
    "/access/roles",
    requirePermission("user:manage"),
    asyncRoute(async (req, res) => {
      tenant(req)
      res.json({
        roles: ROLES.map((role) => ({
          code: role,
          label: ROLE_LABELS[role],
          description: ROLE_DESCRIPTIONS[role],
          permissions: [...ROLE_PERMISSIONS[role]],
        })),
        permissions: PERMISSIONS.map((permission) => ({
          code: permission,
          label: PERMISSION_LABELS[permission],
          grantable: (GRANTABLE_PERMISSIONS as readonly string[]).includes(permission),
        })),
        owner_only: [...OWNER_ONLY_PERMISSIONS],
      })
    }),
  )

  // GET /api/v1/access/capacity — places disponibles sans exposer les comptes.
  // Un responsable peut créer des agents mais ne peut pas lire la liste des
  // utilisateurs : ces simples compteurs lui permettent néanmoins de connaître
  // le plafond du forfait avant d'ouvrir le formulaire.
  r.get(
    "/access/capacity",
    requirePermission("worker:create"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query<{ max_users: number | null; active_count: number }>(
        `SELECT p.max_users, COUNT(m.id)::int AS active_count FROM organizations o
         LEFT JOIN subscriptions s ON s.organization_id = o.id
         LEFT JOIN plans p ON p.id = s.plan_id
         LEFT JOIN organization_members m ON m.organization_id = o.id AND m.status = 'active'
         WHERE o.id = $1::uuid GROUP BY p.max_users`,
        [t.organizationId],
      )
      const row = q.rows[0]
      const maxUsers = row?.max_users == null ? null : Number(row.max_users)
      const activeUsers = Number(row?.active_count ?? 0)
      const remainingUsers = maxUsers === null ? null : Math.max(maxUsers - activeUsers, 0)
      res.json({
        max_users: maxUsers,
        active_users: activeUsers,
        remaining_users: remainingUsers,
        can_create: maxUsers === null || (remainingUsers ?? 0) > 0,
      })
    }),
  )

  // GET /api/v1/access/members — membres de la station et droits effectifs.
  r.get(
    "/access/members",
    requirePermission("user:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const pool = db()
      const [membersQ, overridesQ] = await Promise.all([
        pool.query<MemberRow>(
          `SELECT ${MEMBER_SELECT} FROM organization_members m
           JOIN users u ON u.id = m.user_id
           WHERE m.organization_id=$1::uuid
           ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'cashier' THEN 2 ELSE 3 END,
                    m.created_at`,
          [t.organizationId],
        ),
        pool.query<{ user_id: string; permission: string; granted: boolean }>(
          "SELECT user_id, permission, granted FROM member_permissions WHERE organization_id=$1::uuid",
          [t.organizationId],
        ),
      ])

      const members = membersQ.rows.map((member) => {
        const overrides = overridesQ.rows.filter((o) => o.user_id === member.user_id)
        return {
          ...member,
          is_self: member.user_id === t.userId,
          overrides: overrides.map(({ permission, granted }) => ({ permission, granted })),
          permissions: [...effectivePermissions(member.role, overrides)].sort(),
        }
      })

      res.json({ members })
    }),
  )

  // PATCH /api/v1/access/members/:userId — changer le rôle ou l'état d'un membre.
  r.patch(
    "/access/members/:userId",
    requirePermission("user:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const targetUserId = parseId(req.params.userId)
      const input = body(
        z
          .object({
            role: z.enum(ROLES).optional(),
            status: z.enum(["active", "disabled"]).optional(),
          })
          .strip()
          .refine((value) => value.role !== undefined || value.status !== undefined, {
            message: "Indiquez un rôle ou un statut.",
          }),
        req.body,
      )
      const pool = db()

      // Garde-fou : personne ne modifie son propre rôle ni son propre accès.
      // C'est la tentative d'escalade de privilèges la plus simple.
      if (targetUserId === t.userId) {
        await audit(pool, t.organizationId, t.userId, "access.denied", targetUserId, {
          attempted: input,
          reason: "self_modification",
        })
        throw new HttpError(
          403,
          "self_modification_forbidden",
          "Vous ne pouvez pas modifier votre propre rôle ni votre propre accès.",
        )
      }

      const client = await pool.connect()
      try {
        await client.query("BEGIN")

        const currentQ = await client.query<MemberRow>(
          `SELECT ${MEMBER_SELECT} FROM organization_members m
           JOIN users u ON u.id = m.user_id
           WHERE m.organization_id=$1::uuid AND m.user_id=$2::uuid FOR UPDATE OF m`,
          [t.organizationId, targetUserId],
        )
        const current = currentQ.rows[0]
        if (!current) throw new HttpError(404, "member_not_found", "Ce membre n’appartient pas à votre station.")

        const nextRole = (input.role ?? current.role) as Role
        const nextStatus = input.status ?? current.status

        // Garde-fou : une station garde toujours un propriétaire actif.
        const losesOwner =
          current.role === "owner" && (nextRole !== "owner" || nextStatus !== "active")
        if (losesOwner && (await activeOwnerCount(client, t.organizationId, targetUserId)) === 0) {
          throw new HttpError(
            409,
            "last_owner",
            "Cette station doit conserver au moins un propriétaire actif.",
          )
        }

        await client.query(
          `UPDATE organization_members
           SET role=$3, status=$4, disabled_at = CASE WHEN $4 = 'disabled' THEN now() ELSE NULL END,
               updated_by=$5::uuid, updated_at=now()
           WHERE organization_id=$1::uuid AND user_id=$2::uuid`,
          [t.organizationId, targetUserId, nextRole, nextStatus, t.userId],
        )

        // Un changement de rôle rend les exceptions précédentes caduques :
        // elles avaient été accordées pour un autre périmètre.
        if (input.role && input.role !== current.role) {
          await client.query(
            "DELETE FROM member_permissions WHERE organization_id=$1::uuid AND user_id=$2::uuid",
            [t.organizationId, targetUserId],
          )
        }

        await audit(client, t.organizationId, t.userId, "member.access_updated", targetUserId, {
          before: { role: current.role, status: current.status },
          after: { role: nextRole, status: nextStatus },
        })

        await client.query("COMMIT")
        res.json({
          user_id: targetUserId,
          role: nextRole,
          status: nextStatus,
          permissions: [...effectivePermissions(nextRole)].sort(),
        })
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {})
        throw error
      } finally {
        client.release()
      }
    }),
  )

  // PUT /api/v1/access/members/:userId/permissions/:permission — exception.
  r.put(
    "/access/members/:userId/permissions/:permission",
    requirePermission("user:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const targetUserId = parseId(req.params.userId)
      const permission = req.params.permission
      const input = body(
        z.object({ granted: z.boolean().nullable() }).strip(),
        req.body,
      )
      const pool = db()

      if (!isPermission(permission)) {
        throw new HttpError(400, "unknown_permission", "Permission inconnue.")
      }
      if (targetUserId === t.userId) {
        await audit(pool, t.organizationId, t.userId, "access.denied", targetUserId, {
          attempted: { permission, granted: input.granted },
          reason: "self_modification",
        })
        throw new HttpError(
          403,
          "self_modification_forbidden",
          "Vous ne pouvez pas modifier vos propres droits.",
        )
      }
      // Garde-fou structurel : certaines permissions ne se délèguent jamais,
      // même par le propriétaire. Sinon le système de rôles se contourne.
      if (input.granted === true && OWNER_ONLY_PERMISSIONS.includes(permission as Permission)) {
        await audit(pool, t.organizationId, t.userId, "access.denied", targetUserId, {
          attempted: { permission },
          reason: "owner_only_permission",
        })
        throw new HttpError(
          403,
          "permission_not_grantable",
          `La permission « ${PERMISSION_LABELS[permission as Permission]} » est réservée au propriétaire.`,
        )
      }

      const memberQ = await pool.query<{ role: string }>(
        "SELECT role FROM organization_members WHERE organization_id=$1::uuid AND user_id=$2::uuid",
        [t.organizationId, targetUserId],
      )
      if (!memberQ.rowCount) {
        throw new HttpError(404, "member_not_found", "Ce membre n’appartient pas à votre station.")
      }

      if (input.granted === null) {
        // Retour au comportement par défaut du rôle.
        await pool.query(
          "DELETE FROM member_permissions WHERE organization_id=$1::uuid AND user_id=$2::uuid AND permission=$3",
          [t.organizationId, targetUserId, permission],
        )
      } else {
        await pool.query(
          `INSERT INTO member_permissions(organization_id, user_id, permission, granted, granted_by)
           VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid)
           ON CONFLICT (organization_id, user_id, permission)
           DO UPDATE SET granted = EXCLUDED.granted, granted_by = EXCLUDED.granted_by, created_at = now()`,
          [t.organizationId, targetUserId, permission, input.granted, t.userId],
        )
      }

      await audit(
        pool,
        t.organizationId,
        t.userId,
        input.granted === null
          ? "member.permission_reset"
          : input.granted
            ? "member.permission_granted"
            : "member.permission_revoked",
        targetUserId,
        { permission },
      )

      const overridesQ = await pool.query<{ permission: string; granted: boolean }>(
        "SELECT permission, granted FROM member_permissions WHERE organization_id=$1::uuid AND user_id=$2::uuid",
        [t.organizationId, targetUserId],
      )
      res.json({
        user_id: targetUserId,
        overrides: overridesQ.rows,
        permissions: [...effectivePermissions(memberQ.rows[0].role, overridesQ.rows)].sort(),
      })
    }),
  )

  // POST /api/v1/access/members — créer le compte d'un collaborateur et le
  // rattacher à la station avec un rôle.
  //
  // Pourquoi pas un lien d'invitation cliquable : la station n'a pas
  // d'adresse e-mail fiable pour chaque collaborateur (beaucoup n'ont pas
  // d'adresse personnelle). Le propriétaire choisit le mot de passe initial,
  // le communique en personne, et le compte reste utilisable immédiatement.
  // Un flux par e-mail cliquable demanderait de repasser sur ce choix de
  // produit, pas d'ajouter un champ.
  r.post(
    "/access/members",
    // Deux niveaux d'autorisation, dans la route elle-même :
    //   • créer un agent de lavage exige `worker:create` (gérant inclus) ;
    //   • créer un gérant ou un caissier exige `user:manage`, permission
    //     réservée au propriétaire (OWNER_ONLY_PERMISSIONS) : c'est lui seul
    //     qui délègue l'accès aux encaissements et au contrôle des comptes.
    // La vérification fine est faite plus bas, une fois le corps lu.
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(
        z
          .object({
            email: z
              .string()
              .trim()
              .toLowerCase()
              .email("Adresse e-mail invalide.")
              .max(254),
            first_name: z.string().trim().min(1, "Le prénom est requis.").max(100),
            last_name: z.string().trim().min(1, "Le nom est requis.").max(100),
            phone: z.string().trim().max(30).optional().nullable(),
            role: z.enum(["manager", "cashier", "washer"]),
            // Mot de passe initial posé par le propriétaire. La longueur suit
            // la politique du produit (MIN_PASSWORD_LENGTH) : passer par la
            // constante éviterait que les deux règles divergent.
            password: z
              .string()
              .min(5, "Le mot de passe doit contenir au moins 5 caractères.")
              .max(200),
          })
          .strip(),
        req.body,
      )
      const pool = db()

      // Autorisation fine, dépendante du rôle demandé (voir le commentaire de
      // la route) : gérant/caissier réservés au propriétaire, agent de lavage
      // ouvert à tout détenteur de `worker:create`.
      if (input.role === "washer") {
        assertPermission(req, "worker:create")
      } else {
        assertPermission(req, "user:manage")
      }

      // Hiérarchie des rôles : un gérant ne crée que des agents de lavage.
      // Créer un caissier ou un autre gérant, c'est déléguer l'accès aux
      // encaissements ou au contrôle des comptes — la prérogative du
      // propriétaire. Le serveur fait autorité : l'interface adapte ses
      // options, mais une requête forgée est rejetée ici.
      const assignableRoles =
        t.role === "owner" ? (["manager", "cashier", "washer"] as const) : (["washer"] as const)
      if (!(assignableRoles as readonly string[]).includes(input.role)) {
        await audit(pool, t.organizationId, t.userId, "access.denied", input.email, {
          attempted: { role: input.role },
          reason: "role_not_assignable",
        })
        throw new HttpError(
          403,
          "role_not_assignable",
          "Seul le propriétaire peut créer un compte gérant ou caissier. Vous pouvez créer des comptes agent de lavage.",
        )
      }

      const client = await pool.connect()
      let userId: string
      try {
        await client.query("BEGIN")

        const existing = await client.query(
          "SELECT id FROM users WHERE lower(email) = $1 LIMIT 1",
          [input.email],
        )
        if (existing.rowCount) {
          await audit(client, t.organizationId, t.userId, "access.denied", input.email, {
            attempted: { role: input.role },
            reason: "email_exists",
          })
          throw new HttpError(
            409,
            "email_exists",
            "Un compte existe déjà avec cette adresse e-mail.",
          )
        }

        // Garde-fou forfait : le nombre d'utilisateurs actifs est plafonné.
        // Appelé avant l'insertion, il jette au-delà du quota.
        const passwordHash = await hashPassword(input.password)
        const userQ = await client.query(
          `INSERT INTO users (email, first_name, last_name, phone, password_hash, status, organization_id)
           VALUES ($1, $2, $3, $4, $5, 'active', $6) RETURNING id`,
          [input.email, input.first_name, input.last_name, input.phone ?? null, passwordHash, t.organizationId],
        )
        userId = userQ.rows[0].id as string

        await assertOrganizationUserCapacity(client, t.organizationId, userId)

        await client.query(
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, $3)",
          [t.organizationId, userId, input.role],
        )

        await audit(client, t.organizationId, t.userId, "member.created", userId, {
          email: input.email,
          role: input.role,
        })

        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {})
        throw error
      } finally {
        client.release()
      }

      // Mot de passe initial connu du propriétaire : le collaborateur peut
      // aussi en réclamer un nouveau via « mot de passe oublié » à tout
      // moment. On n'envoie donc pas d'e-mail automatique ici.
      res.status(201).json({ user_id: userId, role: input.role, email: input.email })
    }),
  )

  return r
}
