/**
 * Comment nommer une tache quand on en parle.
 *
 * Le nom du client d'abord, parce que c'est lui qu'on appelle. Sinon la
 * plaque, qui est ce qu'on lit a travers la vitre. En dernier recours, la
 * reference : c'est moins parlant, mais c'est toujours quelque chose.
 */
export function taskLabel(
  wash:
    | { customer_name?: string | null; plate?: string | null; reference?: string | null }
    | null
    | undefined,
): string {
  if (!wash) return "Ce lavage"
  return wash.customer_name?.trim() || wash.plate?.trim() || wash.reference?.trim() || "Ce lavage"
}

/**
 * Les taches que l'ecran de la station affiche.
 *
 * Une tache, c'est un lavage qui attend ou qui court. L'ecran en montre un
 * nombre limite : au-dela, les cartes se resserrent et personne ne les lit.
 *
 * Ce module ne contient que le tri et la coupe : il est donc verifiable
 * sans rendu, comme les autres modules de `src/lib/`.
 */

export interface WashTaskSummary {
  id: string
  /** L'instant de depart du decompte, s'il y en a un. */
  operation_started_at: string | null
  /** `pending`, `in_progress` ou `completed`. */
  operation_status: string
  /** La date de creation du lavage. */
  created_at: string
}

/**
 * Combien de taches tiennent a l'ecran, a la fois.
 *
 * Cinq. C'est une limite de lisibilite, pas de capacite : les taches en
 * trop ne disparaissent pas pour autant, l'ecran dit combien il y en a.
 */
export const MAX_VISIBLE_TASKS = 5

/**
 * Les taches a afficher, et le nombre de celles qui restent derriere.
 *
 * Les taches qui courent passent devant : c'est elles que l'on regarde, et
 * ce sont les plus proches de finir. Vient ensuite ce qui n'a pas encore
 * commence, dans l'ordre d'arrivee.
 *
 * A rang egal, l'ordre de creation tranche : la liste ne doit pas se
 * rearranger sous les yeux de l'utilisateur a chaque rafraichissement.
 */
export function selectVisibleTasks<T extends WashTaskSummary>(tasks: T[]): {
  visibles: T[]
  masquees: number
} {
  const triees = [...tasks].sort((a, b) => {
    const aEnCours = a.operation_status === "in_progress" ? 0 : 1
    const bEnCours = b.operation_status === "in_progress" ? 0 : 1
    if (aEnCours !== bEnCours) return aEnCours - bEnCours

    const aDepart = a.operation_started_at ? Date.parse(a.operation_started_at) : 0
    const bDepart = b.operation_started_at ? Date.parse(b.operation_started_at) : 0
    if (aDepart !== bDepart) return aDepart - bDepart

    const aCreation = Date.parse(a.created_at) || 0
    const bCreation = Date.parse(b.created_at) || 0
    return aCreation - bCreation
  })
  return {
    visibles: triees.slice(0, MAX_VISIBLE_TASKS),
    masquees: Math.max(0, triees.length - MAX_VISIBLE_TASKS),
  }
}
