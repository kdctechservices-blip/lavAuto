/**
 * Stations (multi-sites) — types partagés avec les routes `/sites`
 * de `server/api.ts`.
 *
 * Une station ne se supprime pas dès qu'elle a servi : le serveur refuse
 * (409 `site_in_use`) tant que des lavages, caisses, dépenses ou travailleurs
 * la référencent. On la désactive, ce qui préserve l'historique comptable.
 */

export interface SiteRecord {
  id: string
  name: string
  city: string
  address: string | null
  phone: string | null
  email: string | null
  description: string | null
  logo_url: string | null
  slug: string | null
  is_active: boolean
  created_at: string
  updated_at: string
  /**
   * Faux pour une station devenue excédentaire après une rétrogradation, une
   * fois le délai de grâce écoulé : son historique reste entièrement lisible
   * et exportable, mais elle n'accepte plus de nouvelle opération.
   */
  writable: boolean
}

/** Champs acceptés en création et en modification. */
export interface SiteInput {
  name: string
  city: string
  address: string | null
  phone: string | null
  email: string | null
  description: string | null
  is_active: boolean
}

export const emptySiteInput = (): SiteInput => ({
  name: "",
  city: "",
  address: null,
  phone: null,
  email: null,
  description: null,
  is_active: true,
})

export function siteInputFrom(site: SiteRecord): SiteInput {
  return {
    name: site.name,
    city: site.city,
    address: site.address,
    phone: site.phone,
    email: site.email,
    description: site.description,
    is_active: site.is_active,
  }
}
