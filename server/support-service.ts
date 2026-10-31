/**
 * Le registre des demandes d'assistance.
 *
 * Partagé entre les routes du client (`support.ts`) et celles de l'éditeur
 * (`console-support.ts`). Ce qui est commun aux deux vit ici — en particulier
 * **la règle de visibilité des messages**, qui n'a qu'une seule implémentation.
 *
 * ## Pourquoi une table plutôt que WhatsApp seul
 *
 * WhatsApp reste le canal de discussion : c'est celui que les gérants
 * utilisent réellement à Abidjan, et lutter contre serait perdre. Mais une
 * conversation WhatsApp ne laisse aucune trace exploitable : impossible de
 * savoir combien de demandes sont ouvertes, depuis quand, et si le délai promis
 * a été tenu. Le registre donne une mémoire au canal, il ne le remplace pas.
 *
 * ## Les notes internes
 *
 * L'opérateur peut écrire des notes que le client ne verra jamais. C'est utile
 * et c'est risqué : une fuite serait un désastre de confiance. La protection
 * n'est donc pas une discipline mais une **structure** — un seul chemin de
 * lecture, `threadMessages()`, qui exige qu'on lui dise explicitement si les
 * notes internes sont permises. Les routes client passent `false` et un test
 * le prouve.
 */

import type { Pool, PoolClient } from "pg"
import { commitmentFor, responseDueAt, slaState } from "./support-sla.ts"

type Queryable = Pick<Pool | PoolClient, "query">

/** Catégories proposées. Volontairement courtes : une liste longue n'est pas lue. */
export const SUPPORT_CATEGORIES = ["technique", "facturation", "formation", "autre"] as const
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number]

export const SUPPORT_CATEGORY_LABELS: Record<string, string> = {
  technique: "Problème technique",
  facturation: "Abonnement et facturation",
  formation: "Prise en main",
  autre: "Autre",
}

/**
 * Trois états, pas davantage.
 *
 * `answered` existe pour distinguer « personne n'a encore répondu » de « on a
 * répondu, on attend le client ». Sans lui, la file de la console mélangerait
 * les demandes où l'éditeur est en retard et celles où la balle est dans le
 * camp du client — et le compteur d'engagement ne voudrait plus rien dire.
 */
export const SUPPORT_STATUSES = ["open", "answered", "resolved"] as const

export const SUPPORT_STATUS_LABELS: Record<string, string> = {
  open: "En attente de réponse",
  answered: "Répondu",
  resolved: "Résolu",
}

export interface SupportMessage {
  id: string
  author_user_id: string | null
  author_operator_email: string | null
  author_name: string | null
  internal: boolean
  body: string
  created_at: string
}

/**
 * Les messages d'un fil.
 *
 * `includeInternal` n'a pas de valeur par défaut : l'appelant doit trancher à
 * chaque fois. Un défaut à `false` serait plus commode, mais une route qui
 * oublie l'argument passerait silencieusement — ici elle ne compile pas.
 */
export async function threadMessages(
  pool: Queryable,
  requestId: string,
  includeInternal: boolean,
): Promise<SupportMessage[]> {
  const q = await pool.query(
    `SELECT m.id, m.author_user_id, m.author_operator_email, m.internal, m.body, m.created_at,
            nullif(trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')), '') AS author_name
       FROM support_messages m
       LEFT JOIN users u ON u.id = m.author_user_id
      WHERE m.request_id = $1::uuid
        AND ($2::boolean OR m.internal = false)
      ORDER BY m.created_at ASC`,
    [requestId, includeInternal],
  )
  return q.rows as SupportMessage[]
}

/** Colonnes d'une demande, enrichies du contexte dont la console a besoin. */
const REQUEST_SELECT = `r.id, r.organization_id, r.created_by, r.subject, r.category, r.status,
  r.plan_code, r.commitment_hours, r.response_due_at, r.first_responded_at, r.resolved_at,
  r.created_at, r.updated_at,
  o.name AS organization_name,
  nullif(trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')), '') AS requester_name,
  u.email AS requester_email,
  u.phone AS requester_phone,
  (SELECT count(*)::int FROM support_messages m
    WHERE m.request_id = r.id AND m.internal = false) AS message_count`

export interface SupportRequestRow {
  id: string
  organization_id: string
  organization_name: string
  created_by: string | null
  subject: string
  category: string
  status: string
  plan_code: string | null
  commitment_hours: number
  response_due_at: string
  first_responded_at: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
  requester_name: string | null
  requester_email: string | null
  requester_phone: string | null
  message_count: number
}

/** Ajoute l'état de l'engagement à une demande. */
export function withSla(row: SupportRequestRow, now: Date = new Date()) {
  return {
    ...row,
    sla: slaState(
      new Date(row.response_due_at),
      row.first_responded_at ? new Date(row.first_responded_at) : null,
      now,
    ),
  }
}

/**
 * Ouvre une demande.
 *
 * Le forfait en vigueur est **figé** dans la ligne : l'engagement a été pris
 * sous ce forfait, et il tient même si le client rétrograde ensuite.
 */
export async function createSupportRequest(
  pool: Queryable,
  input: {
    organizationId: string
    userId: string
    subject: string
    category: string
    body: string
  },
): Promise<SupportRequestRow> {
  const planQ = await pool.query(
    `SELECT p.code FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.organization_id = $1::uuid AND s.status = 'active'`,
    [input.organizationId],
  )
  // Un essai ou un abonnement échu n'a pas acheté d'engagement : il reçoit le
  // maximum indicatif, pas une promesse.
  const planCode = (planQ.rows[0]?.code as string | undefined) ?? null
  const hours = commitmentFor(planCode)
  const now = new Date()

  const inserted = await pool.query(
    `INSERT INTO support_requests
       (organization_id, created_by, subject, category, plan_code, commitment_hours, response_due_at)
     VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7) RETURNING id`,
    [
      input.organizationId,
      input.userId,
      input.subject,
      input.category,
      planCode,
      hours,
      responseDueAt(now, planCode),
    ],
  )
  const requestId = inserted.rows[0].id as string

  await pool.query(
    "INSERT INTO support_messages(request_id, author_user_id, body) VALUES($1::uuid,$2::uuid,$3)",
    [requestId, input.userId, input.body],
  )

  return (await getRequest(pool, requestId))!
}

/** Une demande par son identifiant, sans contrôle d'accès. */
export async function getRequest(
  pool: Queryable,
  requestId: string,
): Promise<SupportRequestRow | null> {
  const q = await pool.query(
    `SELECT ${REQUEST_SELECT} FROM support_requests r
       JOIN organizations o ON o.id = r.organization_id
       LEFT JOIN users u ON u.id = r.created_by
      WHERE r.id = $1::uuid`,
    [requestId],
  )
  return (q.rows[0] as SupportRequestRow) ?? null
}

/**
 * Ajoute un message et met à jour l'état de la demande.
 *
 * `first_responded_at` n'est posé que par une réponse **publique de
 * l'éditeur** : une note interne ne répond à personne, et un message du client
 * ne répond pas à lui-même. C'est ce qui rend la mesure du délai honnête.
 */
export async function addMessage(
  pool: Queryable,
  input: {
    requestId: string
    body: string
    authorUserId?: string | null
    authorOperatorEmail?: string | null
    internal?: boolean
  },
): Promise<SupportMessage> {
  const internal = input.internal ?? false
  const inserted = await pool.query(
    `INSERT INTO support_messages(request_id, author_user_id, author_operator_email, internal, body)
     VALUES($1::uuid,$2::uuid,$3,$4,$5)
     RETURNING id, author_user_id, author_operator_email, internal, body, created_at`,
    [
      input.requestId,
      input.authorUserId ?? null,
      input.authorOperatorEmail ?? null,
      internal,
      input.body,
    ],
  )

  const fromOperator = Boolean(input.authorOperatorEmail)
  if (fromOperator && !internal) {
    await pool.query(
      `UPDATE support_requests
          SET first_responded_at = coalesce(first_responded_at, now()),
              status = CASE WHEN status = 'resolved' THEN status ELSE 'answered' END,
              updated_at = now()
        WHERE id = $1::uuid`,
      [input.requestId],
    )
  } else if (!fromOperator) {
    // Le client relance : la demande redevient en attente de notre réponse,
    // même si elle avait été marquee resolue un peu vite.
    await pool.query(
      `UPDATE support_requests SET status = 'open', resolved_at = NULL, updated_at = now()
        WHERE id = $1::uuid`,
      [input.requestId],
    )
  } else {
    await pool.query("UPDATE support_requests SET updated_at = now() WHERE id = $1::uuid", [
      input.requestId,
    ])
  }

  return inserted.rows[0] as SupportMessage
}

/** Les demandes d'une station, la plus récente d'abord. */
export async function listForOrganization(
  pool: Queryable,
  organizationId: string,
  options: { createdBy?: string | null; limit?: number } = {},
): Promise<SupportRequestRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const values: unknown[] = [organizationId]
  let filter = ""
  if (options.createdBy) {
    values.push(options.createdBy)
    filter = " AND r.created_by = $2::uuid"
  }
  const q = await pool.query(
    `SELECT ${REQUEST_SELECT} FROM support_requests r
       JOIN organizations o ON o.id = r.organization_id
       LEFT JOIN users u ON u.id = r.created_by
      WHERE r.organization_id = $1::uuid${filter}
      ORDER BY r.created_at DESC LIMIT ${limit}`,
    values,
  )
  return q.rows as SupportRequestRow[]
}

/**
 * La file de l'éditeur.
 *
 * Triée par échéance, pas par date d'arrivée : c'est là que la « priorité »
 * du forfait se matérialise. Un Business arrivé à midi passe devant un Starter
 * arrivé le matin, parce que son échéance tombe plus tôt. Aucun tri spécial à
 * écrire — l'engagement ordonne la file à lui seul.
 */
export async function listQueue(
  pool: Queryable,
  options: { status?: string | null; limit?: number } = {},
): Promise<SupportRequestRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 300)
  const values: unknown[] = []
  let filter: string
  if (options.status) {
    values.push(options.status)
    filter = " WHERE r.status = $1"
  } else {
    // Vue par defaut : ce qu'il reste a traiter. Une demande resolue
    // n'encombre pas la file, elle reste accessible par le filtre.
    filter = " WHERE r.status <> 'resolved'"
  }
  const q = await pool.query(
    `SELECT ${REQUEST_SELECT} FROM support_requests r
       JOIN organizations o ON o.id = r.organization_id
       LEFT JOIN users u ON u.id = r.created_by
       ${filter}
      ORDER BY r.response_due_at ASC LIMIT ${limit}`,
    values,
  )
  return q.rows as SupportRequestRow[]
}
