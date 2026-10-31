import * as React from "react"

import { API_BASE_URL } from "@/lib/api"
import { PRICING_PLANS, PUBLIC_TRIAL_DAYS } from "@/config/pricing"

/**
 * Les prix réellement facturés, lus sur l'API publique.
 *
 * Pourquoi la vitrine ne se contente plus de ses constantes : depuis que
 * l'éditeur peut changer un tarif depuis la console, le chiffre écrit dans le
 * code n'est plus forcément celui qu'on réclamera au client. Afficher
 * 10 000 F puis facturer 12 000 F ne se rattrape pas commercialement — le
 * visiteur n'a aucune raison de croire le second chiffre.
 *
 * Deux principes gouvernent ce chargement :
 *
 *   • **Le code reste la valeur de repli.** Si l'API est injoignable — et une
 *     station ivoirienne perd le réseau — la page affiche la grille livrée
 *     plutôt qu'un espace vide ou un squelette qui tourne. Un prix
 *     éventuellement périmé vaut mieux qu'une page de tarifs sans tarifs.
 *   • **Aucune animation de montant.** Le chiffre apparaît une fois, à sa
 *     valeur finale. Un prix qui s'anime en se mettant à jour donnerait
 *     l'impression d'un tarif qui bouge pendant qu'on le lit.
 */
export interface LivePricing {
  /** Prix mensuel en francs, par code de forfait. */
  priceByCode: Record<string, number>
  trialDays: number
  /** Vrai tant que la grille affichée vient du code et non du serveur. */
  isFallback: boolean
}

const FALLBACK: LivePricing = {
  priceByCode: Object.fromEntries(PRICING_PLANS.map((plan) => [plan.code, plan.priceXof])),
  trialDays: PUBLIC_TRIAL_DAYS,
  isFallback: true,
}

export function useLivePricing(): LivePricing {
  const [pricing, setPricing] = React.useState<LivePricing>(FALLBACK)

  React.useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    ;(async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1/public/pricing`, {
          signal: controller.signal,
        })
        if (!response.ok) return
        const payload = (await response.json()) as {
          trial_days: number
          plans: { code: string; price_xof: number }[]
        }
        if (cancelled || !Array.isArray(payload.plans) || payload.plans.length === 0) return

        setPricing({
          priceByCode: Object.fromEntries(payload.plans.map((p) => [p.code, p.price_xof])),
          trialDays: payload.trial_days,
          isFallback: false,
        })
      } catch {
        /* Hors ligne ou serveur muet : la grille du code reste affichée. */
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  return pricing
}
