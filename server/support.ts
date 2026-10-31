import { Router } from "express"
import { z } from "zod"
import type { Pool } from "pg"
import { getPool } from "./db.ts"
import { asyncRoute, body, tenant, requirePermission, HttpError } from "./http.ts"
import { env } from "./env.ts"
import { sendMail, upgradeRequestMessage } from "./mailer.ts"
import { invalidateSubscriptionCache } from "./entitlements.ts"
import { parseId } from "./http.ts"
import { commitmentFor, commitmentLabel } from "./support-sla.ts"
import {
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_LABELS,
  addMessage,
  createSupportRequest,
  getRequest,
  listForOrganization,
  threadMessages,
  withSla,
} from "./support-service.ts"

// ---------------------------------------------------------------------------
// Assistance
//
// L'assistance passe par WhatsApp : c'est le canal réellement utilisé par les
// gérants de station en Côte d'Ivoire. Le numéro est configuré par
// l'exploitant (SUPPORT_WHATSAPP) ; l'API expose la configuration pour que
// l'interface construise un lien wa.me pré-rempli.
// ---------------------------------------------------------------------------

/** Numéro au format wa.me : chiffres uniquement, sans espace ni « + ». */
export function normalizeWhatsAppNumber(raw: string): string {
  return raw.replace(/[^0-9]/g, "")
}

/** Affichage lisible d'un numéro ivoirien (+225 XX XX XX XX XX). */
export function formatWhatsAppNumber(raw: string): string {
  const digits = normalizeWhatsAppNumber(raw)
  if (!digits) return ""
  if (digits.startsWith("225") && digits.length === 13) {
    const local = digits.slice(3)
    return `+225 ${local.replace(/(\d{2})(?=\d)/g, "$1 ").trim()}`
  }
  return `+${digits}`
}

/** Lien WhatsApp pré-rempli. */
export function buildWhatsAppUrl(number: string, message: string): string {
  const digits = normalizeWhatsAppNumber(number)
  if (!digits) return ""
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
}

/** Numéro de démonstration utilisé hors production quand rien n'est configuré. */
const DEMO_WHATSAPP = "+225 07 00 00 00 00"

export interface SupportConfig {
  whatsapp_number: string
  whatsapp_display: string
  email: string
  /** Vrai quand le numéro affiché est celui de démonstration. */
  is_placeholder: boolean
}

export function resolveSupportConfig(): SupportConfig {
  const configured = env.SUPPORT_WHATSAPP.trim()
  const isPlaceholder = !configured && env.NODE_ENV !== "production"
  const number = configured || (isPlaceholder ? DEMO_WHATSAPP : "")
  return {
    whatsapp_number: normalizeWhatsAppNumber(number),
    whatsapp_display: formatWhatsAppNumber(number),
    email: env.SUPPORT_EMAIL,
    is_placeholder: isPlaceholder,
  }
}

function db(): Pool {
  const pool = getPool()
  if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
  return pool
}

export function createSupportRouter() {
  const r = Router()

  // GET /api/v1/support/config — canal d'assistance + contexte de la station.
  r.get(
    "/support/config",
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const q = await db().query(
        `SELECT o.name AS organization_name, u.first_name, u.last_name, u.email, u.phone,
                p.name AS plan_name, s.status AS subscription_status
         FROM organizations o
         JOIN users u ON u.id = $2::uuid
         LEFT JOIN subscriptions s ON s.organization_id = o.id
         LEFT JOIN plans p ON p.id = s.plan_id
         WHERE o.id = $1::uuid`,
        [t.organizationId, t.userId],
      )
      const row = q.rows[0] ?? {}
      // L'engagement de delai est annonce au client : c'est ce qui donne un
      // sens verifiable a la mention « assistance prioritaire » du forfait Pro.
      const planQ = await db().query(
        `SELECT p.code FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.organization_id = $1::uuid AND s.status = 'active'`,
        [t.organizationId],
      )
      const activePlan = (planQ.rows[0]?.code as string | undefined) ?? null
      const hours = commitmentFor(activePlan)
      res.json({
        ...resolveSupportConfig(),
        commitment: {
          hours,
          label: commitmentLabel(hours),
          plan_code: activePlan,
          // Faux pour un essai ou un abonnement echu : rien n'a ete achete,
          // donc rien n'est promis. Le delai affiche reste indicatif.
          guaranteed: activePlan !== null,
          business_hours: "du lundi au vendredi, 8 h - 18 h (heure d'Abidjan)",
        },
        categories: SUPPORT_CATEGORIES.map((code) => ({
          code,
          label: SUPPORT_CATEGORY_LABELS[code],
        })),
        context: {
          organization_name: row.organization_name ?? null,
          contact_name: [row.first_name, row.last_name].filter(Boolean).join(" ") || null,
          contact_email: row.email ?? null,
          contact_phone: row.phone ?? null,
          plan_name: row.plan_name ?? null,
          subscription_status: row.subscription_status ?? null,
        },
      })
    }),
  )

  // POST /api/v1/support/upgrade-request — demande d'activation d'un forfait.
  // Le paiement est traité hors ligne : on trace la demande, on prévient
  // l'assistance et on renvoie le lien WhatsApp pour finaliser en direct.
  r.post(
    "/support/upgrade-request",
    requirePermission("subscription:manage"),
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(
        z
          .object({
            plan_code: z.string().trim().min(1).max(40),
            note: z.string().trim().max(500).optional(),
          })
          .strip(),
        req.body,
      )
      const pool = db()

      const planQ = await pool.query("SELECT id, code, name, price_cents FROM plans WHERE code=$1", [
        input.plan_code,
      ])
      if (!planQ.rowCount) throw new HttpError(404, "plan_not_found", "Forfait introuvable.")
      const plan = planQ.rows[0]

      const contextQ = await pool.query(
        `SELECT o.name AS organization_name, u.first_name, u.last_name, u.email, u.phone
         FROM organizations o JOIN users u ON u.id = $2::uuid WHERE o.id = $1::uuid`,
        [t.organizationId, t.userId],
      )
      const context = contextQ.rows[0] ?? {}
      const requesterName = [context.first_name, context.last_name].filter(Boolean).join(" ") || "Un utilisateur"

      await pool.query(
        `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
         VALUES($1::uuid,$2::uuid,'subscription.upgrade_requested','plan',$3::text,$4::jsonb)`,
        [
          t.organizationId,
          t.userId,
          plan.id,
          JSON.stringify({ plan_code: plan.code, note: input.note ?? null }),
        ],
      )
      invalidateSubscriptionCache(t.organizationId)

      const delivered = await sendMail(
        upgradeRequestMessage({
          to: env.SUPPORT_EMAIL,
          organizationName: context.organization_name ?? "Station",
          planName: plan.name,
          requesterEmail: context.email ?? "",
          requesterName,
          phone: context.phone,
          note: input.note ?? null,
        }),
      )

      const support = resolveSupportConfig()
      const message = `Bonjour WashPilot CI, je suis ${requesterName} de la station ${
        context.organization_name ?? ""
      }. Je souhaite activer le forfait ${plan.name}.`

      res.status(201).json({
        recorded: true,
        notified: delivered,
        plan: { code: plan.code, name: plan.name, price_cents: plan.price_cents },
        whatsapp_url: buildWhatsAppUrl(support.whatsapp_number, message),
        support_email: support.email,
      })
    }),
  )

  // -------------------------------------------------------------------------
  // Le registre des demandes
  //
  // Qui voit quoi : l'auteur voit ses propres demandes ; propriétaires et
  // gérants voient toutes celles de la station. Un caissier ne lit donc pas la
  // demande d'un collègue — une demande peut parler d'un écart de caisse, et
  // la mettre sous les yeux de tout le monde serait indélicat.
  //
  // Aucune permission nouvelle n'est introduite : ouvrir une demande est à la
  // portée de n'importe quel membre, parce que la personne qui rencontre le
  // problème est celle qui sait le décrire.
  // -------------------------------------------------------------------------

  /** Vrai si ce rôle voit toutes les demandes de la station. */
  function seesEverything(role: string): boolean {
    return role === "owner" || role === "manager"
  }

  // POST /api/v1/support/requests — ouvrir une demande.
  r.post(
    "/support/requests",
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const input = body(
        z
          .object({
            subject: z.string().trim().min(5, "Résumez votre demande en quelques mots.").max(140),
            category: z.enum(SUPPORT_CATEGORIES).default("autre"),
            body: z
              .string()
              .trim()
              .min(15, "Décrivez le problème : ce que vous faisiez, ce qui s'est passé.")
              .max(4000),
          })
          .strip(),
        req.body,
      )

      const request = await createSupportRequest(db(), {
        organizationId: t.organizationId,
        userId: t.userId,
        subject: input.subject,
        category: input.category,
        body: input.body,
      })

      const support = resolveSupportConfig()
      const message = `Bonjour WashPilot CI, j'ai ouvert la demande « ${input.subject} » dans l'application.`
      res.status(201).json({
        request: withSla(request),
        // Le lien WhatsApp reste proposé : la trace est dans l'application,
        // la discussion se fait où le client a l'habitude de la faire.
        whatsapp_url: buildWhatsAppUrl(support.whatsapp_number, message),
      })
    }),
  )

  // GET /api/v1/support/requests — mes demandes, ou toutes selon le rôle.
  r.get(
    "/support/requests",
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const rows = await listForOrganization(db(), t.organizationId, {
        createdBy: seesEverything(t.role) ? null : t.userId,
      })
      res.json({ requests: rows.map((row) => withSla(row)), scope: seesEverything(t.role) ? "station" : "mine" })
    }),
  )

  // GET /api/v1/support/requests/:id — le fil, sans les notes internes.
  r.get(
    "/support/requests/:id",
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const pool = db()
      const request = await getRequest(pool, id)
      // Une demande d'une autre station est introuvable, pas interdite : la
      // distinction renseignerait sur son existence.
      if (!request || request.organization_id !== t.organizationId) {
        throw new HttpError(404, "not_found", "Cette demande est introuvable.")
      }
      if (!seesEverything(t.role) && request.created_by !== t.userId) {
        throw new HttpError(404, "not_found", "Cette demande est introuvable.")
      }
      res.json({
        request: withSla(request),
        // `false` : jamais les notes internes de l'éditeur.
        messages: await threadMessages(pool, id, false),
      })
    }),
  )

  // POST /api/v1/support/requests/:id/messages — répondre ou relancer.
  r.post(
    "/support/requests/:id/messages",
    asyncRoute(async (req, res) => {
      const t = tenant(req)
      const id = parseId(req.params.id)
      const input = body(
        z.object({ body: z.string().trim().min(2, "Le message est vide.").max(4000) }).strip(),
        req.body,
      )
      const pool = db()
      const request = await getRequest(pool, id)
      if (!request || request.organization_id !== t.organizationId) {
        throw new HttpError(404, "not_found", "Cette demande est introuvable.")
      }
      if (!seesEverything(t.role) && request.created_by !== t.userId) {
        throw new HttpError(404, "not_found", "Cette demande est introuvable.")
      }
      const message = await addMessage(pool, {
        requestId: id,
        body: input.body,
        authorUserId: t.userId,
      })
      res.status(201).json({ message, request: withSla((await getRequest(pool, id))!) })
    }),
  )

  return r
}
