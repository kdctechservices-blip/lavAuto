import { CircleDollarSign, ClipboardList, EyeOff, FileWarning } from "lucide-react"
import { Reveal, SectionHeading } from "./landing-motion"

const challenges = [
  {
    icon: ClipboardList,
    title: "Des opérations dispersées",
    description:
      "Quand lavages, paiements et notes restent dans plusieurs carnets, faire le point prend du temps.",
    tone: "bg-blue-50 text-blue-700",
  },
  {
    icon: CircleDollarSign,
    title: "Des recettes difficiles à recouper",
    description:
      "Sans historique regroupé, il est compliqué de comparer ce qui a été lavé et ce qui a été encaissé.",
    tone: "bg-emerald-50 text-emerald-700",
  },
  {
    icon: EyeOff,
    title: "Moins de visibilité sur les dépenses",
    description:
      "Les sorties d’argent se repèrent plus facilement lorsqu’elles sont suivies avec les autres opérations.",
    tone: "bg-amber-50 text-amber-700",
  },
]

export function ProblemSection() {
  return (
    <section id="enjeux" className="scroll-mt-24 bg-[#f6f8fc] py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal>
          <SectionHeading
            eyebrow="Le quotidien des gérants"
            title="Votre station travaille. Mais vos chiffres sont-ils vraiment sous contrôle ?"
            description="Chaque jour, les voitures défilent, les lavages s’enchaînent et les dépenses s’accumulent. Pourtant, savoir précisément ce qui a été encaissé, dépensé et enregistré peut vite devenir compliqué."
          />
        </Reveal>

        <div className="mt-12 grid gap-4 md:grid-cols-3 sm:mt-16">
          {challenges.map((item, index) => (
            <Reveal key={item.title} delay={index * 0.07}>
              <article className="group h-full rounded-3xl border border-slate-200/80 bg-white p-6 shadow-[0_12px_38px_rgba(16,35,66,0.045)] transition duration-300 hover:-translate-y-1 hover:border-blue-200 hover:shadow-[0_20px_48px_rgba(16,35,66,0.09)] motion-reduce:transition-none sm:p-7">
                <div className={`mb-5 grid size-12 place-items-center rounded-2xl ${item.tone}`}>
                  <item.icon className="size-5" aria-hidden="true" />
                </div>
                <h3 className="text-lg font-bold tracking-tight text-[#102342]">{item.title}</h3>
                <p className="mt-3 text-sm leading-6 text-slate-500">{item.description}</p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal>
          <div className="mt-8 flex items-start gap-3 rounded-2xl border border-blue-100 bg-blue-50/70 p-4 text-sm leading-6 text-[#173d73] sm:mx-auto sm:max-w-3xl sm:items-center sm:justify-center sm:text-center">
            <FileWarning className="mt-0.5 size-5 shrink-0 text-blue-700 sm:mt-0" aria-hidden="true" />
            <p>
              Il est temps de gérer votre station avec des chiffres clairs, pas avec des suppositions.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
