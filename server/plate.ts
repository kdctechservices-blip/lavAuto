/**
 * Plaques d'immatriculation.
 *
 * Le produit ne tient pas de fichier client : pas de nom, pas de téléphone.
 * On note la plaque, et c'est elle qui permet de reconnaître un véhicule
 * lorsqu'il revient. C'est la décision prise le 21 octobre 2026.
 *
 * Une plaque est saisie à la main, vite, par quelqu'un qui encaisse. Elle
 * arrivera donc sous toutes les formes : « 1234 AB 01 », « 1234ab01 »,
 * « 1234-AB-01 ». Si on les rangeait telles quelles, le même véhicule
 * apparaîtrait trois fois et l'historique ne servirait à rien.
 *
 * D'où deux valeurs conservées côte à côte :
 *  - `key`, réduite aux seuls lettres et chiffres en majuscules, qui sert à
 *    regrouper et à rechercher ;
 *  - `display`, proche de ce qui a été tapé, qui sert à afficher.
 *
 * Aucune règle de format n'est imposée. Une plaque étrangère, un deux-roues,
 * un engin de chantier : tout doit pouvoir être encaissé. Refuser une saisie
 * bloquerait une vente, ce qui n'est jamais le bon arbitrage sur une caisse.
 */

/** Longueur maximale retenue pour la clé, au-delà c'est une erreur de frappe. */
export const MAX_PLATE_LENGTH = 16

/**
 * Forme servant au regroupement et à la recherche : lettres et chiffres
 * uniquement, en majuscules. Renvoie `null` quand il n'y a rien d'exploitable,
 * ce qui veut dire « lavage sans plaque » — un cas parfaitement normal.
 */
export function plateKey(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const key = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
  if (!key) return null
  return key.slice(0, MAX_PLATE_LENGTH)
}

/**
 * Forme affichée : ce qui a été tapé, mis en majuscules, espaces superflus
 * retirés. On ne réécrit pas la ponctuation du conducteur.
 */
export function plateDisplay(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const display = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase()
  if (!display) return null
  if (!plateKey(display)) return null
  return display.slice(0, MAX_PLATE_LENGTH * 2)
}
