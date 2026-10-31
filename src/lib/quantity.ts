/**
 * Conversion entre les quantités saisies par l'utilisateur et les millièmes
 * stockés en base.
 *
 * Le serveur raisonne en millièmes d'unité (1 litre = 1000), pour la même
 * raison qu'il raisonne en centimes : un entier exact plutôt qu'un flottant
 * qui dérive. L'utilisateur, lui, écrit « 1,5 » et attend un litre et demi.
 * Tout le travail de traduction est ici, isolé et testable.
 *
 * Ce module est volontairement **pur** : il ne dépend ni de React ni du
 * réseau. Il double `server/stock-rules.ts` côté interface parce que
 * `tsconfig.app.json` ne compile que `src/` — la même séparation que celle
 * qui existe déjà entre `src/lib/permissions.tsx` et `server/permissions.ts`.
 */

/** Nombre de millièmes dans une unité. */
export const MILLI = 1000

export const UNIT_LABELS: Record<string, string> = {
  unite: "unité",
  sachet: "sachet",
  litre: "litre",
  kilogramme: "kilogramme",
}

/** Options proposées dans les formulaires. */
export const UNIT_OPTIONS = [
  { value: "sachet", label: "Sachet" },
  { value: "unite", label: "Unité" },
  { value: "litre", label: "Litre" },
  { value: "kilogramme", label: "Kilogramme" },
] as const

/**
 * Lit une quantité saisie au clavier et la convertit en millièmes.
 *
 * Accepte la virgule comme la plupart des claviers francophones, et tolère
 * les espaces. Renvoie `null` quand la saisie n'est pas un nombre
 * exploitable — l'appelant décide alors du message, plutôt que de recevoir
 * un `NaN` qui se propagerait silencieusement jusqu'à la base.
 *
 * Au-delà de trois décimales la valeur est arrondie au millième : c'est la
 * granularité du stockage, et refuser la saisie serait plus déroutant
 * qu'arrondir.
 */
export function parseQuantity(input: string): number | null {
  const nettoye = input.trim().replace(/\s/g, "").replace(",", ".")
  if (nettoye === "") return null
  if (!/^-?\d*\.?\d*$/.test(nettoye)) return null
  const valeur = Number(nettoye)
  if (!Number.isFinite(valeur)) return null
  return Math.round(valeur * MILLI)
}

/**
 * Convertit des millièmes en texte éditable dans un champ de saisie.
 *
 * Utilise le point décimal, parce que c'est ce qu'attend un `<input
 * type="number">`. L'affichage en lecture, lui, passe par `formatQuantity`.
 */
export function quantityToInput(quantityMilli: number): string {
  const valeur = quantityMilli / MILLI
  return Number.isInteger(valeur) ? String(valeur) : String(Number(valeur.toFixed(3)))
}

/** Quantité en millièmes vers un affichage lisible (« 1,5 litre »). */
export function formatQuantity(quantityMilli: number, unit: string): string {
  const valeur = quantityMilli / MILLI
  const texte = Number.isInteger(valeur)
    ? String(valeur)
    : valeur.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")
  const label = UNIT_LABELS[unit] ?? unit
  const pluriel = Math.abs(valeur) >= 2 ? "s" : ""
  return `${texte.replace(".", ",")} ${label}${pluriel}`
}

/** Valeur d'un stock en centimes, au coût unitaire donné. */
export function stockValueCents(quantityMilli: number, unitCostCents: number): number {
  return Math.round((quantityMilli * unitCostCents) / MILLI)
}
