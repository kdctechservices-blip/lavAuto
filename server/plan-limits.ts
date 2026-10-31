import type { Pool, PoolClient } from "pg"
import { HttpError } from "./auth.ts"

// ---------------------------------------------------------------------------
// Limites de forfait et rétrogradation
//
// Règle fondatrice : **aucune donnée saisie n'est jamais supprimée ni masquée
// par un changement de forfait.** Une station qui rétrograde garde l'accès en
// lecture et en export à tout ce qu'elle a enregistré, indéfiniment. Couper
// l'accès à des données déjà saisies est le moyen le plus sûr de perdre un
// client — et c'est aussi, pour un gérant qui doit justifier une recette
// auprès du fisc, une faute.
//
// Ce qui change après une rétrogradation, c'est la capacité à en produire de
// nouvelles au-delà de la limite :
//
//   1. **Création bloquée immédiatement.** Au-delà de `max_sites`, la création
//      d'une station est refusée (409). Pas de délai de grâce ici : on ne
//      laisse pas quelqu'un aggraver un dépassement.
//   2. **Délai de grâce de 14 jours sur l'existant.** Pendant ce délai, toutes
//      les stations continuent de fonctionner normalement. Le propriétaire est
//      prévenu et choisit lesquelles garder actives.
//   3. **Au terme du délai**, les stations excédentaires passent en lecture
//      seule : plus de nouveau lavage, de caisse ni de dépense dessus. Leur
//      historique reste entièrement lisible et exportable.
//
// Quelles stations restent actives ? Les plus anciennes, par date de création.
// Le critère doit être déterministe et prévisible — « la station historique
// reste » se comprend sans explication, « celle dont l'identifiant est le plus
// petit » ne se comprend jamais. Le propriétaire peut recomposer son choix à
// tout moment en désactivant une station pour en réactiver une autre.
// ---------------------------------------------------------------------------

/** Jours pendant lesquels l'existant continue de fonctionner après une baisse de forfait. */
export const DOWNGRADE_GRACE_DAYS = 14
const DAY_MS = 86_400_000

export interface LimitInput {
  /** Plafond du forfait. `null` = illimité. */
  limit: number | null
  /** Nombre d'unités actives aujourd'hui. */
  activeCount: number
  /** Date du dernier changement de forfait. */
  planChangedAt: Date | string | null
  now?: Date
}

export interface LimitState {
  limit: number | null
  active_count: number
  /** Places encore disponibles (`null` si illimité). */
  remaining: number | null
  /** Vrai dès que l'on dépasse — y compris pendant le délai de grâce. */
  over_limit: boolean
  /** Nombre d'unités au-delà du plafond. */
  excess: number
  /** Fin du délai de grâce, `null` s'il n'y a pas de dépassement. */
  grace_ends_at: string | null
  /** Jours restants avant l'application de la lecture seule. */
  grace_days_remaining: number
  /** Vrai quand le délai est écoulé : l'excédent passe en lecture seule. */
  enforced: boolean
  /** Vrai quand on ne peut plus créer de nouvelle unité. */
  creation_blocked: boolean
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Calcule l'état d'une limite de forfait. Fonction pure : c'est elle que les
 * tests couvrent, l'accès base est séparé.
 */
export function resolveLimitState(input: LimitInput): LimitState {
  const now = input.now ?? new Date()
  const { limit, activeCount } = input

  if (limit === null || limit === undefined) {
    return {
      limit: null,
      active_count: activeCount,
      remaining: null,
      over_limit: false,
      excess: 0,
      grace_ends_at: null,
      grace_days_remaining: 0,
      enforced: false,
      creation_blocked: false,
    }
  }

  const excess = Math.max(0, activeCount - limit)
  const overLimit = excess > 0
  const changedAt = toDate(input.planChangedAt)

  // Sans date de changement connue, on considère le délai comme déjà écoulé :
  // mieux vaut appliquer la règle que laisser un dépassement indéfini sur une
  // donnée manquante.
  const graceEnd = changedAt ? new Date(changedAt.getTime() + DOWNGRADE_GRACE_DAYS * DAY_MS) : null
  const graceExpired = !graceEnd || graceEnd.getTime() <= now.getTime()
  const msRemaining = graceEnd ? Math.max(0, graceEnd.getTime() - now.getTime()) : 0

  return {
    limit,
    active_count: activeCount,
    remaining: Math.max(0, limit - activeCount),
    over_limit: overLimit,
    excess,
    grace_ends_at: overLimit && graceEnd ? graceEnd.toISOString() : null,
    grace_days_remaining: overLimit ? Math.ceil(msRemaining / DAY_MS) : 0,
    enforced: overLimit && graceExpired,
    // On bloque la création dès que le plafond est atteint, délai de grâce ou
    // non : le délai sert à réorganiser l'existant, pas à l'étendre.
    creation_blocked: activeCount >= limit,
  }
}

// ---------------------------------------------------------------------------
// Accès base
// ---------------------------------------------------------------------------

interface SiteLimitRow {
  max_sites: number | null
  plan_changed_at: Date | null
  active_count: number
}

async function loadSiteLimitRow(
  client: Pool | PoolClient,
  organizationId: string,
): Promise<SiteLimitRow> {
  const q = await client.query(
    `SELECT p.max_sites, s.plan_changed_at,
            (SELECT COUNT(*)::int FROM sites WHERE organization_id=$1::uuid AND is_active=true) AS active_count
     FROM organizations o
     LEFT JOIN subscriptions s ON s.organization_id = o.id
     LEFT JOIN plans p ON p.id = s.plan_id
     WHERE o.id = $1::uuid`,
    [organizationId],
  )
  const row = q.rows[0]
  return {
    max_sites: row?.max_sites ?? null,
    plan_changed_at: row?.plan_changed_at ?? null,
    active_count: Number(row?.active_count ?? 0),
  }
}

/** État de la limite de stations d'une organisation. */
export async function loadSiteLimitState(
  client: Pool | PoolClient,
  organizationId: string,
  now = new Date(),
): Promise<LimitState> {
  const row = await loadSiteLimitRow(client, organizationId)
  return resolveLimitState({
    limit: row.max_sites,
    activeCount: row.active_count,
    planChangedAt: row.plan_changed_at,
    now,
  })
}

/**
 * Refuse la création (ou la réactivation) d'une station au-delà du forfait.
 * Verrou consultatif par organisation, comme pour les laveurs et les
 * utilisateurs : sans lui, deux créations simultanées passent toutes les deux.
 */
export async function assertSiteCapacity(client: PoolClient, organizationId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [organizationId])
  const state = await loadSiteLimitState(client, organizationId)
  if (state.creation_blocked) {
    throw new HttpError(
      409,
      "plan_site_limit",
      state.limit === 1
        ? "Votre forfait couvre une seule station. Passez au forfait Business pour en gérer plusieurs."
        : `Votre forfait couvre ${state.limit} stations actives. Désactivez-en une ou changez de forfait.`,
    )
  }
}

/**
 * Identifiants des stations encore inscriptibles.
 *
 * Tant que le délai de grâce court, toutes le sont. Au terme, seules les
 * `max_sites` plus anciennes le restent — les autres gardent leur historique
 * en lecture, mais n'acceptent plus de nouvelle opération.
 */
export async function writableSiteIds(
  client: Pool | PoolClient,
  organizationId: string,
  now = new Date(),
): Promise<{ state: LimitState; ids: string[] | null }> {
  const state = await loadSiteLimitState(client, organizationId, now)
  if (!state.enforced || state.limit === null) return { state, ids: null }
  const q = await client.query(
    `SELECT id FROM sites WHERE organization_id=$1::uuid AND is_active=true
     ORDER BY created_at, id LIMIT $2::int`,
    [organizationId, state.limit],
  )
  return { state, ids: q.rows.map((row) => row.id as string) }
}

/**
 * Refuse une écriture sur une station devenue excédentaire après rétrogradation.
 * Appelée partout où un `site_id` est enregistré (lavage, caisse, dépense).
 */
export async function assertSiteWritable(
  client: Pool | PoolClient,
  organizationId: string,
  siteId: string | null | undefined,
  now = new Date(),
) {
  if (!siteId) return
  const { state, ids } = await writableSiteIds(client, organizationId, now)
  if (!ids || ids.includes(siteId)) return
  const covered =
    state.limit === 1
      ? "la station couverte par votre forfait"
      : `les ${state.limit} stations couvertes par votre forfait`
  throw new HttpError(
    402,
    "site_over_plan_limit",
    `Cette station dépasse ${covered} : son historique reste consultable et exportable, mais elle n’accepte plus de nouvelle opération. Désactivez une autre station pour lui rendre la main, ou repassez au forfait supérieur.`,
  )
}
