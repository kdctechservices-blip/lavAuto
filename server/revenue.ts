/**
 * Revenus de l'éditeur : lecture du registre, étalement, exports.
 *
 * Ce module ne décide de rien et n'écrit rien. Il lit
 * `subscription_payments` — alimenté par le seul `activateSubscription()` —
 * et en tire trois lectures différentes du même argent :
 *
 *   1. **l'encaissement** : ce qui est arrivé sur le compte, le mois où il
 *      est arrivé. C'est la trésorerie, celle qui paie les factures ;
 *   2. **le revenu reconnu** : le même argent étalé sur la période qu'il
 *      couvre. C'est la croissance réelle ;
 *   3. **le journal comptable** : les mêmes lignes en écritures SYSCOHADA.
 *
 * Confondre (1) et (2) est l'erreur classique d'un abonnement vendu
 * d'avance : un client qui règle douze mois fait un mois spectaculaire suivi
 * de onze mois morts, et on en conclut que l'activité s'effondre.
 */

import type { Pool, PoolClient } from "pg"

type Queryable = Pick<Pool | PoolClient, "query">

// ---------------------------------------------------------------------------
// Canaux d'encaissement
// ---------------------------------------------------------------------------

/**
 * Repris à l'identique des canaux du produit (`server/payments.ts`), plus le
 * virement : un abonnement se règle souvent par banque, là où un lavage se
 * règle en espèces ou par mobile money.
 */
export const REVENUE_CHANNELS = [
  "cash",
  "bank_transfer",
  "orange_money",
  "mtn_momo",
  "moov_money",
  "wave",
  "other",
] as const

export type RevenueChannel = (typeof REVENUE_CHANNELS)[number]

export const REVENUE_CHANNEL_LABELS: Record<RevenueChannel, string> = {
  cash: "Espèces",
  bank_transfer: "Virement bancaire",
  orange_money: "Orange Money",
  mtn_momo: "MTN MoMo",
  moov_money: "Moov Money",
  wave: "Wave",
  other: "Autre",
}

// ---------------------------------------------------------------------------
// Plan comptable SYSCOHADA révisé (AUDCIF 2017)
// ---------------------------------------------------------------------------

/**
 * Comptes utilisés par l'export en écritures. Regroupés ici, et nulle part
 * ailleurs, pour qu'un cabinet qui tient un plan différent n'ait qu'un seul
 * endroit à corriger.
 *
 * Le choix du compte de trésorerie suit le canal, et ce détail compte : le
 * SYSCOHADA révisé a créé la classe 55, « Instruments de monnaie
 * électronique », précisément pour que le mobile money cesse d'être rangé en
 * caisse ou en banque par approximation. Un encaissement Wave n'est ni de
 * l'espèce dans le tiroir, ni de l'argent en banque — c'est un troisième
 * emplacement, avec ses frais et son délai de reversement. Tout mettre en
 * 571 rendrait le rapprochement impossible.
 */
export const SYSCOHADA_ACCOUNTS = {
  /** 706 Services vendus · 7065 « sur internet » : un logiciel en ligne. */
  revenue: { code: "7065", label: "Services vendus sur internet" },
  /** Contrepartie de trésorerie, par canal. */
  treasury: {
    cash: { code: "571", label: "Caisse siège social" },
    bank_transfer: { code: "521", label: "Banques locales" },
    orange_money: { code: "552", label: "Monnaie électronique, téléphone portable" },
    mtn_momo: { code: "552", label: "Monnaie électronique, téléphone portable" },
    moov_money: { code: "552", label: "Monnaie électronique, téléphone portable" },
    wave: { code: "552", label: "Monnaie électronique, téléphone portable" },
    other: { code: "571", label: "Caisse siège social" },
  } satisfies Record<RevenueChannel, { code: string; label: string }>,
  /**
   * TVA collectée. Inutilisé tant que l'éditeur n'est pas assujetti : les
   * montants sont alors intégralement du produit. Déclaré ici pour que le
   * jour où la TVA s'applique, l'export ait déjà sa place prévue.
   */
  vat: { code: "4431", label: "TVA facturée sur ventes" },
} as const

/** Taux de TVA appliqué à l'export. `0` = non assujetti (choix actuel). */
export const VAT_RATE = 0

// ---------------------------------------------------------------------------
// Lignes du registre
// ---------------------------------------------------------------------------

export interface RevenueRow {
  id: string
  organization_id: string | null
  organization_name: string
  plan_code: string
  plan_name: string
  amount_cents: number
  months: number
  period_start: string
  period_end: string
  channel: string
  payment_reference: string | null
  source: string
  operator_email: string | null
  note: string | null
  reverses_id: string | null
  occurred_at: string
}

const ROW_SELECT = `id, organization_id, organization_name, plan_code, plan_name,
  amount_cents::bigint AS amount_cents, months, period_start, period_end, channel,
  payment_reference, source, operator_email, note, reverses_id, occurred_at`

/** Les encaissements d'une fenêtre, du plus récent au plus ancien. */
export async function listRevenue(
  pool: Queryable,
  opts: { from?: Date; to?: Date; organizationId?: string | null; limit?: number } = {},
): Promise<RevenueRow[]> {
  const conditions: string[] = []
  const values: unknown[] = []
  if (opts.from) {
    values.push(opts.from.toISOString())
    conditions.push(`occurred_at >= $${values.length}::timestamptz`)
  }
  if (opts.to) {
    values.push(opts.to.toISOString())
    conditions.push(`occurred_at < $${values.length}::timestamptz`)
  }
  if (opts.organizationId) {
    values.push(opts.organizationId)
    conditions.push(`organization_id = $${values.length}::uuid`)
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
  const limit = Math.min(Math.max(opts.limit ?? 5000, 1), 20000)
  const q = await pool.query(
    `SELECT ${ROW_SELECT} FROM subscription_payments ${where}
     ORDER BY occurred_at DESC, created_at DESC LIMIT ${limit}`,
    values,
  )
  // `bigint` revient en texte avec le pilote pg : sans cette conversion les
  // montants se concaténeraient au lieu de s'additionner.
  return q.rows.map((r) => ({ ...r, amount_cents: Number(r.amount_cents) }) as RevenueRow)
}

// ---------------------------------------------------------------------------
// Séries mensuelles
// ---------------------------------------------------------------------------

export interface MonthPoint {
  /** Mois au format `AAAA-MM`. */
  month: string
  /** Argent effectivement reçu ce mois-là, en centimes. */
  collected_cents: number
  /** Part du revenu rattachée à ce mois, en centimes. */
  recognized_cents: number
  /** Nombre d'encaissements reçus ce mois-là (contrepassations exclues). */
  payments: number
}

/** Clé `AAAA-MM` d'une date, en UTC — le serveur raisonne en UTC partout. */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
}

function addMonths(d: Date, n: number): Date {
  const out = new Date(d)
  out.setUTCMonth(out.getUTCMonth() + n)
  return out
}

const DAY_MS = 86_400_000

/**
 * Étale un encaissement sur les mois calendaires que sa période recouvre,
 * **au prorata des jours**.
 *
 * Un découpage par mois entier serait plus simple, mais faux dès que la
 * période ne colle pas au calendrier : un paiement du 15 mars au 15 juin
 * couvre quatre mois civils, pas trois, et attribuer un tiers à chacun des
 * trois premiers décalerait la courbe d'une quinzaine. Le prorata journalier
 * n'a pas ce défaut et gère les mois de longueurs inégales sans cas
 * particulier.
 *
 * Le dernier mois absorbe l'arrondi, de sorte que la somme des parts égale
 * toujours le montant exact — un centime perdu par ligne finirait par
 * creuser un écart avec le total encaissé.
 */
export function spreadOverMonths(
  amountCents: number,
  periodStart: Date,
  periodEnd: Date,
): Map<string, number> {
  const out = new Map<string, number>()
  const totalMs = periodEnd.getTime() - periodStart.getTime()
  if (totalMs <= 0) {
    out.set(monthKey(periodStart), amountCents)
    return out
  }

  // Bornes de chaque mois civil traversé.
  const cursor = new Date(
    Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), 1),
  )
  const slices: Array<{ key: string; ms: number }> = []
  while (cursor.getTime() < periodEnd.getTime()) {
    const next = addMonths(cursor, 1)
    const sliceStart = Math.max(cursor.getTime(), periodStart.getTime())
    const sliceEnd = Math.min(next.getTime(), periodEnd.getTime())
    if (sliceEnd > sliceStart) {
      slices.push({ key: monthKey(cursor), ms: sliceEnd - sliceStart })
    }
    cursor.setTime(next.getTime())
  }
  if (!slices.length) {
    out.set(monthKey(periodStart), amountCents)
    return out
  }

  let assigned = 0
  slices.forEach((slice, i) => {
    const part =
      i === slices.length - 1
        ? amountCents - assigned
        : Math.round((amountCents * slice.ms) / totalMs)
    assigned += part
    out.set(slice.key, (out.get(slice.key) ?? 0) + part)
  })
  return out
}

/**
 * Série mensuelle sur une fenêtre, les deux lectures côte à côte.
 *
 * Les encaissements lus débordent volontairement la fenêtre : un paiement
 * reçu en janvier et couvrant jusqu'en juin doit alimenter le revenu reconnu
 * de mars, même si l'on n'affiche que mars. Ne lire que la fenêtre
 * produirait une courbe de revenu reconnu artificiellement vide au début.
 */
export async function monthlyRevenue(
  pool: Queryable,
  from: Date,
  to: Date,
): Promise<MonthPoint[]> {
  const q = await pool.query(
    `SELECT ${ROW_SELECT} FROM subscription_payments
     WHERE occurred_at < $2::timestamptz AND period_end > $1::timestamptz
        OR (occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz)`,
    [from.toISOString(), to.toISOString()],
  )
  const rows = q.rows.map((r) => ({ ...r, amount_cents: Number(r.amount_cents) }) as RevenueRow)

  const buckets = new Map<string, MonthPoint>()
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1))
  while (cursor.getTime() < to.getTime()) {
    buckets.set(monthKey(cursor), {
      month: monthKey(cursor),
      collected_cents: 0,
      recognized_cents: 0,
      payments: 0,
    })
    cursor.setTime(addMonths(cursor, 1).getTime())
  }

  for (const row of rows) {
    const occurred = new Date(row.occurred_at)
    const cashBucket = buckets.get(monthKey(occurred))
    if (cashBucket && occurred >= from && occurred < to) {
      cashBucket.collected_cents += row.amount_cents
      // Une contrepassation n'est pas un encaissement de plus : elle en
      // retire un. La compter ferait croire à deux ventes là où il n'y en a
      // eu aucune.
      cashBucket.payments += row.reverses_id ? -1 : 1
    }
    const spread = spreadOverMonths(
      row.amount_cents,
      new Date(row.period_start),
      new Date(row.period_end),
    )
    for (const [key, part] of spread) {
      const bucket = buckets.get(key)
      if (bucket) bucket.recognized_cents += part
    }
  }

  return [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month))
}

/**
 * Produits constatés d'avance : l'argent déjà reçu pour du service pas
 * encore rendu.
 *
 * Un client qui règle douze mois d'avance verse une somme dont la plus
 * grande part n'est pas encore gagnée. Comptablement c'est une dette : s'il
 * résilie au troisième mois, les neuf restants lui sont dus. La confondre
 * avec du bénéfice est la façon la plus simple de se croire riche et de
 * dépenser l'argent des autres.
 *
 * Calcul au prorata des jours restant à courir, cohérent avec
 * `spreadOverMonths`.
 */
export async function deferredRevenue(pool: Queryable, now: Date): Promise<number> {
  const q = await pool.query(
    `SELECT amount_cents::bigint AS amount_cents, period_start, period_end
       FROM subscription_payments
      WHERE period_end > $1::timestamptz`,
    [now.toISOString()],
  )
  let total = 0
  for (const raw of q.rows) {
    const row = raw as { amount_cents: string; period_start: string; period_end: string }
    const amount = Number(row.amount_cents)
    const start = new Date(row.period_start).getTime()
    const end = new Date(row.period_end).getTime()
    const span = end - start
    if (span <= 0) continue
    const remaining = Math.min(end - now.getTime(), span)
    if (remaining <= 0) continue
    total += Math.round((amount * remaining) / span)
  }
  return total
}

// ---------------------------------------------------------------------------
// Impayés
// ---------------------------------------------------------------------------

export interface AtRiskRow {
  organization_id: string
  organization_name: string
  plan_code: string
  plan_name: string
  price_cents: number
  current_period_end: string
  days_overdue: number
}

export interface PendingRow {
  reference: string
  organization_id: string
  organization_name: string
  plan_code: string
  months: number
  amount_cents: number
  declared_at: string | null
  created_at: string
}

/**
 * Ce qui devrait être encaissé et ne l'est pas.
 *
 * Deux natures distinctes, délibérément séparées :
 *
 * - **à risque** : des stations `active` dont l'échéance est passée. Elles
 *   travaillent toujours — aucune coupure automatique, c'est la règle — mais
 *   n'ont rien payé depuis. C'est du revenu en train de fuir.
 * - **en attente** : des intentions de paiement que le client a déclaré
 *   avoir réglées, sans confirmation de l'éditeur. L'argent est peut-être
 *   arrivé ; tant qu'il n'est pas vérifié il n'entre pas au registre.
 *   Déclarer n'est pas payer.
 */
export async function revenueAtRisk(
  pool: Queryable,
  now: Date,
): Promise<{ at_risk: AtRiskRow[]; pending: PendingRow[] }> {
  const riskQ = await pool.query(
    `SELECT o.id AS organization_id, o.name AS organization_name,
            p.code AS plan_code, p.name AS plan_name, p.price_cents,
            s.current_period_end
     FROM organizations o
     JOIN subscriptions s ON s.organization_id = o.id
     JOIN plans p ON p.id = s.plan_id
     WHERE s.status = 'active'
       AND s.current_period_end IS NOT NULL
       AND s.current_period_end < $1::timestamptz
       AND o.deletion_requested_at IS NULL
     ORDER BY s.current_period_end ASC`,
    [now.toISOString()],
  )

  const pendingQ = await pool.query(
    `SELECT i.reference, i.organization_id, o.name AS organization_name,
            i.plan_code, i.months, i.amount_cents, i.declared_at, i.created_at
     FROM payment_intents i JOIN organizations o ON o.id = i.organization_id
     WHERE i.status = 'pending' AND i.declared_at IS NOT NULL
     ORDER BY i.declared_at ASC`,
  )

  return {
    at_risk: riskQ.rows.map((r) => {
      const end = new Date(r.current_period_end as string)
      return {
        ...r,
        price_cents: Number(r.price_cents),
        days_overdue: Math.max(0, Math.floor((now.getTime() - end.getTime()) / DAY_MS)),
      } as AtRiskRow
    }),
    pending: pendingQ.rows.map((r) => ({ ...r, amount_cents: Number(r.amount_cents) }) as PendingRow),
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Une cellule CSV. Le séparateur est le point-virgule et non la virgule :
 * un tableur configuré en français lit mal le second, et les montants en
 * FCFA s'écrivent sans décimale mais avec des espaces de milliers.
 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  const text = String(value)
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(rows: Array<Array<unknown>>): string {
  // Le BOM est indispensable : sans lui, Excel sous Windows affiche « StÃ©phane »
  // au lieu de « Stéphane ».
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(";")).join("\r\n")}\r\n`
}

const ISO_DAY = (value: string | Date): string =>
  (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 10)

/** Export détaillé : une ligne par encaissement, pour piloter. */
export function detailedCsv(rows: RevenueRow[]): string {
  const out: Array<Array<unknown>> = [
    [
      "Date d'encaissement",
      "Station",
      "Forfait",
      "Mois",
      "Début de période",
      "Fin de période",
      "Montant (FCFA)",
      "Canal",
      "Référence",
      "Origine",
      "Opérateur",
      "Contrepassation",
      "Note",
    ],
  ]
  for (const r of rows) {
    out.push([
      ISO_DAY(r.occurred_at),
      r.organization_name,
      r.plan_name,
      r.months,
      ISO_DAY(r.period_start),
      ISO_DAY(r.period_end),
      // Les centimes sont une commodité interne ; le FCFA n'a pas de
      // subdivision en usage. On exporte des francs entiers.
      Math.round(r.amount_cents / 100),
      REVENUE_CHANNEL_LABELS[r.channel as RevenueChannel] ?? r.channel,
      r.payment_reference ?? "",
      r.source,
      r.operator_email ?? "",
      r.reverses_id ? "oui" : "",
      r.note ?? "",
    ])
  }
  return toCsv(out)
}

/**
 * Export en écritures SYSCOHADA, **sur la base de l'encaissement**.
 *
 * Chaque ligne du registre devient deux lignes équilibrées : trésorerie au
 * débit, produit au crédit. Une contrepassation inverse les deux sens plutôt
 * que de porter un montant négatif — un journal ne contient pas de nombres
 * négatifs, il contient des écritures en sens inverse.
 *
 * Cette base « encaissement » correspond au Système Minimal de Trésorerie,
 * que retiennent la plupart des très petites entités. Un cabinet qui tient
 * une comptabilité d'engagement voudra en plus constater les produits
 * d'avance : l'export détaillé porte pour cela les dates de début et de fin
 * de période, que ce journal-ci n'exprime pas.
 */
export function journalCsv(rows: RevenueRow[]): string {
  const out: Array<Array<unknown>> = [
    ["Date", "Journal", "Pièce", "Compte", "Libellé du compte", "Libellé", "Débit", "Crédit"],
  ]
  for (const r of rows) {
    const francs = Math.round(Math.abs(r.amount_cents) / 100)
    const reversed = r.amount_cents < 0
    const treasury =
      SYSCOHADA_ACCOUNTS.treasury[r.channel as RevenueChannel] ??
      SYSCOHADA_ACCOUNTS.treasury.other
    const piece = r.payment_reference || r.id.slice(0, 8).toUpperCase()
    const label = `${reversed ? "Annulation abonnement" : "Abonnement"} ${r.plan_name} - ${r.organization_name}`
    const date = ISO_DAY(r.occurred_at)

    out.push([
      date,
      "VT",
      piece,
      treasury.code,
      treasury.label,
      label,
      reversed ? "" : francs,
      reversed ? francs : "",
    ])
    out.push([
      date,
      "VT",
      piece,
      SYSCOHADA_ACCOUNTS.revenue.code,
      SYSCOHADA_ACCOUNTS.revenue.label,
      label,
      reversed ? francs : "",
      reversed ? "" : francs,
    ])
  }
  return toCsv(out)
}
