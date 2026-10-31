/**
 * Catégories de prestations d'une station.
 *
 * Ces cinq catégories sont créées avec la station et servent à ranger les
 * prestations (colonne « Catégorie » de l'écran Prestations, filtres, rapports).
 * Les libellés vivent ici, et non dans le serveur, parce que **l'interface en
 * a besoin** : quand un gérant choisit un type de service du catalogue, elle
 * doit trouver la catégorie de station correspondante avant même d'envoyer le
 * formulaire. Une table recopiée des deux côtés finit toujours par diverger.
 *
 * Module pur : testable sans base de données.
 */

/** Les catégories créées avec la station, dans l'ordre d'usage. */
export const DEFAULT_SERVICE_CATEGORY_NAMES = [
  "Lavage extérieur",
  "Lavage intérieur",
  "Lavage complet",
  "Detailing & soins",
  "Autres prestations",
] as const

/** La catégorie de repli : aucune prestation ne reste sans classement. */
export const FALLBACK_SERVICE_CATEGORY = "Autres prestations"

/**
 * Classement des types du catalogue (`service_catalog.category`) vers les
 * catégories de la station. Une clé absente tombe dans « Autres prestations » :
 * un type ajouté plus tard n'est jamais laissé sans catégorie.
 */
export const SERVICE_CATALOG_CATEGORY_LABELS: Record<string, string> = {
  exterior_wash: "Lavage extérieur",
  interior_cleaning: "Lavage intérieur",
  complete_wash: "Lavage complet",
  detailing: "Detailing & soins",
  autre: FALLBACK_SERVICE_CATEGORY,
}

/** Catégorie de station à donner à une prestation d'après son type de service. */
export function serviceCategoryName(templateCategory: string | null | undefined): string {
  if (!templateCategory) return FALLBACK_SERVICE_CATEGORY
  return SERVICE_CATALOG_CATEGORY_LABELS[templateCategory] ?? FALLBACK_SERVICE_CATEGORY
}

/**
 * Catégorie de station correspondant à un type du catalogue, par son nom.
 *
 * Utilisé par le formulaire « Nouvelle prestation » pour pré-sélectionner la
 * catégorie quand le gérant choisit « Lavage moteur complet » : il n'a pas à
 * retrouver lui-même dans quelle case ce type se range.
 */
export function matchingServiceCategory<
  T extends { id: string; name: string },
>(templateCategory: string | null | undefined, categories: readonly T[]): T | null {
  const wanted = serviceCategoryName(templateCategory).toLocaleLowerCase("fr-CI")
  return categories.find((category) => category.name.toLocaleLowerCase("fr-CI") === wanted) ?? null
}
