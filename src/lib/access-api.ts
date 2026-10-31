/** Capacité d'accès de l'organisation, sans exposer les comptes eux-mêmes. */
export interface AccessCapacity {
  max_users: number | null
  active_users: number
  remaining_users: number | null
  can_create: boolean
}

export function accessCapacityReason(capacity: AccessCapacity | null | undefined): string | null {
  if (!capacity || capacity.can_create) return null
  if (capacity.max_users === null) return "La création de comptes est actuellement indisponible."
  return `Votre forfait est limité à ${capacity.max_users} compte${capacity.max_users === 1 ? "" : "s"} actif${capacity.max_users === 1 ? "" : "s"} (${capacity.active_users} déjà utilisé${capacity.active_users === 1 ? "" : "s"}). Désactivez un accès ou changez de forfait.`
}
