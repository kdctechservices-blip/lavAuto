import { ArrowRight, ClipboardList, Settings2, TrendingUp } from "lucide-react"
import { Link } from "react-router-dom"
import { Reveal, SectionHeading } from "./landing-motion"

const steps = [
  {
    number: "01",
    icon: Settings2,
    title: "Configurez votre station",
    description: "Renseignez les informations de votre station, vos catégories de véhicules, vos prestations et votre équipe.",
  },
  {
    number: "02",
    icon: ClipboardList,
    title: "Enregistrez les lavages",
    description: "Sélectionnez un véhicule, les services réalisés, les laveurs concernés et le moyen de paiement.",
  },
  {
    number: "03",
    icon: TrendingUp,
    title: "Faites le point",
    description: "Consultez les opérations enregistrées, les paiements confirmés et les mouvements de caisse.",
  },
]

export function HowItWorksSection() {
  return (
    <section id="parcours" className="scroll-mt-24 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <SectionHeading
            eyebrow="Un parcours clair"
            title="De l’opération au bilan, sans vous perdre dans les calculs."
            description="WashPilot accompagne les étapes essentielles de la journée d’une station de lavage."
          />
        </Reveal>

        <div className="relative mt-12 grid gap-4 md:grid-cols-3 sm:mt-16">
          <div className="pointer-events-none absolute left-[17%] right-[17%] top-8 hidden border-t border-dashed border-blue-200 md:block" />
          {steps.map((step, index) => (
            <Reveal key={step.number} delay={index * 0.07}>
              <article className="relative h-full rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_14px_40px_rgba(16,35,66,0.05)] sm:p-7">
                <div className="relative z-10 mb-6 flex items-center justify-between">
                  <span className="grid size-16 place-items-center rounded-2xl border border-blue-100 bg-white text-blue-700 shadow-md shadow-blue-950/[0.06]">
                    <step.icon className="size-6" aria-hidden="true" />
                  </span>
                  <span className="text-sm font-extrabold tracking-[0.18em] text-blue-200">{step.number}</span>
                </div>
                <h3 className="text-lg font-bold tracking-tight text-[#102342]">{step.title}</h3>
                <p className="mt-3 text-sm leading-6 text-slate-500">{step.description}</p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <div className="mt-10 flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-slate-500">Prêt à mettre vos opérations au clair ?</p>
            <Link
              to="/auth/sign-up"
              className="group inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#123d79] px-5 text-sm font-bold text-white shadow-md shadow-blue-900/15 transition duration-200 hover:-translate-y-0.5 hover:bg-[#0d3268] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-blue-500/25 motion-reduce:transition-none"
            >
              Je veux mieux gérer ma station <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
