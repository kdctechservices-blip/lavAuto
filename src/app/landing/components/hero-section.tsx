import { useRef } from "react"
import { motion, useReducedMotion, useScroll, useSpring, useTransform } from "framer-motion"
import { ArrowDown, ArrowRight, CarFront, Check, MapPin, Smartphone, WalletCards } from "lucide-react"
import { Link } from "react-router-dom"
import { useIsDesktop } from "@/hooks/use-media-query"
import { useCountUp } from "@/hooks/use-count-up"

const reassurance = [
  "Simple à utiliser",
  "Pensé pour le terrain ivoirien",
  "Accessible sur téléphone",
]

export function HeroSection() {
  const motionPreference = useReducedMotion()
  const reduceMotion = motionPreference !== false
  const isDesktop = useIsDesktop()
  const sectionRef = useRef<HTMLElement>(null)

  // Parallax : le visuel glisse de 40 px au maximum pendant le défilement.
  // Désactivé sous 768 px et si l'utilisateur veut moins de mouvement.
  const parallaxEnabled = isDesktop && !reduceMotion
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end start"],
  })
  const rawParallax = useTransform(scrollYProgress, [0, 1], [0, -40])
  const visualY = useSpring(rawParallax, { stiffness: 120, damping: 24, mass: 0.4 })

  // Chiffres de l'aperçu : ils se composent à l'arrivée, comme une vraie
  // journée qui se remplit (données explicitement fictives).
  const sampleWashes = useCountUp(24, 900)
  const sampleRevenue = useCountUp(186500, 1100)

  return (
    <section
      id="hero"
      ref={sectionRef}
      className="relative isolate overflow-hidden bg-[#081b38] text-white"
    >
      {/* Dégradé qui respire très lentement (16 s) : la page paraît vivante
          sans jamais attirer l'œil pendant la lecture. */}
      <div className="gradient-pan pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_78%_36%,rgba(37,99,235,0.35),transparent_42%)]" />
      <div className="pointer-events-none absolute -left-28 top-20 size-80 rounded-full bg-blue-700/20 blur-3xl" />
      <div className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 pb-20 pt-14 sm:px-6 sm:pb-24 sm:pt-20 lg:grid-cols-[1.02fr_0.98fr] lg:gap-10 lg:px-8 lg:pb-28 lg:pt-20">
        <motion.div
          initial={reduceMotion ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.5, ease: "easeOut" }}
          className="relative z-10"
        >
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.07] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-blue-100 shadow-lg shadow-black/10 backdrop-blur sm:text-xs">
            <MapPin className="size-3.5 text-sky-300" aria-hidden="true" />
            Pour les gérants de stations de lavage
          </div>
          <p className="mb-4 max-w-[55ch] text-xs font-semibold leading-5 text-sky-200 sm:text-sm">
            La solution de gestion pensée pour les stations de lavage en Côte d’Ivoire
          </p>
          <h1 className="max-w-[17ch] text-[2.35rem] font-extrabold leading-[1.04] tracking-[-0.055em] text-balance sm:text-5xl lg:text-[3.65rem]">
            Vous lavez des voitures toute la journée. Mais savez-vous vraiment{" "}
            <span className="bg-gradient-to-r from-sky-200 via-blue-200 to-white bg-clip-text text-transparent">
              combien vous gagnez ?
            </span>
          </h1>
          <p className="mt-4 text-sm font-extrabold text-sky-200 sm:text-base">
            Plus de contrôle. Moins de zones d’ombre. Une station mieux pilotée.
          </p>
          <p className="mt-5 max-w-[58ch] text-base leading-7 text-blue-100/80 sm:text-lg sm:leading-8">
            Gérez vos lavages, suivez vos recettes et gardez vos dépenses en vue avec une application simple, accessible depuis votre téléphone.
          </p>
          <p className="mt-3 max-w-[58ch] text-sm leading-6 text-blue-100/65">
            Plus de contrôle sur vos opérations, sans promesse de gains miracles : des repères clairs à partir des données que vous enregistrez.
          </p>

          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link
              to="/auth/sign-up"
              className="group inline-flex min-h-[54px] items-center justify-center gap-2 rounded-2xl bg-white px-6 text-sm font-extrabold text-[#0b2a55] shadow-xl shadow-black/20 transition duration-200 hover:-translate-y-0.5 hover:bg-blue-50 hover:shadow-2xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/35 motion-reduce:transition-none"
            >
              Je veux reprendre le contrôle de mes recettes
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
            </Link>
            <a
              href="#comment-ca-marche"
              className="inline-flex min-h-[50px] items-center justify-center gap-2 rounded-2xl border border-white/20 px-5 text-sm font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/25 motion-reduce:transition-none"
            >
              Découvrir comment ça marche <ArrowDown className="size-4" aria-hidden="true" />
            </a>
          </div>

          <ul className="mt-7 flex flex-col gap-2.5 text-xs font-medium text-blue-100/75 sm:flex-row sm:flex-wrap sm:gap-x-5 sm:gap-y-3 sm:text-[13px]">
            {reassurance.map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span className="grid size-4 place-items-center rounded-full bg-emerald-400/15 text-emerald-300">
                  <Check className="size-3" aria-hidden="true" />
                </span>
                {item}
              </li>
            ))}
          </ul>
        </motion.div>

        <motion.div
          initial={reduceMotion ? false : { opacity: 0, scale: 0.98, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.58, delay: reduceMotion ? 0 : 0.08, ease: "easeOut" }}
          style={parallaxEnabled ? { y: visualY } : undefined}
          className="relative mx-auto w-full max-w-[610px] lg:mx-0"
        >
          <div className="absolute -inset-4 rounded-[34px] bg-blue-500/20 blur-2xl" />
          <div className="relative aspect-[4/3] overflow-hidden rounded-[28px] border border-white/15 bg-[#12315b] shadow-[0_30px_90px_rgba(0,0,0,0.38)] sm:aspect-[5/4]">
            <img
              src="/images/wash-station.jpg"
              alt="Une équipe travaille dans une station de lavage moderne en Côte d’Ivoire."
              className="absolute inset-0 size-full object-cover"
              loading="eager"
              decoding="async"
            />
            <div className="absolute inset-0 bg-gradient-to-br from-[#071a36]/10 via-[#071a36]/5 to-[#071a36]/75" />
            <div className="absolute left-4 right-4 top-4 flex items-center justify-between gap-2 sm:left-6 sm:right-6 sm:top-6">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-[#0b2145]/45 px-3 py-2 text-[10px] font-bold text-white shadow-lg backdrop-blur-xl sm:text-xs">
                <MapPin className="size-3.5 text-sky-200" aria-hidden="true" />
                Abidjan · Côte d’Ivoire
              </span>
              <span className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/15 px-3 py-2 text-[10px] font-bold text-white backdrop-blur-xl sm:text-xs">
                <Smartphone className="size-3.5" aria-hidden="true" />
                Mobile & ordinateur
              </span>
            </div>

            <div className="absolute bottom-4 left-4 right-4 rounded-2xl border border-white/25 bg-white/90 p-4 text-[#102342] shadow-2xl shadow-blue-950/25 backdrop-blur-xl sm:bottom-6 sm:left-6 sm:right-6 sm:p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-bold text-[#102342] sm:text-sm">
                  <span className="grid size-8 place-items-center rounded-xl bg-blue-50 text-blue-700">
                    <WalletCards className="size-4" aria-hidden="true" />
                  </span>
                  Un aperçu de votre activité
                </div>
                <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[9px] font-bold uppercase tracking-wide text-amber-700 sm:text-[10px]">
                  Exemple
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-slate-100 bg-white p-3">
                  <div className="flex items-center gap-1.5 text-[10px] font-medium text-slate-500 sm:text-xs">
                    <CarFront className="size-3.5 text-blue-600" aria-hidden="true" />
                    Lavages enregistrés
                  </div>
                  <p className="mt-1.5 text-lg font-extrabold tabular-nums tracking-tight text-[#102342] sm:text-xl">{sampleWashes}</p>
                </div>
                <div className="rounded-xl border border-slate-100 bg-white p-3">
                  <div className="flex items-center gap-1.5 text-[10px] font-medium text-slate-500 sm:text-xs">
                    <WalletCards className="size-3.5 text-emerald-600" aria-hidden="true" />
                    Recettes confirmées
                  </div>
                  <p className="mt-1.5 truncate text-lg font-extrabold tabular-nums tracking-tight text-[#102342] sm:text-xl">
                    {sampleRevenue.toLocaleString("fr-FR")} XOF
                  </p>
                </div>
              </div>
              <p className="mt-3 text-[9px] leading-4 text-slate-400 sm:text-[10px]">
                Chiffres fictifs utilisés uniquement pour illustrer l’interface.
              </p>
            </div>
          </div>
          <div className="absolute -bottom-4 -right-2 hidden items-center gap-2 rounded-2xl border border-white/15 bg-[#0b2145]/80 px-4 py-3 text-xs font-semibold text-white shadow-xl backdrop-blur-xl sm:flex sm:-right-5">
            <span className="grid size-8 place-items-center rounded-xl bg-sky-300/15 text-sky-200">
              <CarFront className="size-4" aria-hidden="true" />
            </span>
            Lavages · Recettes · Caisse
          </div>
        </motion.div>
      </div>
    </section>
  )
}
