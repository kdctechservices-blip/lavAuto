/**
 * Le decompte du temps de lavage.
 *
 * Quand le laveur commence une tache, l'ecran compte le temps qui s'ecoule
 * et le compare a la duree estimee de la prestation. Trois etats, une seule
 * question : combien de temps reste-t-il ?
 *
 * Ce module ne contient que le calcul, sans etat ni horloge : il est donc
 * verifiable caractere par caractere, comme les autres modules de
 * `src/lib/`.
 */

/** Duree estimee, en minutes, vue par l'ecran. */
export function estimatedSeconds(minutes: number | null | undefined): number {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return 0
  return Math.round(minutes * 60)
}

/**
 * L'avancement, en pourcentage, borne entre 0 et 100.
 *
 * La borne haute n'est pas un detail : au-dela de 100 %, la barre deborderait
 * de son cadre et le temps restant deviendrait negatif — un compte a rebours
 * qui compte en arriere est un compte a rebours casse.
 */
export function countdownProgress(elapsedSeconds: number, totalSeconds: number): number {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return 0
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 0
  const pourcentage = (elapsedSeconds / totalSeconds) * 100
  if (pourcentage >= 100) return 100
  return Math.floor(pourcentage)
}

/** Le temps restant, en secondes. Zéro une fois le temps écoulé. */
export function remainingSeconds(elapsedSeconds: number, totalSeconds: number): number {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 0
  const restant = totalSeconds - (Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0)
  return restant > 0 ? Math.round(restant) : 0
}

/**
 * Une duree en clair : « 45 min », « 1 h 15 », « 2 h », « 42 s ».
 *
 * Le franc CFA n'a pas de subdivision, mais le temps, si. On dit donc
 * « 1 h 15 » et non « 1,25 h » : personne ne calcule pendant un lavage.
 *
 * Sous la minute, on compte les secondes : « 0 min » pendant la derniere
 * minute d'un lavage serait une information fausse.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 min"
  const total = Math.round(seconds)
  if (total < 60) return `${total} s`
  const heures = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (heures === 0) return `${minutes} min`
  if (minutes === 0) return `${heures} h`
  return `${heures} h ${String(minutes).padStart(2, "0")}`
}

/**
 * L'etat du decompte, vu par l'ecran.
 *
 * Trois moments : la tache n'a pas commence, elle court, ou elle est finie.
 * Le premier se reconnait a l'absence de depart : une tache que personne
 * n'a encore commence n'a pas de temps ecoule.
 */
export type CountdownState = "not_started" | "running" | "finished"

export function countdownState(
  startedAt: string | null | undefined,
  elapsedSeconds: number,
  totalSeconds: number,
): CountdownState {
  if (!startedAt) return "not_started"
  if (countdownProgress(elapsedSeconds, totalSeconds) >= 100) return "finished"
  return "running"
}
