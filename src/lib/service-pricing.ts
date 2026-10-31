/**
 * Prix d'une prestation selon le véhicule — une seule règle, des deux côtés.
 *
 * Le serveur appliquait déjà `price_by_vehicle_type` ; les écrans de caisse
 * calculaient, eux, le total avec le seul `price_cents`. Deux calculs pour un
 * même lavage, c'est un prix annoncé qui n'est pas le prix enregistré. Cette
 * fonction est désormais la seule à décider, et elle est appelée par le
 * serveur comme par l'interface.
 *
 * Ordre de résolution, du plus précis au plus général :
 *
 *   1. `price_by_vehicle_type[<id de la catégorie>]` — un tarif pour *cette*
 *      catégorie exacte (« SUV familial », « Camion-benne ») ;
 *   2. `price_by_vehicle_type[<code de famille>]` — un tarif pour la famille
 *      (« suv », « poids_lourds »). C'est le niveau utile : personne ne saisit
 *      61 prix, mais 9 familles tiennent sur un écran ;
 *   3. `price_cents` — le prix de base, qui s'applique à tout le reste.
 *
 * Les deux clés cohabitent volontairement : les tarifs par catégorie déjà
 * enregistrés (clés UUID) continuent de fonctionner, et une station qui n'a
 * jamais touché au tarif différencié ne voit aucune différence.
 *
 * Module pur : testable sans base.
 */

/** Clés de `services.price_by_vehicle_type` : identifiant de catégorie ou code de famille. */
export type PriceOverrides = Record<string, number | null | undefined> | null | undefined

export interface PricedService {
  price_cents: number
  price_by_vehicle_type?: PriceOverrides
}

/** Ce qu'il faut savoir du véhicule : son identifiant, et sa famille si on la connaît. */
export interface VehicleRef {
  id: string
  family?: string | null
}

function usable(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

/**
 * Prix unitaire d'une prestation pour un véhicule donné.
 *
 * `vehicle` peut être absent (formulaire vide, lavage historique sans
 * catégorie) : on retombe alors sur le prix de base plutôt que de refuser.
 */
export function resolveUnitPrice(
  service: PricedService,
  vehicle: VehicleRef | string | null | undefined,
): number {
  const base = usable(service.price_cents) ? service.price_cents : 0
  if (!vehicle) return base

  const ref: VehicleRef = typeof vehicle === "string" ? { id: vehicle } : vehicle
  const overrides = service.price_by_vehicle_type
  if (!overrides) return base

  const exact = overrides[ref.id]
  if (usable(exact)) return exact

  const family = ref.family ? overrides[ref.family] : undefined
  if (usable(family)) return family

  return base
}

/**
 * Prix le plus bas et le plus élevé qu'une prestation peut atteindre.
 *
 * Sert à afficher « à partir de 3 000 F » dans le catalogue quand des tarifs
 * par véhicule existent : annoncer le seul prix de base laisserait croire que
 * le tarif est unique.
 */
export function priceRange(service: PricedService): { min: number; max: number } {
  const base = usable(service.price_cents) ? service.price_cents : 0
  const values = Object.values(service.price_by_vehicle_type ?? {}).filter(usable)
  if (values.length === 0) return { min: base, max: base }
  return {
    min: Math.min(base, ...values),
    max: Math.max(base, ...values),
  }
}

/** Vrai si au moins un tarif spécifique est défini (par catégorie ou par famille). */
export function hasVehiclePricing(service: PricedService): boolean {
  return Object.values(service.price_by_vehicle_type ?? {}).some(usable)
}

/**
 * Vrai si la clé désigne une famille de véhicules.
 *
 * Les familles sont des codes en minuscules (`suv`, `poids_lourds`) ; les
 * catégories sont des UUID. La distinction est donc sans ambiguïté, et c'est
 * elle qui permet de faire cohabiter les deux niveaux dans le même objet.
 */
export function isFamilyPriceKey(key: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(key)
}

/**
 * Prix de base affiché dans le formulaire : le tarif saisi pour la famille si
 * elle en a un, sinon le prix de base de la prestation.
 *
 * Un champ vide dans le formulaire signifie « pas de tarif propre », et non
 * « zéro franc » : c'est cette valeur-là qui pré-remplit le champ.
 */
export function effectivePriceForFamily(service: PricedService, family: string): number {
  const override = service.price_by_vehicle_type?.[family]
  return usable(override) ? override : service.price_cents
}

// ---------------------------------------------------------------------------
// Modèle explicite : `service_vehicle_prices` (éligibilité ≠ tarif)
// ---------------------------------------------------------------------------

/**
 * Une prestation avec ses associations d'éligibilité : `vehicle_prices` lie
 * l'identifiant d'une catégorie de véhicule au tarif configuré pour elle.
 *
 * La **présence de la clé** est l'autorisation ; sa valeur est le prix.
 * Une clé absente signifie « interdite », même si un prix de base ou de
 * famille existe par ailleurs — aucun repli ne contourne une interdiction.
 * Une map `null`/absente (données anciennes non jointes) est traitée comme
 * vide : en cas de doute, on refuse plutôt que d'autoriser.
 */
export interface EligibleService extends PricedService {
  vehicle_prices?: Record<string, number> | null
}

/** La prestation est-elle autorisée pour cette catégorie de véhicule ? */
export function isEligibleFor(
  service: EligibleService,
  vehicleCategoryId: string | null | undefined,
): boolean {
  if (!vehicleCategoryId) return false
  const prices = service.vehicle_prices
  if (!prices) return false
  return usable(prices[vehicleCategoryId])
}

/**
 * Tarif configuré pour une catégorie autorisée, ou `null` si la prestation
 * n'est pas autorisée pour elle. Jamais de prix de repli : le montant
 * facturé est celui que le gérant a enregistré pour cette catégorie.
 */
export function configuredPriceFor(
  service: EligibleService,
  vehicleCategoryId: string | null | undefined,
): number | null {
  if (!vehicleCategoryId) return null
  const prices = service.vehicle_prices
  if (!prices) return null
  const price = prices[vehicleCategoryId]
  return usable(price) ? price : null
}

/** Amplitude des tarifs réellement configurés (modèle explicite). */
export function configuredPriceRange(service: EligibleService): { min: number; max: number } | null {
  const values = Object.values(service.vehicle_prices ?? {}).filter(usable)
  if (values.length === 0) return null
  return { min: Math.min(...values), max: Math.max(...values) }
}
