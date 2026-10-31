/**
 * Grille tarifaire publique — source unique de la section « Tarifs ».
 *
 * ⚠️ Ces prix sont des **hypothèses commerciales à tester** auprès des gérants
 * ivoiriens. Ils ne sont pas validés par le marché.
 *
 * Depuis le 20 octobre 2026, la vitrine et le catalogue applicatif sont
 * alignés : chaque `code` ci-dessous existe à l'identique dans `plans`
 * (`server/db.ts`), au même prix. Toute modification doit porter sur les deux,
 * sans quoi un visiteur verrait un prix sur la page publique et un autre dans
 * l'onboarding.
 *
 * | Rang | Forfait  | Prix     | Code applicatif |
 * |------|----------|----------|-----------------|
 * | 1    | Starter  | 10 000 F | `starter`       |
 * | 2    | Pro      | 20 000 F | `pro`           |
 * | 3    | Business | 35 000 F | `business`      |
 *
 * Il n'existe plus de forfait à 0 F : les trois sont payants et ouvrent
 * chacun 14 jours d'essai sans carte bancaire.
 */

export interface PricingPlan {
  /** Code du forfait applicatif visé (`plans.code` en base). */
  code: "starter" | "pro" | "business"
  name: string
  /** Positionnement affiché au-dessus du nom. */
  tagline: string
  /** Prix mensuel en FCFA (XOF n'a pas de sous-unité : pas de centimes). */
  priceXof: number
  /** À qui s'adresse le forfait. Une phrase, pas un paragraphe. */
  audience: string
  /** Reprise du forfait précédent, affichée en tête de liste. */
  inherits?: string
  features: string[]
  /** Mis en avant visuellement. Un seul forfait doit l'être. */
  featured?: boolean
}

/**
 * Délai de première réponse annoncé, par forfait, **en heures ouvrées**.
 *
 * C'est la définition de « assistance prioritaire » : non plus un badge, mais
 * un engagement que le client peut vérifier. La source de vérité est
 * `RESPONSE_COMMITMENT_HOURS` dans `server/support-sla.ts`, qui pilote les
 * échéances réelles ; `tests/pricing-promises.test.ts` interdit la dérive
 * entre les deux.
 */
export const PUBLIC_RESPONSE_HOURS: Record<string, number> = {
  starter: 30,
  pro: 10,
  business: 4,
}

/** Une journée d'assistance : du lundi au vendredi, 8 h - 18 h. */
export const PUBLIC_BUSINESS_HOURS_PER_DAY = 10

/** Rend un délai lisible : « 4 heures ouvrées », « 1 jour ouvré ». */
export function publicResponseLabel(hours: number): string {
  if (hours < PUBLIC_BUSINESS_HOURS_PER_DAY) return `${hours} heures ouvrées`
  const days = hours / PUBLIC_BUSINESS_HOURS_PER_DAY
  return days === 1 ? "1 jour ouvré" : `${days} jours ouvrés`
}

export const PRICING_PLANS: PricingPlan[] = [
  {
    code: "starter",
    name: "Starter",
    tagline: "Entrée de gamme",
    priceXof: 10_000,
    audience:
      "Pour les petites stations qui veulent abandonner le cahier de caisse.",
    features: [
      "Enregistrement des lavages et des prestations",
      "Catalogue de services et prix",
      "Recettes par mode de paiement",
      "Suivi simple des dépenses",
      "Rapport quotidien",
      `Assistance WhatsApp, réponse sous ${publicResponseLabel(PUBLIC_RESPONSE_HOURS.starter)}`,
    ],
  },
  {
    code: "pro",
    name: "Pro",
    tagline: "Offre principale",
    priceXof: 20_000,
    audience:
      "Pour les stations qui ont plusieurs laveurs et veulent mieux contrôler leurs opérations.",
    inherits: "Tout Starter",
    features: [
      "Gestion des équipes et des attributions",
      "Suivi des sessions de caisse",
      "Suivi des dépenses et des marges opérationnelles",
      "Stock des consommables : niveaux, seuils d’alerte et inventaire",
      "Déduction automatique du stock à chaque lavage",
      "Rapports détaillés et exports",
      "Historique des opérations et traçabilité",
      `Assistance prioritaire : réponse sous ${publicResponseLabel(PUBLIC_RESPONSE_HOURS.pro)}`,
    ],
    featured: true,
  },
  {
    code: "business",
    name: "Business",
    tagline: "Stations structurées",
    priceXof: 35_000,
    audience:
      "Pour les stations importantes ou les propriétaires qui gèrent plusieurs sites.",
    inherits: "Tout Pro",
    features: [
      "Gestion multi-sites selon les limites du forfait",
      "Vue consolidée du propriétaire",
      "Permissions avancées",
      "Rapports consolidés",
      `Assistance prioritaire : réponse sous ${publicResponseLabel(PUBLIC_RESPONSE_HOURS.business)}`,
      "Accompagnement à la mise en service",
    ],
  },
]

/** Durée de l'essai gratuit annoncée publiquement. Doit rester égale à
 *  `TRIAL_DAYS` dans `server/entitlements.ts`, qui fait foi côté produit. */
export const PUBLIC_TRIAL_DAYS = 14

/**
 * Espace insécable avant l'unité et séparateur de milliers : « 10 000 FCFA ».
 * `Intl` en `fr-FR` produit une espace fine insécable, correcte en typographie
 * française et jamais coupée en fin de ligne.
 */
export function formatXofPrice(amount: number): string {
  return `${amount.toLocaleString("fr-FR")} FCFA`
}
