/**
 * L'engagement de délai de première réponse.
 *
 * Le forfait Pro vend « Assistance prioritaire ». `TARIFS.md` §6 refusait
 * d'écrire la moindre ligne tant que le mot n'était pas défini : promettre
 * « prioritaire » sans délai mesurable est une promesse qu'on ne peut ni tenir
 * ni démentir. L'arbitrage est pris — la priorité devient **un délai de
 * première réponse, affiché au client et mesuré**.
 *
 * Conséquence volontaire : ce fichier rend l'éditeur réfutable. Une demande
 * qui dépasse son échéance est visible dans la console, et le client connaît
 * le délai qu'on lui a promis. C'est tout l'intérêt, et tout le risque.
 *
 * ## Pourquoi des heures ouvrées
 *
 * « Quatre heures » un samedi à 23 h ne veut rien dire quand une seule
 * personne tient l'assistance. Compter en heures ouvrées est la seule façon
 * d'énoncer un engagement qu'on peut réellement honorer.
 *
 * ## Pourquoi le calcul tient en UTC
 *
 * La Côte d'Ivoire est à UTC+0 toute l'année : pas d'heure d'été, donc pas de
 * saut de fuseau. Heure d'Abidjan et UTC coïncident, ce qui permet de calculer
 * avec les accesseurs UTC natifs sans bibliothèque de fuseaux — conforme à la
 * contrainte « aucune nouvelle dépendance ». Si le produit sort un jour d'une
 * zone UTC+0, c'est ici qu'il faudra revenir.
 */

/** Début de la journée d'assistance, heure d'Abidjan. */
export const BUSINESS_DAY_START_HOUR = 8
/** Fin de la journée d'assistance, heure d'Abidjan. */
export const BUSINESS_DAY_END_HOUR = 18
/** Heures ouvrées dans une journée. */
export const BUSINESS_HOURS_PER_DAY = BUSINESS_DAY_END_HOUR - BUSINESS_DAY_START_HOUR

const MS_PER_HOUR = 3_600_000

/**
 * Engagement par forfait, **en heures ouvrées**.
 *
 * Exprimé en heures et non en jours pour que « 4 h » et « 1 jour » se
 * comparent sans conversion implicite. Un jour ouvré vaut dix heures.
 *
 * Les valeurs sont volontairement prudentes : une seule personne tient
 * l'assistance aujourd'hui. Mieux vaut un engagement tenu qu'un engagement
 * flatteur. Les relever est facile ; les abaisser après les avoir annoncés ne
 * l'est pas.
 */
export const RESPONSE_COMMITMENT_HOURS: Record<string, number> = {
  business: 4,
  pro: BUSINESS_HOURS_PER_DAY, // 1 jour ouvré
  starter: BUSINESS_HOURS_PER_DAY * 3, // 3 jours ouvrés
}

/**
 * Pour un essai, ou en l'absence d'abonnement. Non vendu, donc non promis :
 * c'est un maximum indicatif, pas un engagement contractuel.
 */
export const DEFAULT_COMMITMENT_HOURS = BUSINESS_HOURS_PER_DAY * 5

/** Libellé affichable de l'engagement. */
export function commitmentLabel(hours: number): string {
  if (hours < BUSINESS_HOURS_PER_DAY) {
    return `${hours} heures ouvrées`
  }
  const days = hours / BUSINESS_HOURS_PER_DAY
  return days === 1 ? "1 jour ouvré" : `${days} jours ouvrés`
}

/** Heures ouvrées promises pour un code de forfait. */
export function commitmentFor(planCode: string | null | undefined): number {
  if (!planCode) return DEFAULT_COMMITMENT_HOURS
  return RESPONSE_COMMITMENT_HOURS[planCode] ?? DEFAULT_COMMITMENT_HOURS
}

/** Samedi et dimanche exclus. `getUTCDay()` : 0 = dimanche, 6 = samedi. */
function isWorkingDay(date: Date): boolean {
  const day = date.getUTCDay()
  return day >= 1 && day <= 5
}

/** Début de la fenêtre d'assistance du jour de `date`. */
function windowStart(date: Date): Date {
  const d = new Date(date)
  d.setUTCHours(BUSINESS_DAY_START_HOUR, 0, 0, 0)
  return d
}

/** Fin de la fenêtre d'assistance du jour de `date`. */
function windowEnd(date: Date): Date {
  const d = new Date(date)
  d.setUTCHours(BUSINESS_DAY_END_HOUR, 0, 0, 0)
  return d
}

/**
 * Premier instant ouvré à partir de `date` (inclus).
 *
 * Une demande déposée un samedi, ou à 23 h, commence à courir au prochain
 * créneau d'ouverture. Le client n'est pas pénalisé pour avoir écrit la nuit :
 * son compteur démarre lundi 8 h, pas samedi 23 h.
 */
export function nextBusinessInstant(date: Date): Date {
  let cursor = new Date(date)
  // Au plus 7 itérations : un week-end ne dure pas plus longtemps.
  for (let guard = 0; guard < 8; guard += 1) {
    if (isWorkingDay(cursor)) {
      const start = windowStart(cursor)
      const end = windowEnd(cursor)
      if (cursor < start) return start
      if (cursor < end) return cursor
    }
    // Jour suivant, à l'ouverture.
    cursor = windowStart(new Date(cursor.getTime() + 24 * MS_PER_HOUR))
  }
  return cursor
}

/**
 * `start` + `hours` heures ouvrées.
 *
 * Le résultat tombe toujours à l'intérieur d'une fenêtre d'ouverture (ou
 * exactement à sa fermeture), jamais un week-end ni en pleine nuit.
 */
export function addBusinessHours(start: Date, hours: number): Date {
  let cursor = nextBusinessInstant(start)
  let remainingMs = hours * MS_PER_HOUR
  if (remainingMs <= 0) return cursor

  for (let guard = 0; guard < 400; guard += 1) {
    const end = windowEnd(cursor)
    const availableMs = end.getTime() - cursor.getTime()
    if (remainingMs <= availableMs) {
      return new Date(cursor.getTime() + remainingMs)
    }
    remainingMs -= availableMs
    // Reprise à l'ouverture du prochain jour ouvré.
    cursor = nextBusinessInstant(windowStart(new Date(end.getTime() + 24 * MS_PER_HOUR)))
  }
  return cursor
}

/**
 * Heures ouvrées écoulées entre deux instants.
 *
 * Écrite indépendamment de `addBusinessHours` — elle balaie les journées une à
 * une plutôt que de consommer un solde. Les deux fonctions se contrôlent
 * mutuellement dans les tests : si elles sont d'accord sur des milliers de
 * tirages, c'est que l'arithmétique tient.
 */
export function businessHoursBetween(from: Date, to: Date): number {
  if (to <= from) return 0
  let total = 0
  // On part du premier jour concerné, à minuit, et on avance jour par jour.
  const cursor = new Date(from)
  cursor.setUTCHours(0, 0, 0, 0)

  for (let guard = 0; guard < 4000 && cursor < to; guard += 1) {
    if (isWorkingDay(cursor)) {
      const open = windowStart(cursor).getTime()
      const close = windowEnd(cursor).getTime()
      const a = Math.max(open, from.getTime())
      const b = Math.min(close, to.getTime())
      if (b > a) total += (b - a) / MS_PER_HOUR
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return total
}

/** Échéance de première réponse pour une demande reçue à `receivedAt`. */
export function responseDueAt(receivedAt: Date, planCode: string | null | undefined): Date {
  return addBusinessHours(receivedAt, commitmentFor(planCode))
}

/**
 * Où en est une demande par rapport à son échéance.
 *
 * `breached` reste vrai une fois l'échéance dépassée même après réponse : on
 * ne réécrit pas l'histoire. Une réponse tardive reste une réponse tardive,
 * sans quoi la mesure ne vaudrait rien.
 */
export function slaState(
  dueAt: Date,
  firstRespondedAt: Date | null,
  now: Date = new Date(),
): { breached: boolean; hours_remaining: number; responded: boolean } {
  const reference = firstRespondedAt ?? now
  const breached = reference > dueAt
  // `businessHoursBetween` renvoie 0 quand la borne de fin precede la borne de
  // depart : il faut inverser les bornes pour mesurer un retard, pas se
  // contenter de changer le signe d'un zero.
  const remaining = firstRespondedAt
    ? 0
    : now > dueAt
      ? -businessHoursBetween(dueAt, now)
      : businessHoursBetween(now, dueAt)
  return {
    breached,
    hours_remaining: Math.round(remaining * 10) / 10,
    responded: firstRespondedAt !== null,
  }
}
