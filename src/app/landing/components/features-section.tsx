import {
  Banknote,
  CarFront,
  TrendingUp,
  ClipboardCheck,
  CreditCard,
  Users,
} from "lucide-react"
import { Reveal, SectionHeading } from "./landing-motion"
import { TiltCard } from "@/components/ui/tilt-card"

const features = [
  {
    icon: CarFront,
    title: "Chaque lavage, détaillé",
    description:
      "Retrouvez la catégorie du véhicule, les prestations, le montant, le paiement et les laveurs associés.",
    tone: "bg-blue-50 text-blue-700",
  },
  {
    icon: TrendingUp,
    title: "Des recettes plus lisibles",
    description:
      "Le tableau de bord regroupe les paiements confirmés et le nombre de lavages enregistrés.",
    tone: "bg-emerald-50 text-emerald-700",
  },
  {
    icon: Banknote,
    title: "Une caisse suivie",
    description:
      "Ouvrez une session, suivez les mouvements et comparez le solde théorique au montant compté.",
    tone: "bg-violet-50 text-violet-700",
  },
  {
    icon: ClipboardCheck,
    title: "Un historique des dépenses",
    description:
      "Consultez les dépenses enregistrées avec leur date, leur catégorie, leur montant et leur moyen de paiement.",
    tone: "bg-amber-50 text-amber-700",
  },
  {
    icon: Users,
    title: "Les laveurs associés aux opérations",
    description:
      "Associez les membres de l’équipe aux lavages concernés pour retrouver plus facilement le contexte.",
    tone: "bg-cyan-50 text-cyan-700",
  },
  {
    icon: CreditCard,
    title: "Les paiements du terrain",
    description:
      "Enregistrez les paiements en espèces, Orange Money, MTN MoMo, Moov Money, Wave ou autre.",
    tone: "bg-rose-50 text-rose-700",
  },
]

export function FeaturesSection() {
  return (
    <section id="fonctionnalites" className="scroll-mt-24 bg-[#f6f8fc] py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <SectionHeading
            eyebrow="Ce que vous pouvez suivre"
            title="Reprenez la maîtrise de votre activité."
            description="WashPilot CI rassemble les repères utiles pour comprendre votre journée de travail et prendre vos décisions à partir des opérations enregistrées."
          />
        </Reveal>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 sm:mt-16">
          {features.map((feature, index) => (
            <Reveal key={feature.title} delay={(index % 3) * 0.06}>
              {/* Inclinaison 3D limitée à 6°, souris uniquement. */}
              <TiltCard>
                <article className="group h-full rounded-3xl border border-slate-200/80 bg-white p-6 shadow-[0_12px_38px_rgba(16,35,66,0.04)] transition duration-300 hover:-translate-y-1 hover:shadow-[0_22px_50px_rgba(16,35,66,0.09)] motion-reduce:transition-none sm:p-7">
                  <div className={`mb-5 grid size-12 place-items-center rounded-2xl ${feature.tone} transition-transform duration-300 group-hover:scale-105 motion-reduce:transition-none`}>
                    <feature.icon className="size-5" aria-hidden="true" />
                  </div>
                  <h3 className="text-base font-bold leading-6 text-[#102342]">{feature.title}</h3>
                  <p className="mt-3 text-sm leading-6 text-slate-500">{feature.description}</p>
                </article>
              </TiltCard>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <p className="mx-auto mt-8 max-w-3xl text-center text-xs leading-5 text-slate-400 sm:text-sm">
            Les indicateurs reflètent les données saisies dans l’application. Ils aident à mieux voir l’activité, sans garantir un niveau de recettes ou de bénéfices.
          </p>
        </Reveal>
      </div>
    </section>
  )
}
