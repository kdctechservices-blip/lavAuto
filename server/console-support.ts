/**
 * L'assistance vue du côté de l'éditeur.
 *
 * Deux choses distinctes vivent ici :
 *
 *   1. **La file des demandes**, triée par échéance d'engagement. Elle répond
 *      à « qu'est-ce que je dois traiter maintenant ? », question à laquelle
 *      une boîte WhatsApp ne répond pas.
 *
 *   2. **Le diagnostic**, qui répond à « pourquoi ça ne marche pas chez lui ? »
 *      sans se connecter à sa place. L'usurpation d'identité reste refusée
 *      (BACK-OFFICE.md §3) : voir les données d'un client est une chose, agir
 *      en son nom une autre. Le diagnostic est la réponse à la question que
 *      l'usurpation prétendait résoudre.
 *
 * Le diagnostic ne montre **aucun montant**. Il explique des blocages, il
 * n'ouvre pas la comptabilité du client. Les compteurs qu'il affiche sont des
 * nombres d'objets, jamais des francs — c'est la limite posée, et elle est
 * tenue jusque dans la requête SQL.
 */

import type { Router } from "express"
import { z } from "zod"
import { asyncRoute, body, parseId } from "./http.ts"
import { HttpError } from "./auth.ts"
import { adminDb, auditPlatformAction } from "./platform-admin.ts"
import { logConsoleAction } from "./console-auth.ts"
import { isMailerConfigured, sendMail, supportReplyMessage } from "./mailer.ts"
import { env } from "./env.ts"
import {
  PERMISSION_LABELS,
  ROLE_LABELS,
  effectivePermissions,
  rolePermissions,
  type Permission,
} from "./permissions.ts"
import { computeSubscriptionState } from "./entitlements.ts"
import {
  SUPPORT_STATUSES,
  addMessage,
  getRequest,
  listQueue,
  threadMessages,
  withSla,
} from "./support-service.ts"

export function registerSupportRoutes(r: Router): void {
  // -------------------------------------------------------------------------
  // GET /api/v1/console/support — la file.
  //
  // Triée par échéance. C'est là que « assistance prioritaire » cesse d'être
  // un argument commercial pour devenir un ordre de traitement : un Business
  // passe devant un Starter arrivé plus tôt, sans règle de tri spéciale.
  // -------------------------------------------------------------------------
  r.get(
    "/support",
    asyncRoute(async (req, res) => {
      const status = typeof req.query.status === "string" ? req.query.status : null
      if (status && !SUPPORT_STATUSES.includes(status as (typeof SUPPORT_STATUSES)[number])) {
        throw new HttpError(400, "invalid_data", "Statut inconnu.")
      }
      const rows = await listQueue(adminDb(), {
        status,
        limit: Number(req.query.limit) || undefined,
      })
      const now = new Date()
      const requests = rows.map((row) => withSla(row, now))
      res.json({
        requests,
        // Compteurs d'en-tête : ce que l'opérateur doit voir avant de lire la
        // liste. « En retard » est le seul chiffre qui engage l'éditeur.
        totals: {
          open: requests.filter((q) => q.status === "open").length,
          answered: requests.filter((q) => q.status === "answered").length,
          breached: requests.filter((q) => q.sla.breached && !q.sla.responded).length,
        },
        server_time: now.toISOString(),
      })
    }),
  )

  // -------------------------------------------------------------------------
  // GET /api/v1/console/support/:id — le fil complet, notes internes incluses.
  // -------------------------------------------------------------------------
  r.get(
    "/support/:id",
    asyncRoute(async (req, res) => {
      const id = parseId(req.params.id)
      const pool = adminDb()
      const request = await getRequest(pool, id)
      if (!request) throw new HttpError(404, "not_found", "Cette demande est introuvable.")
      res.json({
        request: withSla(request),
        // `true` : seul endroit du produit où les notes internes sortent.
        messages: await threadMessages(pool, id, true),
      })
    }),
  )

  // -------------------------------------------------------------------------
  // POST /api/v1/console/support/:id/messages — répondre, ou noter.
  //
  // Une note interne ne déclenche pas le compteur de première réponse : elle
  // ne répond à personne. Sans cette distinction, l'éditeur pourrait tenir son
  // engagement en se parlant à lui-même.
  // -------------------------------------------------------------------------
  r.post(
    "/support/:id/messages",
    asyncRoute(async (req, res) => {
      const id = parseId(req.params.id)
      const operator = req.operator!
      const input = body(
        z
          .object({
            body: z.string().trim().min(2, "Le message est vide.").max(4000),
            internal: z.boolean().default(false),
          })
          .strip(),
        req.body,
      )
      const pool = adminDb()
      const request = await getRequest(pool, id)
      if (!request) throw new HttpError(404, "not_found", "Cette demande est introuvable.")

      const client = await pool.connect()
      let message: Awaited<ReturnType<typeof addMessage>>
      let notificationId: string | null = null
      try {
        await client.query("BEGIN")
        message = await addMessage(client, {
          requestId: id,
          body: input.body,
          authorOperatorEmail: operator.email,
          internal: input.internal,
        })

        // Une note interne ne laisse pas de trace chez le client et ne
        // déclenche surtout aucune notification. Une réponse publique crée en
        // revanche une alerte nominative et persistante dans sa cloche.
        if (!input.internal) {
          if (request.created_by) {
            const notification = await client.query<{ id: string }>(
              `INSERT INTO notifications
                 (organization_id, user_id, type, title, message, entity_type, entity_id)
               VALUES($1::uuid,$2::uuid,'SUPPORT_REPLY','Réponse à votre demande d’assistance',$3,'support_request',$4::uuid)
               RETURNING id`,
              [
                request.organization_id,
                request.created_by,
                `${operator.fullName} a répondu à votre demande « ${request.subject} ».`,
                id,
              ],
            )
            notificationId = notification.rows[0].id
          }
          await auditPlatformAction(
            client,
            request.organization_id,
            operator.email,
            "support.replied",
            id,
            { subject: request.subject },
          )
        }
        await logConsoleAction(
          client,
          operator,
          input.internal ? "support.note_added" : "support.replied",
          request.organization_id,
          request.organization_name,
          { subject: request.subject },
        )
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {})
        throw error
      } finally {
        client.release()
      }

      // Le fournisseur e-mail ne doit jamais décider si la réponse peut être
      // publiée : elle est déjà enregistrée. Le résultat de remise est simplement
      // renvoyé à l'opérateur pour qu'il sache s'il doit prévenir autrement.
      let emailDelivered = false
      if (!input.internal && request.requester_email) {
        const base = env.APP_URL.replace(/\/+$/, "")
        emailDelivered = await sendMail(supportReplyMessage({
          to: request.requester_email,
          firstName: request.requester_name,
          organizationName: request.organization_name,
          requestSubject: request.subject,
          supportUrl: `${base ? `${base}/support` : "/support"}?request=${encodeURIComponent(id)}`,
        }))
      }

      res.status(201).json({
        message: message!,
        request: withSla((await getRequest(pool, id))!),
        notification: {
          in_app: notificationId !== null,
          notification_id: notificationId,
          email_configured: isMailerConfigured(),
          email_delivered: emailDelivered,
        },
      })
    }),
  )

  // -------------------------------------------------------------------------
  // POST /api/v1/console/support/:id/status — clore ou rouvrir.
  // -------------------------------------------------------------------------
  r.post(
    "/support/:id/status",
    asyncRoute(async (req, res) => {
      const id = parseId(req.params.id)
      const operator = req.operator!
      const input = body(
        z.object({ status: z.enum(["open", "resolved"]) }).strip(),
        req.body,
      )
      const pool = adminDb()
      const request = await getRequest(pool, id)
      if (!request) throw new HttpError(404, "not_found", "Cette demande est introuvable.")

      await pool.query(
        `UPDATE support_requests
            SET status = $2,
                resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END,
                updated_at = now()
          WHERE id = $1::uuid`,
        [id, input.status],
      )
      await logConsoleAction(
        pool,
        operator,
        input.status === "resolved" ? "support.resolved" : "support.reopened",
        request.organization_id,
        request.organization_name,
        { subject: request.subject },
      )
      res.json({ request: withSla((await getRequest(pool, id))!) })
    }),
  )

  // -------------------------------------------------------------------------
  // GET /api/v1/console/organizations/:id/members/:userId/diagnostic
  //
  // « Pourquoi je ne peux pas enregistrer un lavage ? » — la question la plus
  // fréquente au téléphone, et la plus pénible à élucider à l'aveugle. Quatre
  // causes possibles, dans cet ordre : le compte est bloqué, l'appartenance a
  // été retirée, l'abonnement est en lecture seule, le rôle n'a pas le droit.
  // La route les évalue toutes et nomme celle qui mord.
  //
  // Aucun montant n'est renvoyé. Les compteurs sont des nombres d'objets, et
  // le journal d'activité est réduit aux noms d'actions : `metadata` contient
  // des sommes, il n'est jamais transmis.
  // -------------------------------------------------------------------------
  r.get(
    "/organizations/:id/members/:userId/diagnostic",
    asyncRoute(async (req, res) => {
      const organizationId = parseId(req.params.id)
      const userId = parseId(req.params.userId)
      const pool = adminDb()

      const memberQ = await pool.query(
        `SELECT m.role, m.status AS membership_status, m.disabled_at,
                u.email, u.status AS account_status, u.first_name, u.last_name,
                o.name AS organization_name, o.deletion_requested_at,
                (SELECT count(*)::int FROM auth_sessions s
                  WHERE s.user_id = u.id AND s.expires_at > now()) AS active_sessions,
                (SELECT max(s.last_used_at) FROM auth_sessions s WHERE s.user_id = u.id) AS last_seen_at
           FROM organization_members m
           JOIN users u ON u.id = m.user_id
           JOIN organizations o ON o.id = m.organization_id
          WHERE m.organization_id = $1::uuid AND m.user_id = $2::uuid`,
        [organizationId, userId],
      )
      if (!memberQ.rowCount) {
        throw new HttpError(404, "member_not_found", "Ce compte n'appartient pas à cette station.")
      }
      const member = memberQ.rows[0]

      const overridesQ = await pool.query(
        "SELECT permission, granted FROM member_permissions WHERE organization_id = $1::uuid AND user_id = $2::uuid",
        [organizationId, userId],
      )
      const overrides = overridesQ.rows as Array<{ permission: string; granted: boolean }>
      const effective = effectivePermissions(member.role, overrides)
      const fromRole = new Set(rolePermissions(member.role))

      const subQ = await pool.query(
        `SELECT s.status, s.current_period_end, p.code AS plan_code, p.name AS plan_name,
                p.price_cents, p.features, p.max_users, p.max_workers, p.max_sites
           FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
          WHERE s.organization_id = $1::uuid`,
        [organizationId],
      )
      const sub = subQ.rows[0]
      const subscription = computeSubscriptionState({
        status: sub?.status ?? null,
        current_period_end: sub?.current_period_end ?? null,
        plan_code: sub?.plan_code ?? null,
        plan_name: sub?.plan_name ?? null,
        plan_price_cents: sub?.price_cents ?? null,
        plan_features: sub?.features ?? null,
      })

      // Compteurs d'usage contre plafonds du forfait : « je ne peux pas
      // ajouter un laveur » vient presque toujours d'ici. Ce sont des
      // nombres d'objets, pas des sommes.
      const usageQ = await pool.query(
        `SELECT
           (SELECT count(*)::int FROM organization_members WHERE organization_id = $1::uuid AND status = 'active') AS users,
           (SELECT count(*)::int FROM workers WHERE organization_id = $1::uuid AND status = 'active') AS workers,
           (SELECT count(*)::int FROM sites WHERE organization_id = $1::uuid) AS sites`,
        [organizationId],
      )
      const usage = usageQ.rows[0]
      const limits = [
        { key: "users", label: "Comptes utilisateurs", used: usage.users, max: sub?.max_users ?? null },
        { key: "workers", label: "Laveurs", used: usage.workers, max: sub?.max_workers ?? null },
        { key: "sites", label: "Sites", used: usage.sites, max: sub?.max_sites ?? null },
      ].map((l) => ({ ...l, reached: l.max !== null && l.used >= l.max }))

      // Journal réduit aux noms d'actions : `metadata` porte des montants.
      const activityQ = await pool.query(
        `SELECT action, entity_type, created_at FROM audit_logs
          WHERE organization_id = $1::uuid AND actor_user_id = $2::uuid
          ORDER BY created_at DESC LIMIT 15`,
        [organizationId, userId],
      )

      // Les causes de blocage, dans l'ordre où elles mordent. La première
      // suffit à expliquer le symptôme ; les suivantes sont du bruit tant
      // qu'elle n'est pas levée.
      const blockers: Array<{ cause: string; explanation: string }> = []
      if (member.account_status !== "active") {
        blockers.push({
          cause: "compte_bloque",
          explanation:
            "Le compte est bloqué au niveau de la plateforme : cette personne ne peut se connecter nulle part.",
        })
      }
      if (member.membership_status !== "active") {
        blockers.push({
          cause: "retire_de_la_station",
          explanation:
            "Cette personne a été retirée de la station. Elle se connecte, mais reçoit une erreur dès qu'elle ouvre cette station.",
        })
      }
      if (member.deletion_requested_at) {
        blockers.push({
          cause: "station_en_suppression",
          explanation: "La station est programmée pour suppression : tous les accès sont coupés.",
        })
      }
      if (subscription.read_only) {
        blockers.push({
          cause: "abonnement_en_lecture_seule",
          explanation:
            "L'essai est terminé ou l'abonnement est échu : la station est en lecture seule, aucune écriture n'est acceptée.",
        })
      }
      for (const limit of limits) {
        if (limit.reached) {
          blockers.push({
            cause: `plafond_${limit.key}`,
            explanation: `Le plafond du forfait est atteint (${limit.label} : ${limit.used}/${limit.max}). Toute création supplémentaire est refusée.`,
          })
        }
      }

      res.json({
        member: {
          user_id: userId,
          email: member.email,
          name: [member.first_name, member.last_name].filter(Boolean).join(" ") || null,
          organization_id: organizationId,
          organization_name: member.organization_name,
          role: member.role,
          role_label: ROLE_LABELS[member.role as keyof typeof ROLE_LABELS] ?? member.role,
          account_status: member.account_status,
          membership_status: member.membership_status,
          disabled_at: member.disabled_at,
          active_sessions: member.active_sessions,
          last_seen_at: member.last_seen_at,
        },
        subscription: {
          status: subscription.status,
          plan_code: subscription.plan_code,
          plan_name: subscription.plan_name,
          read_only: subscription.read_only,
          days_remaining: subscription.days_remaining,
          restricted: subscription.restricted,
        },
        limits,
        permissions: {
          // Chaque permission avec son origine : le rôle, ou une exception
          // posée par le propriétaire. C'est la distinction qui explique
          // pourquoi deux caissiers de la même station n'ont pas les mêmes
          // droits.
          granted: [...effective].sort().map((p) => ({
            permission: p,
            label: PERMISSION_LABELS[p as Permission] ?? p,
            source: fromRole.has(p as Permission) ? "role" : "exception",
          })),
          overrides: overrides.map((o) => ({
            permission: o.permission,
            label: PERMISSION_LABELS[o.permission as Permission] ?? o.permission,
            granted: o.granted,
          })),
        },
        blockers,
        recent_activity: activityQ.rows,
        server_time: new Date().toISOString(),
      })
    }),
  )
}
