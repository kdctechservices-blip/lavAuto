// ---------------------------------------------------------------------------
// Présences et attribution du travail : le cœur de règles, sans base ni HTTP.
//
// Tout ce qui se calcule est ici, en fonctions pures, pour être éprouvé sans
// serveur. Les routes ne font qu'appeler ces fonctions.
//
// Trois principes commandent ce fichier, et chacun répond à une manière
// courante de mentir avec des chiffres.
//
//   1. **Une donnée absente n'est pas un zéro.** Pas d'heure de sortie, donc
//      pas de temps de travail — on répond « inconnu », jamais « 0 h ». Un
//      zéro se moyenne, se classe et se reproche ; un « inconnu » appelle une
//      correction.
//
//   2. **On ne déduit pas une absence d'un silence.** Ne pas être pointé et
//      être absent sont deux choses différentes. La première est un trou dans
//      la saisie, la seconde une information sur la personne.
//
//   3. **Un lavage à plusieurs reste un lavage.** Compter un lavage entier
//      pour chacun des trois laveurs qui l'ont fait triplerait la production
//      de la station sur le papier. La quote-part existe pour cela.
// ---------------------------------------------------------------------------

/** Statuts qu'un relevé de présence peut porter en base. */
export const ATTENDANCE_STATUSES = [
  "present",
  "absent_declared",
  "absent_justified",
  "absent_unjustified",
  "leave",
] as const
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number]

/**
 * États affichés pour la journée d'un laveur.
 *
 * `not_recorded` n'existe pas en base : c'est l'absence de relevé. Il est
 * distingué de `absent_declared` parce que confondre les deux reviendrait à
 * accuser quelqu'un d'une absence alors que personne n'a rien saisi.
 */
export const DAY_STATES = [
  "not_recorded",
  "present",
  "late",
  "left",
  "incomplete",
  "absent_declared",
  "absent_justified",
  "absent_unjustified",
  "leave",
] as const
export type DayState = (typeof DAY_STATES)[number]

export interface ScheduleRule {
  /** Minutes depuis minuit, heure locale de la station. */
  startMinute: number
  endMinute: number
  /** Marge au-delà de laquelle l'arrivée est tenue pour tardive. */
  lateToleranceMinutes: number
  /** Pause prévue, à titre indicatif : elle ne se déduit jamais toute seule. */
  breakDurationMinutes: number
}

export interface LatenessResult {
  late: boolean
  /**
   * Minutes de retard, ou `null` quand la question ne se pose pas : sans
   * horaire applicable, il n'y a pas d'heure à laquelle être en retard.
   */
  lateMinutes: number | null
  /** `true` quand aucun horaire ne s'applique : on affiche l'heure, c'est tout. */
  unknown: boolean
}

/**
 * Retard d'une arrivée au regard de l'horaire applicable.
 *
 * Sans horaire configuré, le résultat est `unknown` : on n'invente pas une
 * heure de début universelle. Une station ouvre à 6 h, une autre à 9 h, et
 * décréter un horaire par défaut fabriquerait des retards imaginaires dès le
 * premier jour d'utilisation.
 */
export function evaluateLateness(checkInMinute: number | null, schedule: ScheduleRule | null): LatenessResult {
  if (checkInMinute === null || schedule === null) {
    return { late: false, lateMinutes: null, unknown: true }
  }
  const limite = schedule.startMinute + schedule.lateToleranceMinutes
  if (checkInMinute <= limite) return { late: false, lateMinutes: 0, unknown: false }
  // Le retard se compte depuis l'heure prévue, pas depuis la fin de la
  // tolérance : la tolérance dit quand on le signale, pas quand il commence.
  return { late: true, lateMinutes: checkInMinute - schedule.startMinute, unknown: false }
}

/**
 * Temps de travail réellement pointé, en minutes.
 *
 * Renvoie `null` dès qu'une borne manque. C'est le point le plus important de
 * ce fichier : un pointage incomplet doit remonter comme incomplet jusque
 * dans les rapports. S'il valait zéro, il abaisserait silencieusement la
 * moyenne de la personne, et le responsable lirait un rendement médiocre là
 * où il n'y a qu'un bouton qu'on a oublié de presser.
 *
 * La pause n'est retranchée que si elle a été **relevée**. Une pause prévue
 * par l'horaire mais non pointée ne se déduit pas : on ne retire pas du temps
 * de travail sur la foi d'un paramètre.
 */
export function workedMinutes(
  checkInMinute: number | null,
  checkOutMinute: number | null,
  recordedBreakMinutes: number | null,
): number | null {
  if (checkInMinute === null || checkOutMinute === null) return null
  const brut = checkOutMinute - checkInMinute
  if (brut < 0) return null
  const pause = recordedBreakMinutes ?? 0
  return Math.max(0, brut - pause)
}

/** Un départ ne peut pas précéder une arrivée. */
export function isCoherent(checkInMinute: number | null, checkOutMinute: number | null): boolean {
  if (checkInMinute === null || checkOutMinute === null) return true
  return checkOutMinute >= checkInMinute
}

/**
 * État du jour pour un laveur.
 *
 * L'ordre des tests n'est pas indifférent : l'absence de relevé est examinée
 * la première, pour qu'aucun chemin ne puisse conclure « absent » faute de
 * données.
 */
export function dayState(
  record: { status: AttendanceStatus; checkInMinute: number | null; checkOutMinute: number | null } | null,
  schedule: ScheduleRule | null,
): DayState {
  if (record === null) return "not_recorded"
  if (record.status !== "present") return record.status
  if (record.checkInMinute === null) return "incomplete"
  if (record.checkOutMinute !== null) return "left"
  return evaluateLateness(record.checkInMinute, schedule).late ? "late" : "present"
}

/**
 * Quote-part d'un lavage revenant à chaque participant, en millièmes.
 *
 * Un lavage fait à trois vaut un lavage pour la station. Si chacun des trois
 * en comptait un, la station afficherait trois fois sa production réelle et
 * le classement récompenserait le fait d'être nombreux.
 *
 * Les millièmes évitent les flottants, conformément à la règle du projet.
 * L'arrondi se fait une fois, ici : trois participants reçoivent 333 millièmes
 * chacun, soit 999 — un millième se perd. C'est assumé et sans conséquence,
 * **parce que le total de la station ne se calcule jamais en sommant les
 * quote-parts** : il se lit sur la table des lavages. La quote-part sert à
 * comparer des personnes entre elles, pas à produire un total.
 */
export function shareMilli(participantCount: number): number {
  if (participantCount <= 0) return 0
  return Math.round(1000 / participantCount)
}

export interface WorkerTally {
  /** Lavages auxquels la personne a participé, quel que soit son rôle. */
  participations: number
  /** Lavages où elle était désignée responsable principal. */
  asPrincipal: number
  /** Somme des quote-parts, en millièmes. */
  shareMilliTotal: number
}

/**
 * Agrège les affectations d'une personne.
 *
 * Les trois nombres disent trois choses différentes et ne doivent jamais être
 * confondus : à combien de lavages elle a pris part, combien elle a menés, et
 * quelle fraction du travail de la station lui revient.
 */
export function tally(
  assignments: readonly { washId: string; isPrincipal: boolean; participantCount: number }[],
): WorkerTally {
  // Un même lavage ne doit peser qu'une fois, même si la donnée remonte en
  // double à la suite d'une jointure maladroite.
  const vus = new Set<string>()
  let participations = 0
  let asPrincipal = 0
  let shareMilliTotal = 0
  for (const a of assignments) {
    if (vus.has(a.washId)) continue
    vus.add(a.washId)
    participations += 1
    if (a.isPrincipal) asPrincipal += 1
    shareMilliTotal += shareMilli(a.participantCount)
  }
  return { participations, asPrincipal, shareMilliTotal }
}

/**
 * Lavages par jour de présence.
 *
 * Renvoie `null` sans jour de présence : diviser par zéro n'a pas de sens, et
 * afficher « 0 » laisserait croire à une journée improductive là où il n'y a
 * eu aucune journée.
 */
export function perPresentDay(shareMilliTotal: number, presentDays: number): number | null {
  if (presentDays <= 0) return null
  return Math.round(shareMilliTotal / presentDays)
}

/**
 * Lavages par heure pointée.
 *
 * Même prudence : sans temps pointé, pas de rendement horaire. C'est le cas
 * le plus fréquent au démarrage, quand personne ne pointe encore — l'écran
 * doit dire « pas de pointage » et non « 0 lavage par heure ».
 */
export function perWorkedHour(shareMilliTotal: number, workedMinutesTotal: number | null): number | null {
  if (workedMinutesTotal === null || workedMinutesTotal <= 0) return null
  return Math.round((shareMilliTotal * 60) / workedMinutesTotal)
}

/** `08:30` → 510. Renvoie `null` si le format n'est pas reconnu. */
export function minuteOfDay(time: string | null | undefined): number | null {
  if (!time) return null
  const m = /^(\d{1,2}):(\d{2})/.exec(time)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** 510 → `08:30`. */
export function formatMinuteOfDay(minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

export interface ScheduleRow extends ScheduleRule {
  workerId: string | null
  siteId: string | null
  dayOfWeek: number | null
  /** `AAAA-MM-JJ`, pour une exception ponctuelle. */
  specificDate: string | null
  validFrom: string
  validTo: string | null
}

/**
 * Choisit l'horaire qui s'applique à une personne un jour donné.
 *
 * Du plus précis au plus général : l'exception du jour l'emporte sur
 * l'habitude de la semaine, et ce qui vise une personne l'emporte sur ce qui
 * vise la station. Sans rien de trouvé, on renvoie `null` — et le reste du
 * système sait alors qu'il ne faut parler ni de retard ni d'heure prévue.
 */
export function resolveSchedule(
  rows: readonly ScheduleRow[],
  workerId: string,
  siteId: string | null,
  isoDate: string,
  dayOfWeek: number,
): ScheduleRule | null {
  let meilleur: { score: number; row: ScheduleRow } | null = null
  for (const row of rows) {
    if (row.validFrom > isoDate) continue
    if (row.validTo !== null && row.validTo < isoDate) continue
    if (row.workerId !== null && row.workerId !== workerId) continue
    // Un horaire de station ne vaut que pour sa station. Celui dont le site
    // n'est pas renseigné vaut partout dans l'organisation.
    if (row.workerId === null && row.siteId !== null && row.siteId !== siteId) continue
    if (row.specificDate !== null && row.specificDate !== isoDate) continue
    if (row.specificDate === null && row.dayOfWeek !== null && row.dayOfWeek !== dayOfWeek) continue

    const score =
      (row.workerId !== null ? 100 : 0) + (row.specificDate !== null ? 10 : 0) + (row.dayOfWeek !== null ? 1 : 0)
    if (meilleur === null || score > meilleur.score) meilleur = { score, row }
  }
  if (meilleur === null) return null
  const { startMinute, endMinute, lateToleranceMinutes, breakDurationMinutes } = meilleur.row
  return { startMinute, endMinute, lateToleranceMinutes, breakDurationMinutes }
}
