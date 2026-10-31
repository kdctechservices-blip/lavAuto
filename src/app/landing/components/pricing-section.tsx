"use client"

import { ArrowRight, Check, ShieldCheck } from "lucide-react"
import { Link } from "react-router-dom"
import { motion } from "framer-motion"

import { Reveal, SectionHeading } from "./landing-motion"
import {
  PRICING_PLANS,
  formatXofPrice,
  type PricingPlan,
} from "@/config/pricing"
import { useLivePricing } from "@/lib/public-pricing"
import { SPRING } from "@/lib/motion"
import { cn } from "@/lib/utils"

/**
 * Section tarifaire de la page vitrine.
 *
 * Trois forfaits, pas davantage : au-delà, le visiteur compare au lieu de
 * choisir. Le forfait du milieu est mis en avant — c'est celui que la plupart
 * des stations avec plusieurs laveurs devraient prendre, et une grille sans
 * recommandation laisse le gérant seul devant trois colonnes.
 *
 * Pas de bascule mensuel / annuel : il n'existe pas de tarif annuel à ce jour,
 * et afficher un sélecteur qui ne change rien détruit la confiance.
 */
export function PricingSection() {
  // Les prix réellement facturés, avec repli sur la grille du code si l'API
  // ne répond pas. Voir src/lib/public-pricing.ts.
  const pricing = useLivePricing()

  return (
    <section
      id="tarifs"
      className="scroll-mt-24 bg-gradient-to-b from-white to-slate-50 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <SectionHeading
            eyebrow="Tarifs"
            title="Trois forfaits, un prix clair, aucun engagement caché."
            description={`Essayez gratuitement pendant ${pricing.trialDays} jours, sans carte bancaire. Vous ne payez que si WashPilot vous fait gagner du temps.`}
          />
        </Reveal>

        {/* Étirement par défaut : les trois cartes se terminent à la même
            hauteur malgré des listes inégales. Seul le forfait recommandé
            dépasse, et c'est voulu. */}
        <div className="mt-12 grid gap-5 sm:mt-16 lg:grid-cols-3">
          {PRICING_PLANS.map((plan, index) => (
            <PlanCard
              key={plan.code}
              plan={plan}
              index={index}
              priceXof={pricing.priceByCode[plan.code] ?? plan.priceXof}
            />
          ))}
        </div>

        <Reveal delay={0.1}>
          <TrialNote trialDays={pricing.trialDays} />
        </Reveal>
      </div>
    </section>
  )
}

function PlanCard({
  plan,
  index,
  priceXof,
}: {
  plan: PricingPlan
  index: number
  /** Prix facturé, qui prime sur celui du catalogue local. */
  priceXof: number
}) {
  const featured = plan.featured === true

  return (
    <Reveal delay={index * 0.07} className="h-full">
      <motion.article
        whileHover={{ y: -4 }}
        transition={SPRING.soft}
        className={cn(
          "surface-3d relative flex h-full flex-col rounded-3xl border bg-white p-6 sm:p-7",
          featured
            ? // Le forfait recommandé est plus haut dans la hiérarchie de
              // profondeur, et garde sa lueur même sans survol.
              "glow-primary glow-static border-blue-200 lg:-mt-4 lg:pb-9"
            : "border-slate-200"
        )}
      >
        {featured && (
          <span className="absolute -top-3 left-6 rounded-full bg-[#123d79] px-3 py-1 text-[10px] font-extrabold uppercase tracking-[0.16em] text-white shadow-md shadow-blue-900/20">
            Recommandé
          </span>
        )}

        <p
          className={cn(
            "text-[11px] font-bold uppercase tracking-[0.18em]",
            featured ? "text-blue-700" : "text-slate-400"
          )}
        >
          {plan.tagline}
        </p>

        <h3 className="mt-2 text-2xl font-extrabold tracking-[-0.03em] text-[#102342]">
          {plan.name}
        </h3>

        {/* Le prix et l'unité sur la même ligne de base : « 20 000 FCFA / mois »
            se lit d'un bloc, alors qu'un « /mois » décroché se perd. */}
        <p className="mt-5 flex flex-wrap items-baseline gap-x-2">
          <span className="text-4xl font-extrabold tracking-[-0.04em] text-[#102342] tabular-nums">
            {formatXofPrice(priceXof)}
          </span>
          <span className="text-sm font-semibold text-slate-500">/ mois</span>
        </p>

        <p className="mt-3 min-h-[3rem] text-sm leading-6 text-slate-500">
          {plan.audience}
        </p>

        <Link
          to="/auth/sign-up"
          className={cn(
            "group mt-6 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-5 text-sm font-bold transition duration-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/25 motion-reduce:transition-none",
            featured
              ? "bg-[#123d79] text-white shadow-md shadow-blue-900/15 hover:-translate-y-0.5 hover:bg-[#0d3268]"
              : "border border-slate-200 bg-white text-[#102342] hover:-translate-y-0.5 hover:bg-slate-50"
          )}
        >
          Commencer l’essai gratuit
          <ArrowRight
            className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </Link>

        <div className="mt-7 border-t border-slate-100 pt-6">
          {plan.inherits && (
            <p className="mb-4 text-sm font-bold text-[#102342]">
              {plan.inherits}, plus :
            </p>
          )}
          <ul className="flex flex-col gap-3 text-sm">
            {plan.features.map((feature) => (
              <li key={feature} className="flex items-start gap-3">
                <span
                  className={cn(
                    "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full",
                    featured
                      ? "bg-blue-100 text-blue-700"
                      : "bg-slate-100 text-slate-500"
                  )}
                >
                  <Check className="size-3" strokeWidth={3} aria-hidden="true" />
                </span>
                <span className="leading-6 text-slate-600">{feature}</span>
              </li>
            ))}
          </ul>
        </div>
      </motion.article>
    </Reveal>
  )
}

/**
 * Rappel de l'essai. Placé après la grille : le visiteur a vu les prix, c'est
 * le moment de lever l'objection du paiement, pas avant.
 */
function TrialNote({ trialDays }: { trialDays: number }) {
  return (
    <div className="elev-1 mx-auto mt-10 flex max-w-3xl flex-col items-start gap-4 rounded-2xl border border-blue-100 bg-white p-5 sm:flex-row sm:items-center sm:p-6">
      <span className="edge-3d grid size-11 shrink-0 place-items-center rounded-2xl bg-blue-50 text-blue-700">
        <ShieldCheck className="size-5" aria-hidden="true" />
      </span>
      <div>
        <p className="text-sm font-bold text-[#102342]">
          {trialDays} jours d’essai accompagné, sans carte bancaire.
        </p>
        <p className="mt-1 text-sm leading-6 text-slate-500">
          Vous gardez l’accès complet pendant l’essai. À l’échéance, votre
          espace reste consultable : vos données ne sont jamais bloquées ni
          supprimées. Les prix sont en francs CFA, par station et par mois.
        </p>
      </div>
    </div>
  )
}
