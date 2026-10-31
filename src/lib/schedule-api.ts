/**
 * Horaires de travail — conversions et libellés côté interface.
 *
 * Le serveur stocke une heure de la journée sous forme de MINUTES depuis minuit
 * (0 à 1439, voir `minuteOfDaySchema` dans server/attendance.ts). Le navigateur,
 * lui, manipule des champs `<input type="time">` qui parlent en "HH:MM".
 * Ce module fait la traduction dans les deux sens, en un seul endroit.
 *
 * `src/` ne peut pas importer `server/` : les bornes sont donc recopiées ici et
 * un test de non-divergence (tests/schedule-api.test.ts) vérifie qu'elles
 * restent identiques à celles du serveur.
 */

/** Première minute acceptée par le serveur (00:00). */
export const MIN_MINUTE_OF_DAY = 0
/** Dernière minute acceptée par le serveur (23:59). */
export const MAX_MINUTE_OF_DAY = 1439

/** Tolérance de retard maximale acceptée par le serveur, en minutes. */
export const MAX_LATE_TOLERANCE_MINUTES = 240
/** Durée de pause maximale acceptée par le serveur, en minutes. */
export const MAX_BREAK_MINUTES = 600

/** Jours de la semaine, dans l'ordre où le serveur les numérote (0 = dimanche). */
export const DAYS_OF_WEEK = [
  { value: 0, label: "Dimanche", short: "Dim" },
  { value: 1, label: "Lundi", short: "Lun" },
  { value: 2, label: "Mardi", short: "Mar" },
  { value: 3, label: "Mercredi", short: "Mer" },
  { value: 4, label: "Jeudi", short: "Jeu" },
  { value: 5, label: "Vendredi", short: "Ven" },
  { value: 6, label: "Samedi", short: "Sam" },
] as const

/**
 * Minutes depuis minuit vers "HH:MM".
 * Renvoie "—" si la valeur est absente ou hors bornes, pour ne jamais
 * afficher une heure fantaisiste dans un tableau.
 */
export function formatMinuteOfDay(minute: number | null | undefined): string {
  if (minute === null || minute === undefined) return "—"
  if (!Number.isInteger(minute) || minute < MIN_MINUTE_OF_DAY || minute > MAX_MINUTE_OF_DAY) return "—"
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

/**
 * "HH:MM" vers minutes depuis minuit.
 * Renvoie null si la saisie n'est pas une heure valide : l'appelant doit
 * refuser d'envoyer plutôt que de transmettre une valeur approximative.
 */
export function parseMinuteOfDay(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return h * 60 + m
}

/** Durée entre deux minutes de la journée, en toutes lettres ("8 h 30"). */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) return "—"
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  if (h === 0) return `${m} min`
  if (m === 0) return `${h} h`
  return `${h} h ${String(m).padStart(2, "0")}`
}

/** Un horaire tel que le serveur le renvoie. */
export interface WorkScheduleRecord {
  id: string
  site_id: string | null
  worker_id: string | null
  day_of_week: number | null
  specific_date: string | null
  start_minute: number
  end_minute: number
  break_duration_minutes: number
  late_tolerance_minutes: number
  valid_from: string | null
  valid_to: string | null
}

/** Une journée de présence telle que `/attendance/history` la renvoie. */
export interface AttendanceHistoryRow {
  id: string
  worker_id: string
  work_date: string
  check_in_at: string | null
  check_out_at: string | null
  break_minutes: number | null
  status: string
  absence_reason: string | null
  comment: string | null
  corrected_at: string | null
  correction_reason: string | null
  first_name: string
  last_name: string
}

/**
 * À qui s'applique l'horaire, en clair.
 * L'ordre des cas suit la précédence du serveur : le plus précis l'emporte.
 */
export function describeScope(
  schedule: Pick<WorkScheduleRecord, "worker_id" | "site_id">,
  workerName: string | null,
  siteName: string | null,
): string {
  if (schedule.worker_id) return workerName ?? "Un employé"
  if (schedule.site_id) return `Toute la station ${siteName ?? ""}`.trim()
  return "Tout le monde"
}

/** Quand l'horaire s'applique, en clair. */
export function describeWhen(schedule: Pick<WorkScheduleRecord, "day_of_week" | "specific_date">): string {
  if (schedule.specific_date) return `Le ${schedule.specific_date}`
  const day = DAYS_OF_WEEK.find((d) => d.value === schedule.day_of_week)
  if (day) return `Chaque ${day.label.toLowerCase()}`
  return "Tous les jours"
}

/**
 * Un horaire est-il encore en vigueur à la date donnée ?
 * Un horaire périmé reste visible mais doit être signalé : on ne supprime pas
 * l'historique, on indique seulement qu'il ne sert plus.
 */
export function isExpired(schedule: Pick<WorkScheduleRecord, "valid_to">, today: string): boolean {
  if (!schedule.valid_to) return false
  return schedule.valid_to < today
}
