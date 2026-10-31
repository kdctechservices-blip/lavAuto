/**
 * Mise en forme unique des montants, des dates et des quantités.
 *
 * Le dépôt contenait quatre conventions pour la même somme : « 2 500 XOF »,
 * « 2 500 FCFA », « 2 500 F CFA » et « 2 500 FCFA » sans espace insécable. Un
 * caissier qui compare deux écrans ne doit pas se demander si l'unité change
 * quelque chose au montant. **Une seule unité : le franc CFA.**
 *
 * Les dates suivent la même règle : fuseau d'Abidjan (UTC+0, sans heure d'été),
 * locale `fr-CI`, et un format choisi selon l'usage — jamais `toLocaleString()`
 * nu, dont le rendu dépend du navigateur.
 */

export const LOCALE = "fr-CI"
export const TIME_ZONE = "Africa/Abidjan"
/** Libellé affiché de la devise. Le centime reste l'unité de stockage. */
export const CURRENCY_LABEL = "F CFA"

/** Espace insécable fine : Intl en produit une, on la normalise pour les tests. */
const NNBSP = /[\u202f\u00a0]/g

function normalize(value: string): string {
  return value.replace(NNBSP, " ")
}

/**
 * Montant en centimes → « 12 500 F CFA ».
 *
 * `signed` ajoute un signe explicite : utile pour un écart de caisse, inutile
 * pour une recette. `compact` abrège au-delà du million (« 1,2 M F CFA ») pour
 * les KPI, jamais dans un tableau — un montant exact ne s'abrège pas.
 */
export function formatXof(
  cents: number | null | undefined,
  options: { signed?: boolean; compact?: boolean; decimals?: boolean } = {},
): string {
  if (cents == null || !Number.isFinite(cents)) return "—"
  const amount = cents / 100
  const formatter = new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: options.decimals ? 2 : 0,
    maximumFractionDigits: options.decimals ? 2 : 0,
  })
  const abs = Math.abs(amount)
  let body: string
  if (options.compact && abs >= 1_000_000) {
    body = `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 }).format(amount / 1_000_000)} M`
  } else {
    body = formatter.format(amount)
  }
  // Intl place déjà le « - » des montants négatifs : le préfixer donnerait
  // « --2 500 ». On n'ajoute donc que le « + » explicite.
  const sign = options.signed && amount > 0 ? "+" : ""
  return normalize(`${sign}${body} ${CURRENCY_LABEL}`)
}

/** Montant déjà exprimé en francs (pas en centimes) → « 12 500 F CFA ». */
export function formatXofUnits(
  francs: number | null | undefined,
  options: { signed?: boolean; compact?: boolean } = {},
): string {
  if (francs == null || !Number.isFinite(francs)) return "—"
  return formatXof(Math.round(francs * 100), options)
}

export function formatNumber(value: number | null | undefined, decimals = 0): string {
  if (value == null || !Number.isFinite(value)) return "—"
  return normalize(
    new Intl.NumberFormat(LOCALE, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value),
  )
}

export function formatPercent(
  value: number | null | undefined,
  options: { decimals?: number; input?: "ratio" | "percent" } = {},
): string {
  if (value == null || !Number.isFinite(value)) return "—"
  const ratio = options.input === "percent" ? value / 100 : value
  return normalize(
    new Intl.NumberFormat(LOCALE, {
      style: "percent",
      minimumFractionDigits: options.decimals ?? 0,
      maximumFractionDigits: options.decimals ?? 0,
    }).format(ratio),
  )
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const DATE_FORMATS = {
  /** « 22 oct. 2026 » */
  short: { day: "numeric", month: "short", year: "numeric" },
  /** « jeudi 22 octobre 2026 » */
  long: { weekday: "long", day: "numeric", month: "long", year: "numeric" },
  /** « 22/10/2026 » */
  numeric: { day: "2-digit", month: "2-digit", year: "numeric" },
  /** « 22 oct. » — pour un axe de graphique */
  day: { day: "numeric", month: "short" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>

export type DateStyleName = keyof typeof DATE_FORMATS

export function formatDate(
  value: string | number | Date | null | undefined,
  style: DateStyleName = "short",
): string {
  const date = toDate(value)
  if (!date) return "—"
  return normalize(
    new Intl.DateTimeFormat(LOCALE, {
      ...DATE_FORMATS[style],
      timeZone: TIME_ZONE,
    }).format(date),
  )
}

/** « 22 oct. 2026, 14:32 » — la minute suffit à reconstituer une séquence. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value)
  if (!date) return "—"
  return normalize(
    new Intl.DateTimeFormat(LOCALE, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: TIME_ZONE,
    }).format(date),
  )
}

/** « 14:32 » */
export function formatTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value)
  if (!date) return "—"
  return normalize(
    new Intl.DateTimeFormat(LOCALE, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: TIME_ZONE,
    }).format(date),
  )
}

/** Date du jour au format `AAAA-MM-JJ` attendu par l'API, en heure d'Abidjan. */
export function todayIso(): string {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * « il y a 5 min », « hier à 14:32 », « 18 oct. 2026 ».
 * Au-delà d'une semaine, une date absolue est plus utile qu'un « il y a 12 jours ».
 */
export function formatRelative(
  value: string | number | Date | null | undefined,
  now: Date | number = Date.now(),
): string {
  const date = toDate(value)
  if (!date) return "—"
  const reference = typeof now === "number" ? new Date(now) : now
  const diff = reference.getTime() - date.getTime()

  if (diff < 0) return formatDateTime(date)
  if (diff < MINUTE) return "à l'instant"
  if (diff < HOUR) return `il y a ${Math.floor(diff / MINUTE)} min`
  if (diff < DAY) return `il y a ${Math.floor(diff / HOUR)} h`
  if (diff < 2 * DAY) return `hier à ${formatTime(date)}`
  if (diff < 7 * DAY) return `il y a ${Math.floor(diff / DAY)} jours`
  return formatDate(date, "short")
}

/**
 * Quantité + unité, sans jamais afficher un nombre nu.
 * « 3 lavages », « 1 lavage », « 4,5 L », « 2 bidons ».
 */
export function formatQuantity(
  value: number | null | undefined,
  unit: { singular: string; plural?: string },
  decimals = 0,
): string {
  if (value == null || !Number.isFinite(value)) return "—"
  const number = formatNumber(value, decimals)
  const plural = unit.plural ?? `${unit.singular}s`
  return `${number} ${Math.abs(value) > 1 ? plural : unit.singular}`
}

/** Montant signé lisible par un lecteur d'écran : « plus 2 500 F CFA ». */
export function spokenXof(cents: number | null | undefined): string {
  const formatted = formatXof(cents)
  if (formatted === "—") return "montant inconnu"
  return cents != null && cents < 0 ? `moins ${formatXof(Math.abs(cents))}` : formatted
}
