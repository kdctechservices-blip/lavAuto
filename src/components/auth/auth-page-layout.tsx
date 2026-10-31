import type { ReactNode } from "react"
import { MapPin, Sparkles } from "lucide-react"
import { motion, useReducedMotion } from "framer-motion"
import { Link } from "react-router-dom"
import { BrandMark } from "@/components/brand"

interface AuthPageLayoutProps {
  eyebrow: string
  title: string
  description: string
  imageSrc: string
  imageAlt: string
  panelTitle: string
  panelDescription: string
  topAction?: ReactNode
  children: ReactNode
}

export function AuthPageLayout({
  eyebrow,
  title,
  description,
  imageSrc,
  imageAlt,
  panelTitle,
  panelDescription,
  topAction,
  children,
}: AuthPageLayoutProps) {
  const prefersReducedMotion = useReducedMotion()
  const reduceMotion = prefersReducedMotion ?? true
  const year = new Date().getFullYear()

  return (
    <main className="light-surface relative min-h-svh w-full overflow-hidden bg-[#f6f8fc] text-[#102342]">
      <div className="pointer-events-none absolute -left-40 top-36 size-96 rounded-full bg-blue-100/50 blur-3xl lg:hidden" />
      <div className="mx-auto grid min-h-svh w-full max-w-[1720px] grid-cols-1 lg:grid-cols-[minmax(0,1.04fr)_minmax(420px,0.96fr)]">
        <section className="relative z-10 flex min-h-svh flex-col px-5 py-5 sm:px-8 sm:py-7 lg:px-12 lg:py-8 xl:px-16">
          <header className="flex items-center justify-between gap-4">
            <Link
              to="/landing"
              aria-label="WashPilot CI — accueil"
              className="group flex shrink-0 items-center gap-3 rounded-xl outline-none focus-visible:ring-4 focus-visible:ring-blue-200"
            >
              <BrandMark
                height={40}
                tone="light"
                className="transition-transform duration-200 group-hover:-translate-y-0.5 motion-reduce:transition-none"
              />
              <span className="flex flex-col gap-1">
                <span className="text-[17px] font-extrabold leading-none tracking-[-0.04em] text-[#102342]">
                  WashPilot <span className="text-blue-600">CI</span>
                </span>
                <span className="text-[9px] font-bold uppercase tracking-[0.19em] text-slate-400">
                  Le pilotage nouvelle génération
                </span>
              </span>
            </Link>
            {topAction ? (
              <div className="text-right text-xs leading-5 text-slate-500 sm:text-sm">
                {topAction}
              </div>
            ) : null}
          </header>

          <div className="mx-auto flex w-full max-w-[460px] flex-1 flex-col justify-center py-10 sm:py-12">
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.42, ease: "easeOut" }}
            >
              <div className="mb-7 sm:mb-8">
                <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-blue-100 bg-white/80 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-blue-700 shadow-sm shadow-blue-950/[0.03] sm:text-[11px]">
                  <span className="size-1.5 rounded-full bg-blue-600" />
                  {eyebrow}
                </div>
                <h1 className="max-w-[13ch] text-[2rem] font-extrabold leading-[1.12] tracking-[-0.045em] text-[#102342] sm:text-[2.5rem]">
                  {title}
                </h1>
                <p className="mt-3 max-w-[42ch] text-sm leading-6 text-slate-500 sm:text-[15px]">
                  {description}
                </p>
              </div>
              <div className="rounded-3xl border border-white/90 bg-white/90 p-4 shadow-[0_18px_55px_rgba(15,35,70,0.08)] backdrop-blur-xl sm:p-6">
                {children}
              </div>
            </motion.div>
          </div>

          <footer className="flex flex-col gap-1 border-t border-slate-200/80 pt-4 text-[10px] leading-5 text-slate-400 sm:flex-row sm:items-center sm:justify-between sm:text-[11px]">
            <span>© {year} WashPilot CI · Pensé pour les stations ivoiriennes.</span>
            <span>Un espace sécurisé pour votre activité.</span>
          </footer>
        </section>

        <aside className="relative hidden min-h-svh p-4 lg:block xl:p-5">
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: reduceMotion ? 0 : 0.55, ease: "easeOut" }}
            className="relative h-full min-h-[620px] overflow-hidden rounded-[30px] bg-[#0b2349] shadow-2xl shadow-blue-950/20"
          >
            <img
              src={imageSrc}
              alt={imageAlt}
              loading="lazy"
              decoding="async"
              className="absolute inset-0 size-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-[#071a36]/40 via-[#071a36]/5 to-[#071a36]/85" />
            <div className="absolute inset-0 bg-gradient-to-r from-[#071a36]/20 via-transparent to-transparent" />

            <div className="absolute left-7 right-7 top-7 flex items-center justify-between gap-3 rounded-2xl border border-white/15 bg-[#0a2145]/35 px-4 py-3 text-white shadow-lg backdrop-blur-xl xl:left-9 xl:right-9 xl:top-9">
              <div className="flex items-center gap-2.5 text-xs font-medium text-white/90 xl:text-sm">
                <span className="grid size-8 place-items-center rounded-xl bg-white/15">
                  <MapPin className="size-4" aria-hidden="true" />
                </span>
                Une solution pensée en Côte d’Ivoire
              </div>
              <span className="rounded-lg border border-white/20 bg-white/10 px-2 py-1 text-[10px] font-bold tracking-[0.16em] text-white/90">
                CI
              </span>
            </div>

            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.5, delay: reduceMotion ? 0 : 0.12, ease: "easeOut" }}
              className="absolute bottom-8 left-7 right-7 text-white xl:bottom-10 xl:left-9 xl:right-9"
            >
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.16em] text-white/90 backdrop-blur-lg xl:text-[10px]">
                <Sparkles className="size-3.5" aria-hidden="true" />
                Votre station, à son meilleur
              </div>
              <h2 className="max-w-[14ch] text-3xl font-bold leading-[1.08] tracking-[-0.04em] xl:text-[2.65rem]">
                {panelTitle}
              </h2>
              <p className="mt-3 max-w-[39ch] text-sm leading-6 text-white/75 xl:text-[15px]">
                {panelDescription}
              </p>
              <div className="mt-7 flex items-center gap-2 text-[10px] font-medium tracking-wide text-white/75 xl:text-xs">
                <span className="size-1.5 rounded-full bg-sky-300" />
                Lavages · Équipe · Encaissements
              </div>
            </motion.div>
          </motion.div>
        </aside>
      </div>
    </main>
  )
}
