import type * as React from "react"
import { useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  CarFront,
  Check,
  ChevronRight,
  CircleDollarSign,
  CreditCard,
  LayoutDashboard,
  Users,
  WalletCards,
} from "lucide-react"
import { Reveal, SectionHeading } from "./landing-motion"
import { CountUpOnView } from "@/components/ui/count-up-on-view"

type DemoTab = "dashboard" | "washes" | "cash"

const tabs: { id: DemoTab; label: string }[] = [
  { id: "dashboard", label: "Tableau de bord" },
  { id: "washes", label: "Un lavage" },
  { id: "cash", label: "La caisse" },
]

function MiniMetric({
  label,
  value,
  icon: Icon,
  tint,
  note,
}: {
  label: string
  value: React.ReactNode
  icon: import("lucide-react").LucideIcon
  tint: string
  note?: string
}) {
  return (
    <div className="min-w-0 rounded-xl border border-slate-100 bg-white p-3 shadow-sm shadow-slate-900/[0.025] sm:p-4">
      <div className="flex items-center gap-1.5 text-[9px] font-medium text-slate-500 sm:text-[10px]">
        <Icon className={`size-3.5 shrink-0 ${tint}`} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      <p className="mt-2 truncate text-base font-extrabold tracking-tight text-[#102342] sm:text-xl">{value}</p>
      {note ? <p className="mt-1 text-[8px] leading-4 text-slate-400 sm:text-[9px]">{note}</p> : null}
    </div>
  )
}

function DashboardScreen() {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-[9px] font-medium uppercase tracking-wide text-slate-400">Vue d’ensemble</p>
        <h3 className="mt-0.5 text-base font-bold tracking-tight text-[#102342] sm:text-lg">Tableau de bord</h3>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <MiniMetric
          label="Recettes totales"
          value={<CountUpOnView value={186500} format={(amount) => `${amount.toLocaleString("fr-FR")} XOF`} />}
          icon={CircleDollarSign}
          tint="text-emerald-600"
          note="Somme des paiements confirmés"
        />
        <MiniMetric
          label="Lavages"
          value={<CountUpOnView value={24} duration={700} />}
          icon={CarFront}
          tint="text-blue-600"
          note="Nombre de lavages enregistrés"
        />
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50/80 p-3.5 sm:p-4">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white text-blue-700 shadow-sm">
          <CircleDollarSign className="size-4" aria-hidden="true" />
        </span>
        <div>
          <p className="text-[10px] font-bold text-[#102342] sm:text-xs">Des repères basés sur vos opérations</p>
          <p className="mt-1 text-[9px] leading-4 text-slate-500 sm:text-[10px]">
            Les montants sont calculés à partir des paiements et lavages enregistrés dans l’espace.
          </p>
        </div>
      </div>
    </div>
  )
}

function WashScreen() {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[9px] font-medium uppercase tracking-wide text-slate-400">Opération · Nouvelle</p>
          <h3 className="mt-0.5 text-base font-bold tracking-tight text-[#102342] sm:text-lg">Enregistrer un lavage</h3>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[9px] font-bold text-emerald-700">
          <Check className="size-3" aria-hidden="true" /> Exemple
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-3 rounded-xl border border-slate-100 bg-white p-3.5 shadow-sm shadow-slate-900/[0.025] sm:p-4">
          <div>
            <p className="mb-1.5 text-[9px] font-semibold text-slate-500">Catégorie du véhicule</p>
            <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-[10px] font-semibold text-slate-700">
              SUV <ChevronRight className="size-3.5 rotate-90 text-slate-400" aria-hidden="true" />
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-[9px] font-semibold text-slate-500">Laveurs associés</p>
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-[10px] font-semibold text-slate-700">
              <Users className="size-3.5 text-blue-600" aria-hidden="true" /> Équipe du poste 1
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-[9px] font-semibold text-slate-500">Moyen de paiement</p>
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-[10px] font-semibold text-slate-700">
              <CreditCard className="size-3.5 text-violet-600" aria-hidden="true" /> Orange Money
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-100 bg-white p-3.5 shadow-sm shadow-slate-900/[0.025] sm:p-4">
          <p className="mb-3 text-[10px] font-bold text-[#102342]">Prestations choisies</p>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 text-[9px] sm:text-[10px]">
              <span className="text-slate-600">Lavage extérieur</span><span className="font-semibold text-slate-700">3 000 XOF</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-[9px] sm:text-[10px]">
              <span className="text-slate-600">Nettoyage intérieur</span><span className="font-semibold text-slate-700">2 500 XOF</span>
            </div>
            <div className="border-t border-dashed border-slate-200 pt-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-bold text-[#102342]">Total indicatif</span>
                <span className="text-base font-extrabold text-blue-800">5 500 XOF</span>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-[9px] font-medium leading-4 text-blue-800">
              <Check className="size-3.5 shrink-0" aria-hidden="true" /> Les détails sont réunis sur la même fiche.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function CashScreen() {
  const movements = [
    { title: "Paiement d’un lavage", time: "09:42 · Espèces", amount: "+ 12 500 XOF", icon: ArrowDownLeft, tone: "text-emerald-600 bg-emerald-50" },
    { title: "Approvisionnement", time: "09:10 · Mouvement", amount: "+ 10 000 XOF", icon: ArrowUpRight, tone: "text-blue-600 bg-blue-50" },
    { title: "Paiement d’un lavage", time: "08:56 · Espèces", amount: "+ 5 000 XOF", icon: ArrowDownLeft, tone: "text-emerald-600 bg-emerald-50" },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[9px] font-medium uppercase tracking-wide text-slate-400">Suivi de caisse</p>
          <h3 className="mt-0.5 text-base font-bold tracking-tight text-[#102342] sm:text-lg">Une journée plus lisible</h3>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[9px] font-bold text-emerald-700">
          <span className="size-1.5 rounded-full bg-emerald-500" /> Session ouverte
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-[0.9fr_1.1fr]">
        <div className="rounded-xl bg-gradient-to-br from-[#123d79] to-[#0c2852] p-4 text-white shadow-lg shadow-blue-950/10 sm:p-5">
          <div className="flex items-center gap-2 text-[10px] font-semibold text-blue-100">
            <WalletCards className="size-4" aria-hidden="true" /> Solde théorique de la caisse
          </div>
          <p className="mt-4 text-2xl font-extrabold tracking-tight sm:text-3xl">27 500 XOF</p>
          <div className="mt-4 flex items-center justify-between border-t border-white/15 pt-3 text-[9px] text-blue-100/75">
            <span>Ouverte à 08:00</span><span>Exemple</span>
          </div>
        </div>
        <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-sm shadow-slate-900/[0.025] sm:p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-[10px] font-bold text-[#102342]">Mouvements récents</p>
            <Banknote className="size-4 text-blue-600" aria-hidden="true" />
          </div>
          <div className="space-y-2.5">
            {movements.map(({ title, time, amount, icon: Icon, tone }) => (
              <div key={`${title}-${time}`} className="flex items-center gap-2 border-b border-slate-100 pb-2 last:border-0 last:pb-0">
                <span className={`grid size-7 shrink-0 place-items-center rounded-lg ${tone}`}>
                  <Icon className="size-3.5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[9px] font-semibold text-slate-700">{title}</p>
                  <p className="text-[8px] text-slate-400">{time}</p>
                </div>
                <span className="shrink-0 text-[8px] font-bold text-emerald-700">{amount}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function DemoScreen({ tab }: { tab: DemoTab }) {
  if (tab === "washes") return <WashScreen />
  if (tab === "cash") return <CashScreen />
  return <DashboardScreen />
}

export function ProductDemoSection() {
  const [activeTab, setActiveTab] = useState<DemoTab>("dashboard")
  const motionPreference = useReducedMotion()
  const reduceMotion = motionPreference !== false

  return (
    <section id="demo" className="scroll-mt-24 py-20 sm:py-28">
      <div id="comment-ca-marche" className="mx-auto max-w-7xl scroll-mt-24 px-4 sm:px-6 lg:px-8">
        <Reveal>
          <SectionHeading
            eyebrow="Découvrez l’interface"
            title="Toute votre station. Une seule application."
            description="Consultez les lavages, les recettes confirmées et les mouvements de caisse depuis un espace clair, sur téléphone ou ordinateur."
          />
        </Reveal>

        <Reveal delay={0.06}>
          <div className="mx-auto mt-10 max-w-5xl rounded-[28px] border border-slate-200 bg-white p-2.5 shadow-[0_24px_80px_rgba(16,35,66,0.12)] sm:mt-14 sm:rounded-[32px] sm:p-4">
            <div className="mb-3 flex flex-col gap-3 px-2 pt-1 sm:flex-row sm:items-center sm:justify-between sm:px-1">
              <div className="flex items-center gap-2 text-[11px] font-bold text-[#102342] sm:text-xs">
                <span className="grid size-7 place-items-center rounded-lg bg-blue-50 text-blue-700">
                  <LayoutDashboard className="size-3.5" aria-hidden="true" />
                </span>
                Aperçu de WashPilot CI
                <span className="rounded-full bg-amber-50 px-2 py-1 text-[8px] font-bold uppercase tracking-wide text-amber-700 sm:text-[9px]">
                  Données d’illustration
                </span>
              </div>
              <div role="tablist" aria-label="Aperçus des écrans WashPilot" className="flex w-full gap-1 overflow-x-auto rounded-xl bg-slate-100 p-1 sm:w-auto">
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`shrink-0 rounded-lg px-3 py-2 text-[10px] font-bold transition-all motion-reduce:transition-none sm:px-3.5 sm:text-[11px] ${activeTab === tab.id ? "bg-white text-blue-800 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-hidden rounded-2xl border border-slate-200 bg-[#f7f9fc]" aria-label="Aperçu visuel de l’application, avec des données d’exemple">
              <div className="flex h-9 items-center justify-between border-b border-slate-200 bg-white px-3 sm:h-10 sm:px-4">
                <div className="flex items-center gap-1.5" aria-hidden="true">
                  <span className="size-2 rounded-full bg-rose-300" />
                  <span className="size-2 rounded-full bg-amber-300" />
                  <span className="size-2 rounded-full bg-emerald-300" />
                </div>
                <span className="text-[9px] font-medium tracking-wide text-slate-400 sm:text-[10px]">Aperçu de votre espace WashPilot</span>
                <span className="w-8" aria-hidden="true" />
              </div>
              <div className="flex min-h-[310px] sm:min-h-[350px]">
                <aside className="hidden w-[150px] shrink-0 flex-col border-r border-slate-200 bg-white p-3 sm:flex">
                  <div className="mb-5 flex items-center gap-2 px-1">
                    <span className="grid size-7 place-items-center rounded-lg bg-[#0c2852] text-white">
                      <CarFront className="size-4" aria-hidden="true" />
                    </span>
                    <span className="text-[10px] font-extrabold text-[#102342]">WashPilot</span>
                  </div>
                  <div className="space-y-1 text-[9px] font-semibold">
                    <div className={`flex items-center gap-2 rounded-lg px-2 py-2 ${activeTab === "dashboard" ? "bg-blue-50 text-blue-800" : "text-slate-500"}`}><LayoutDashboard className="size-3.5" /> Tableau de bord</div>
                    <div className={`flex items-center gap-2 rounded-lg px-2 py-2 ${activeTab === "washes" ? "bg-blue-50 text-blue-800" : "text-slate-500"}`}><CarFront className="size-3.5" /> Lavages</div>
                    <div className={`flex items-center gap-2 rounded-lg px-2 py-2 ${activeTab === "cash" ? "bg-blue-50 text-blue-800" : "text-slate-500"}`}><WalletCards className="size-3.5" /> Caisse</div>
                    <div className="flex items-center gap-2 rounded-lg px-2 py-2 text-slate-500"><Users className="size-3.5" /> Équipe</div>
                  </div>
                </aside>
                <div className="min-w-0 flex-1 p-3 sm:p-4 md:p-5">
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={activeTab}
                      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={reduceMotion ? undefined : { opacity: 0, y: -6 }}
                      transition={{ duration: reduceMotion ? 0 : 0.22, ease: "easeOut" }}
                    >
                      <DemoScreen tab={activeTab} />
                    </motion.div>
                  </AnimatePresence>
                </div>
              </div>
            </div>
            <p className="px-2 pb-1 pt-3 text-[10px] leading-5 text-slate-400 sm:text-center sm:text-[11px]">
              Les montants et opérations affichés ci-dessus sont fictifs et illustrent uniquement l’interface.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
