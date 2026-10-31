/**
 * Réglages par défaut d'une station qui vient d'être créée.
 *
 * Une station sans catégorie de véhicule ne peut enregistrer **aucun** lavage :
 * `vehicle_category_id` est obligatoire à la création, et l'écran de caisse
 * désactive le sélecteur quand la liste est vide. Une configuration terminée
 * mais incapable d'encaisser la première recette est un bug de parcours, pas
 * un manque de personnalisation — d'où ces valeurs par défaut, posées à la
 * confirmation de l'assistant et supprimables ensuite depuis l'écran dédié.
 *
 * Module pur : testable sans base de données.
 */

import { vehicleType, type FlatVehicleType } from "../src/config/vehicle-taxonomy.ts"

/**
 * Types de véhicules créés avec la station.
 *
 * Exactement **un représentant par famille**, soit neuf lignes, plutôt que les
 * soixante et un types du référentiel : à l'ouverture, un gérant doit pouvoir
 * encaisser en trente secondes, pas trier une liste de 61 lignes. Or chaque
 * famille porte un tarif : si une famille manque, ses véhicules n'ont aucune
 * case et le supplément de prix prévu pour eux ne s'applique jamais. Les
 * autres types s'ajoutent en deux clics depuis l'écran « Catégories de
 * véhicules », famille par famille.
 *
 * L'ordre suit celui du référentiel, du plus fréquent au plus rare : « Moto »,
 * « Citadine » et « Berline moyenne » couvrent l'immense majorité du parc
 * ivoirien ; les suivants ouvrent une porte à l'utilitaire, au minibus, au
 * camion, à l'engin de chantier et à l'électrique.
 */
export const DEFAULT_VEHICLE_CATEGORY_CODES = [
  "moto",
  "citadine",
  "berline_moyenne",
  "suv_familial",
  "fourgonnette",
  "minibus",
  "camion_porteur",
  "engin_chantier",
  "voiture_electrique",
] as const

/** Ce qu'il faut écrire en base pour une catégorie par défaut. */
export interface DefaultVehicleCategory {
  name: string
  family: string
  sort_order: number
}

function toDefault(type: FlatVehicleType | null): DefaultVehicleCategory {
  if (!type) throw new Error("type de véhicule par défaut inconnu")
  return { name: type.name, family: type.family, sort_order: type.sort_order }
}

/**
 * Catégories de véhicules créées avec la station, dans l'ordre du référentiel.
 *
 * Les noms sont résolus depuis `vehicle-taxonomy.ts` : impossible d'avoir un
 * défaut qui ne figure pas dans la liste proposée à l'écran.
 */
export const DEFAULT_VEHICLE_CATEGORIES: readonly DefaultVehicleCategory[] =
  DEFAULT_VEHICLE_CATEGORY_CODES.map((code) => toDefault(vehicleType(code)))

/** Noms seuls — pratique pour les tests et les messages. */
export const DEFAULT_VEHICLE_CATEGORY_NAMES: readonly string[] =
  DEFAULT_VEHICLE_CATEGORIES.map((category) => category.name)

/** Vérifie qu'un défaut est bien rangé dans sa famille et à son rang. */
export function isConsistentDefault(category: DefaultVehicleCategory): boolean {
  const type = vehicleType(category.name)
  if (!type) return false
  return type.family === category.family && type.sort_order === category.sort_order
}

/**
 * Vrai quand la station doit recevoir les catégories par défaut.
 *
 * Seul le cas « aucune catégorie » déclenche l'initialisation : une station qui
 * a délibérément vidé sa liste ne doit pas la voir réapparaître à chaque
 * nouvelle tentative de confirmation.
 */
export function needsDefaultVehicleCategories(existingCount: number): boolean {
  return existingCount <= 0
}

// ---------------------------------------------------------------------------
// Catégories de prestations
//
// L'assistant créait la station, les prestations, l'équipe et l'abonnement —
// mais **aucune catégorie de prestation**. À la sortie, la page « Catégories
// de prestations » était vide et toutes les prestations s'affichaient « — »
// dans la colonne Catégorie. Le référentiel `service_catalog` connaissait
// pourtant déjà le classement de chacun de ses modèles : l'information
// existait, elle était simplement jetée à la confirmation.
// ---------------------------------------------------------------------------

// Les libellés et le classement vivent dans `src/config/service-categories.ts` :
// l'interface en a besoin pour pré-sélectionner la catégorie d'un type de
// service choisi. Ils sont réexportés ici pour que le serveur et les tests
// continuent de les importer depuis un seul module.
export {
  DEFAULT_SERVICE_CATEGORY_NAMES,
  SERVICE_CATALOG_CATEGORY_LABELS,
  serviceCategoryName,
} from "../src/config/service-categories.ts"

// ---------------------------------------------------------------------------
// Catalogue des prestations
//
// La liste des prestations qu'une station de lavage propose réellement, dans
// l'ordre où elle les présente à ses clients. Elle vit ici et non dans un
// `INSERT` du schéma : c'est la même liste qui alimente l'assistant
// d'ouverture, la station de démonstration et les tests, et une liste recopiée
// en trois endroits finit toujours par diverger.
//
// Prix en centimes de franc CFA (`price_cents / 100` = francs), durées en
// minutes. Ces valeurs sont indicatives : la station les ajuste ensuite depuis
// l'écran « Prestations ».
// ---------------------------------------------------------------------------

/** Une prestation du catalogue général, prête à devenir une prestation de station. */
export interface ServiceCatalogTemplate {
  /** Nom affiché, tel que le client le lit sur le reçu. */
  name: string
  /** Clé de classement (`exterior_wash`, `detailing`…) → catégorie de station. */
  category: string
  /** Prix indicatif en centimes. */
  price_cents: number
  /** Durée indicative en minutes — c'est elle qui donne l'heure de fin estimée. */
  duration_minutes: number
  /** Une phrase pour la fiche de la prestation. */
  description: string
}

/**
 * Les onze prestations d'une station de lavage, dans l'ordre d'affichage.
 *
 * L'ordre n'est pas alphabétique : il suit le parcours du client, du plus
 * courant (extérieur, intérieur, complet) au plus spécialisé (moteur, lustrage,
 * moquettes de maison). Les trois premières sont celles qu'un gérant choisit
 * neuf fois sur dix à l'ouverture.
 */
export const SERVICE_CATALOG_TEMPLATES: readonly ServiceCatalogTemplate[] = [
  {
    name: "Lavage extérieur",
    category: "exterior_wash",
    price_cents: 200000,
    duration_minutes: 20,
    description: "Carrosserie, vitres et séchage à la microfibre.",
  },
  {
    name: "Lavage intérieur simple",
    category: "interior_cleaning",
    price_cents: 150000,
    duration_minutes: 20,
    description: "Aspiration, tableau de bord et plastiques.",
  },
  {
    name: "Lavage complet (intérieur + extérieur)",
    category: "complete_wash",
    price_cents: 350000,
    duration_minutes: 45,
    description: "Intérieur et extérieur, finition à la main.",
  },
  {
    name: "Lavage express",
    category: "exterior_wash",
    price_cents: 150000,
    duration_minutes: 15,
    description: "Lavage extérieur rapide, sans attente.",
  },
  {
    name: "Nettoyage des tapis et sièges uniquement",
    category: "interior_cleaning",
    price_cents: 250000,
    duration_minutes: 30,
    description: "Shampoing des sièges et des tapis du véhicule.",
  },
  {
    name: "Lavage des moquettes (maison)",
    category: "autre",
    price_cents: 300000,
    duration_minutes: 45,
    description: "Moquettes et tapis de maison déposés à la station.",
  },
  {
    name: "Nettoyage des jantes et pneus",
    category: "exterior_wash",
    price_cents: 100000,
    duration_minutes: 15,
    description: "Dégraissage des jantes et brillance des pneus.",
  },
  {
    name: "Lavage du bas de caisse",
    category: "exterior_wash",
    price_cents: 150000,
    duration_minutes: 20,
    description: "Berceaux et passages de roues, haute pression.",
  },
  {
    name: "Lavage moteur complet",
    category: "exterior_wash",
    price_cents: 300000,
    duration_minutes: 45,
    description: "Dégraissage du compartiment moteur, rinçage maîtrisé.",
  },
  {
    name: "Lustrage de la carrosserie",
    category: "detailing",
    price_cents: 500000,
    duration_minutes: 60,
    description: "Polish puis cire, brillance durable.",
  },
  {
    name: "Lavage de motos",
    category: "exterior_wash",
    price_cents: 100000,
    duration_minutes: 15,
    description: "Moto ou scooter, jantes et chaîne dégraissées.",
  },
]

/** Noms seuls du catalogue, dans l'ordre — pratique pour les tests. */
export const SERVICE_CATALOG_NAMES: readonly string[] = SERVICE_CATALOG_TEMPLATES.map(
  (template) => template.name,
)
