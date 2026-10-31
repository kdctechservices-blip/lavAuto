/**
 * Règles de calcul du stock.
 *
 * Module **pur** : ni Express, ni base de données. C'est ici que vivent les
 * quelques décisions arithmétiques du domaine, pour qu'elles soient
 * vérifiables en millisecondes plutôt qu'à travers une requête SQL.
 *
 * Deux conventions traversent tout le module :
 *
 * - **Les quantités sont en millièmes d'unité.** Un litre vaut 1000, un
 *   flacon vaut 1000, 250 mL valent 250. Même raison que les centimes pour
 *   l'argent : un entier exact plutôt qu'un flottant qui dérive. Un lavage
 *   qui consomme 0,15 L de shampooing se note 150, sans arrondi.
 *
 * - **Le stock n'est jamais stocké, il est toujours recalculé** comme la
 *   somme signée des mouvements. Il n'existe donc pas de fonction qui
 *   « écrit » un stock : seulement des fonctions qui décrivent un mouvement.
 */

/** Nombre de millièmes dans une unité. */
export const MILLI = 1000

export const MOVEMENT_KINDS = ["initial", "entry", "exit", "inventory", "reversal"] as const
export type MovementKind = (typeof MOVEMENT_KINDS)[number]

/** Genres qu'un utilisateur peut demander directement. */
export const USER_MOVEMENT_KINDS = ["entry", "exit"] as const
export type UserMovementKind = (typeof USER_MOVEMENT_KINDS)[number]

export const MOVEMENT_LABELS: Record<MovementKind, string> = {
  initial: "Stock initial",
  entry: "Entrée",
  exit: "Sortie",
  inventory: "Écart d'inventaire",
  reversal: "Contrepassation",
}

export const UNITS = ["unite", "sachet", "litre", "kilogramme"] as const
export type Unit = (typeof UNITS)[number]

export const UNIT_LABELS: Record<Unit, string> = {
  unite: "unité",
  // Les stations ivoiriennes achètent la lessive en sachets : c'est l'unité
  // de comptage réelle, celle que le gérant a sous les yeux dans sa réserve.
  sachet: "sachet",
  litre: "litre",
  kilogramme: "kilogramme",
}

/**
 * Convertit une quantité saisie par l'utilisateur en valeur signée à écrire.
 *
 * L'interface demande toujours une quantité **positive** (« combien
 * sort ? »), et c'est le genre du mouvement qui décide du sens. Laisser
 * l'utilisateur saisir un nombre négatif inviterait la double négation :
 * une sortie de −5 qui ajoute du stock.
 */
export function signedQuantity(kind: UserMovementKind, quantityMilli: number): number {
  return kind === "exit" ? -Math.abs(quantityMilli) : Math.abs(quantityMilli)
}

/**
 * Le produit est-il sous son seuil d'alerte ?
 *
 * Un seuil à zéro signifie « pas d'alerte pour ce produit » — c'est le défaut,
 * et c'est volontaire : avertir sur tout revient à n'avertir sur rien.
 */
export function isLowStock(stockMilli: number, thresholdMilli: number): boolean {
  if (thresholdMilli <= 0) return false
  return stockMilli <= thresholdMilli
}

/**
 * Écart entre un comptage physique et le stock théorique.
 *
 * C'est le cœur de l'inventaire : on ne « fixe » pas un stock, on enregistre
 * la **différence constatée**. Le mouvement conserve ainsi la mémoire de
 * l'erreur, au lieu de l'effacer.
 *
 * Renvoie `0` quand le comptage confirme le théorique — il n'y a alors rien à
 * écrire, et l'appelant doit s'abstenir plutôt que de créer un mouvement nul.
 */
export function inventoryDelta(countedMilli: number, currentMilli: number): number {
  return countedMilli - currentMilli
}

/**
 * Valeur d'un stock, en centimes, à un coût unitaire donné.
 *
 * Arrondi au centime le plus proche. Le coût est exprimé **par unité
 * entière**, les quantités en millièmes : d'où la division par 1000.
 */
export function stockValueCents(stockMilli: number, unitCostCents: number): number {
  return Math.round((stockMilli * unitCostCents) / MILLI)
}

/**
 * Une sortie est-elle réalisable sans rendre le stock négatif ?
 *
 * Un stock négatif n'est pas une information, c'est un aveu d'erreur de
 * saisie. On refuse la sortie et on oriente vers l'inventaire, qui est la
 * façon prévue de reconnaître un écart.
 */
export function canApply(stockMilli: number, signedQuantityMilli: number): boolean {
  return stockMilli + signedQuantityMilli >= 0
}

/** Quantité en millièmes vers un affichage lisible (« 1,5 litre »). */
export function formatQuantity(quantityMilli: number, unit: string): string {
  const value = quantityMilli / MILLI
  const texte = Number.isInteger(value)
    ? String(value)
    : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")
  const label = UNIT_LABELS[unit as Unit] ?? unit
  const pluriel = Math.abs(value) >= 2 ? "s" : ""
  return `${texte.replace(".", ",")} ${label}${pluriel}`
}
