import { ChevronDown, CircleHelp } from "lucide-react"
import { Link } from "react-router-dom"
import { Reveal, SectionHeading } from "./landing-motion"

const faqItems = [
  {
    question: "WashPilot CI fonctionne-t-il sur téléphone ?",
    answer: "Oui. L’application est accessible depuis un navigateur et son interface s’adapte aux écrans de téléphone, de tablette et d’ordinateur.",
  },
  {
    question: "Quels moyens de paiement puis-je enregistrer ?",
    answer: "Pour les lavages, vous pouvez sélectionner les espèces, Orange Money, MTN MoMo, Moov Money, Wave ou un autre moyen de paiement.",
  },
  {
    question: "Puis-je retrouver les détails d’un lavage ?",
    answer: "Oui. L’historique permet de consulter les opérations enregistrées et les détails disponibles, notamment les prestations, le montant et le paiement.",
  },
  {
    question: "Comment sont calculées les recettes affichées ?",
    answer: "Le tableau de bord s’appuie sur les paiements confirmés enregistrés dans l’application. Les montants de la démonstration sur cette page sont fictifs.",
  },
  {
    question: "WashPilot CI garantit-il une hausse de mes bénéfices ?",
    answer: "Non. WashPilot CI aide à mieux suivre les données de votre station, mais ne garantit ni un chiffre d’affaires ni un niveau de bénéfices. Les résultats dépendent de votre activité et des opérations saisies.",
  },
  {
    question: "Comment commencer ?",
    answer: "Créez votre compte, configurez votre organisation et les informations de votre station, puis commencez à enregistrer vos opérations.",
  },
]

export function FaqSection() {
  return (
    <section id="faq" className="scroll-mt-24 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <SectionHeading
            eyebrow="Questions fréquentes"
            title="Des réponses claires avant de commencer."
            description="Voici l’essentiel à savoir sur l’utilisation de WashPilot CI au quotidien."
          />
        </Reveal>

        <div className="mx-auto mt-10 max-w-3xl space-y-3 sm:mt-14">
          {faqItems.map((item, index) => (
            <Reveal key={item.question} delay={index % 3 * 0.04}>
              <details className="group rounded-2xl border border-slate-200 bg-white px-5 py-1 shadow-sm shadow-slate-900/[0.025] open:border-blue-200 open:shadow-[0_12px_35px_rgba(16,35,66,0.06)]">
                <summary className="flex cursor-pointer list-none items-center gap-3 py-4 text-left text-sm font-bold text-[#102342] marker:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:text-base">
                  <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-700">
                    <CircleHelp className="size-4" aria-hidden="true" />
                  </span>
                  <span className="flex-1">{item.question}</span>
                  <ChevronDown className="size-4 shrink-0 text-slate-400 transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
                </summary>
                <p className="pb-5 pl-11 pr-2 text-sm leading-6 text-slate-500">{item.answer}</p>
              </details>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <div className="mt-10 text-center">
            <p className="text-sm text-slate-500">Prêt à découvrir votre espace de gestion ?</p>
            <Link to="/auth/sign-up" className="mt-3 inline-flex items-center gap-2 text-sm font-bold text-blue-700 underline decoration-blue-200 underline-offset-4 transition-colors hover:text-blue-900 motion-reduce:transition-none">
              Créer mon espace <span aria-hidden="true">→</span>
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
