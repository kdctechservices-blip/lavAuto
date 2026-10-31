/**
 * Taxonomie des véhicules — source unique, partagée par l'interface et le serveur.
 *
 * Le catalogue de départ ne proposait que trois entrées (« Berline »,
 * « SUV / 4x4 », « Moto »). C'est trop peu pour une station ivoirienne, où
 * l'on lave aussi bien un scooter qu'un bus articulé ou une pelle mécanique —
 * et trop peu pour facturer juste, puisque le prix dépend d'abord du gabarit.
 *
 * La liste ci-dessous est celle du terrain, rangée en **neuf familles**. Elle
 * sert à trois choses, et c'est ce qui justifie qu'elle vive dans un seul
 * fichier :
 *
 *   1. proposer les types à ajouter depuis l'écran « Catégories de véhicules »
 *      (personne ne saisit 61 noms à la main) ;
 *   2. valider ce que l'API accepte — une famille inconnue est refusée ;
 *   3. **tarifer par famille** : une prestation peut coûter plus cher sur un
 *      SUV que sur une citadine sans qu'il faille saisir 61 prix.
 *
 * Règle de nommage : le `code` est stable et sans accent (il sert de clé de
 * tarif et de valeur en base), le `name` est ce que lit le caissier. Renommer
 * un libellé ne casse donc aucun prix ; changer un `code` en casserait.
 *
 * Module pur : aucun accès base, aucune dépendance. Il est importé par
 * `src/` (interface) et par `server/` (validation, tarification).
 */

export interface VehicleType {
  /** Clé stable, sans accent ni espace. Sert de clé de tarif. */
  code: string
  /** Libellé affiché. */
  name: string
}

export interface VehicleFamily {
  /** Clé stable de la famille, utilisée comme clé de tarif. */
  code: string
  /** Libellé affiché, tel qu'un gérant le dirait. */
  label: string
  /** Phrase courte : à quoi sert cette famille dans une station. */
  description: string
  types: readonly VehicleType[]
}

/**
 * Les neuf familles, dans l'ordre où un gérant les parcourt : du plus fréquent
 * en station (deux-roues, petites voitures) au plus rare (poids lourds,
 * engins). L'ordre est aussi celui des regroupements à l'écran.
 */
export const VEHICLE_FAMILIES: readonly VehicleFamily[] = [
  {
    code: "deux_roues",
    label: "Motos et deux-roues",
    description: "Le gros du passage dans beaucoup de stations de quartier.",
    types: [
      { code: "moto", name: "Moto" },
      { code: "scooter", name: "Scooter" },
      { code: "cyclomoteur", name: "Cyclomoteur" },
      { code: "moto_taxi", name: "Moto-taxi" },
      { code: "tricycle_motorise", name: "Tricycle motorisé" },
      { code: "quad", name: "Quad" },
    ],
  },
  {
    code: "petites_voitures",
    label: "Petites voitures",
    description: "Citadines et compactes : lavage rapide, tarif d'entrée.",
    types: [
      { code: "citadine", name: "Citadine" },
      { code: "mini_citadine", name: "Mini-citadine" },
      { code: "petite_berline", name: "Petite berline" },
      { code: "compacte", name: "Compacte" },
      { code: "coupe", name: "Coupé" },
      { code: "cabriolet", name: "Cabriolet" },
    ],
  },
  {
    code: "berlines",
    label: "Berlines et voitures familiales",
    description: "Le cœur du parc : berlines, breaks et monospaces.",
    types: [
      { code: "berline_compacte", name: "Berline compacte" },
      { code: "berline_moyenne", name: "Berline moyenne" },
      { code: "berline_grande_taille", name: "Berline grande taille" },
      { code: "break", name: "Break" },
      { code: "monospace_compact", name: "Monospace compact" },
      { code: "monospace_familial", name: "Monospace familial" },
    ],
  },
  {
    code: "suv",
    label: "SUV et véhicules tout-terrain",
    description: "Gabarit haut et surfaces plus grandes : plus de temps, plus de produit.",
    types: [
      { code: "crossover", name: "Crossover" },
      { code: "suv_compact", name: "SUV compact" },
      { code: "suv_familial", name: "SUV familial" },
      { code: "grand_suv", name: "Grand SUV" },
      { code: "quatre_quatre", name: "4x4" },
      { code: "pick_up_double_cabine", name: "Pick-up double cabine" },
      { code: "tout_terrain", name: "Véhicule tout-terrain" },
    ],
  },
  {
    code: "utilitaires",
    label: "Utilitaires légers",
    description: "Fourgons et pick-up de travail, souvent très sales.",
    types: [
      { code: "fourgonnette", name: "Fourgonnette" },
      { code: "fourgon", name: "Fourgon" },
      { code: "petit_utilitaire", name: "Petit utilitaire" },
      { code: "grand_utilitaire", name: "Grand utilitaire" },
      { code: "pick_up_simple_cabine", name: "Pick-up simple cabine" },
      { code: "pick_up_cabine_approfondie", name: "Pick-up cabine approfondie" },
    ],
  },
  {
    code: "transport_personnes",
    label: "Transport de personnes",
    description: "Taxis, minibus et bus : contrats réguliers possibles.",
    types: [
      { code: "taxi", name: "Taxi" },
      { code: "vtc", name: "VTC" },
      { code: "taxi_collectif", name: "Taxi collectif" },
      { code: "minibus", name: "Minibus" },
      { code: "car", name: "Car" },
      { code: "autocar", name: "Autocar" },
      { code: "bus_urbain", name: "Bus urbain" },
      { code: "bus_articule", name: "Bus articulé" },
    ],
  },
  {
    code: "poids_lourds",
    label: "Poids lourds et camions",
    description: "Interventions longues, souvent hors forfait habituel.",
    types: [
      { code: "camion_leger", name: "Camion léger" },
      { code: "camion_porteur", name: "Camion porteur" },
      { code: "camion_benne", name: "Camion-benne" },
      { code: "camion_citerne", name: "Camion-citerne" },
      { code: "camion_frigorifique", name: "Camion frigorifique" },
      { code: "tracteur_routier", name: "Tracteur routier" },
      { code: "semi_remorque", name: "Semi-remorque" },
      { code: "remorque", name: "Remorque" },
    ],
  },
  {
    code: "speciaux",
    label: "Véhicules professionnels et spéciaux",
    description: "Engins de chantier, agricoles et véhicules d'intervention.",
    types: [
      { code: "tracteur_agricole", name: "Tracteur agricole" },
      { code: "engin_chantier", name: "Engin de chantier" },
      { code: "pelle_mecanique", name: "Pelle mécanique" },
      { code: "chargeuse", name: "Chargeuse" },
      { code: "chariot_elevateur", name: "Chariot élévateur" },
      { code: "ambulance", name: "Ambulance" },
      { code: "vehicule_secours", name: "Véhicule de secours" },
      { code: "vehicule_blinde", name: "Véhicule blindé" },
    ],
  },
  {
    code: "electriques",
    label: "Véhicules électriques et hybrides",
    description: "Précautions propres : pas de jet haute pression sur la batterie.",
    types: [
      { code: "voiture_electrique", name: "Voiture électrique" },
      { code: "suv_electrique", name: "SUV électrique" },
      { code: "berline_hybride", name: "Berline hybride" },
      { code: "utilitaire_electrique", name: "Utilitaire électrique" },
      { code: "moto_electrique", name: "Moto électrique" },
      { code: "scooter_electrique", name: "Scooter électrique" },
    ],
  },
]

/** Codes des familles, dans l'ordre d'affichage. */
export const VEHICLE_FAMILY_CODES: readonly string[] = VEHICLE_FAMILIES.map((f) => f.code)

const FAMILY_BY_CODE = new Map(VEHICLE_FAMILIES.map((family) => [family.code, family]))

/** Tous les types, à plat, avec leur famille. */
export interface FlatVehicleType extends VehicleType {
  family: string
  family_label: string
  /** Rang du type dans sa famille : sert de `sort_order` en base. */
  sort_order: number
}

export const VEHICLE_TYPES: readonly FlatVehicleType[] = VEHICLE_FAMILIES.flatMap((family) =>
  family.types.map((type, index) => ({
    ...type,
    family: family.code,
    family_label: family.label,
    sort_order: index,
  })),
)

const TYPE_BY_CODE = new Map(VEHICLE_TYPES.map((type) => [type.code, type]))

export function vehicleFamily(code: string | null | undefined): VehicleFamily | null {
  if (!code) return null
  return FAMILY_BY_CODE.get(code) ?? null
}

/** Vrai si le code est une famille connue. */
export function isVehicleFamily(code: string | null | undefined): boolean {
  return Boolean(code && FAMILY_BY_CODE.has(code))
}

/**
 * Retrouve un type par son code, ou par son libellé exact.
 *
 * Le libellé est accepté pour que l'import depuis un fichier ou une ancienne
 * sauvegarde fonctionne sans conversion préalable — « Berline moyenne » et
 * `berline_moyenne` désignent la même chose.
 */
export function vehicleType(codeOrName: string | null | undefined): FlatVehicleType | null {
  if (!codeOrName) return null
  const direct = TYPE_BY_CODE.get(codeOrName)
  if (direct) return direct
  const lower = codeOrName.trim().toLowerCase()
  return VEHICLE_TYPES.find((type) => type.name.toLowerCase() === lower) ?? null
}

/** Rang d'affichage d'une famille ; les familles inconnues passent à la fin. */
export function familyOrder(code: string | null | undefined): number {
  if (!code) return VEHICLE_FAMILIES.length
  const index = VEHICLE_FAMILIES.findIndex((family) => family.code === code)
  return index < 0 ? VEHICLE_FAMILIES.length : index
}

/** Libellé d'une famille, ou `null` si elle n'est pas au référentiel. */
export function familyLabel(code: string | null | undefined): string | null {
  return vehicleFamily(code)?.label ?? null
}

/** Nombre total de types proposés (61 aujourd'hui). */
export const VEHICLE_TYPE_COUNT = VEHICLE_TYPES.length

/**
 * Tri d'une liste de catégories de station : famille, puis rang dans la
 * famille, puis nom. C'est l'ordre que voit le caissier dans le sélecteur —
 * il cherche « SUV », pas « 4x4 » rangé entre « Ambulance » et « Autocar ».
 */
export function sortVehicleCategories<
  T extends { name: string; family?: string | null; sort_order?: number | null },
>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const familyDiff = familyOrder(a.family) - familyOrder(b.family)
    if (familyDiff !== 0) return familyDiff
    const orderDiff = (a.sort_order ?? 0) - (b.sort_order ?? 0)
    if (orderDiff !== 0) return orderDiff
    return a.name.localeCompare(b.name, "fr-CI")
  })
}
