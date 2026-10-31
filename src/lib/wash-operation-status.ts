/**
 * Avancement operationnel d'un lavage.
 *
 * Trois etats, dans cet ordre : la voiture attend, le laveur est en train,
 * la voiture est prete. Le geste est un clic sur la pastille : l'operation
 * avance d'un cran.
 *
 * Distinct du statut **comptable** du lavage : un lavage enregistre est deja
 * encaisse et deja compte dans les rapports. L'avancement dit ou en est la
 * voiture, pas ce qui a ete facture.
 *
 * Ce module ne contient que la donnee et les regles : il est testeable
 * sans rendu, comme les autres modules de `src/lib/`.
 */

/** Les quatre etats, dans l'ordre du parcours de la voiture. */
export const OPERATION_STATUSES = ["pending", "in_progress", "overtime", "completed"] as const

export type OperationStatus = (typeof OPERATION_STATUSES)[number]

/** L'etat suivant quand on fait un cran. */
export function nextOperationStatus(status: string): OperationStatus | null {
  if (status === "pending") return "in_progress"
  if (status === "in_progress") return "overtime"
  if (status === "overtime") return "completed"
  return null
}

/** L'etat connu le plus proche : une valeur inattendue vaut « termine ». */
export function normaliseOperationStatus(status: string | null | undefined): OperationStatus {
  return (OPERATION_STATUSES as readonly string[]).includes(status ?? "")
    ? (status as OperationStatus)
    : "completed"
}

export const OPERATION_STATUS_LABELS: Record<OperationStatus, string> = {
  pending: "En attente",
  in_progress: "En cours",
  overtime: "Temps dépassé",
  completed: "Terminé",
}

/** Ce que dit le clic sur la pastille, pour l'utilisateur qui le lit. */
export const OPERATION_STATUS_ACTIONS: Record<Exclude<OperationStatus, "completed">, string> = {
  pending: "Marquer ce lavage comme démarré",
  in_progress: "Marquer ce lavage comme terminé",
  overtime: "Marquer ce lavage comme terminé",
}
