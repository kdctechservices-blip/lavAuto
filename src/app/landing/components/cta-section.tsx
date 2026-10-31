import { ArrowRight, Check, MapPin, Smartphone } from "lucide-react"
import { Link } from "react-router-dom"
import { Reveal } from "./landing-motion"

export function CTASection() {
  return (
    <section id="cta" className="scroll-mt-24 px-4 pb-20 sm:px-6 sm:pb-28 lg:px-8">
      <Reveal>
        <div className="relative mx-auto grid max-w-7xl overflow-hidden rounded-[30px] bg-[#0b2145] shadow-[0_28px_80px_rgba(16,35,66,0.2)] lg:grid-cols-[1.05fr_0.95fr] sm:rounded-[36px]">
          <div className="relative z-10 flex flex-col justify-center p-6 sm:p-10 lg:p-12 xl:p-16">
            <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-sky-300">La prochaine étape</p>
            <h2 className="max-w-[18ch] text-3xl font-extrabold leading-tight tracking-[-0.045em] text-white text-balance sm:text-4xl">
              Vous ne devriez pas avoir à deviner ce que votre station vous rapporte.
            </h2>
            <p className="mt-4 max-w-[52ch] text-sm leading-6 text-blue-100/75 sm:text-base sm:leading-7">
              Passez à une gestion plus claire et mieux organisée. Commencez à structurer les opérations de votre station avec WashPilot CI.
            </p>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <Link
                to="/auth/sign-up"
                className="group inline-flex min-h-[52px] items-center justify-center gap-2 rounded-2xl bg-white px-5 text-sm font-extrabold text-[#0b2a55] shadow-lg shadow-black/15 transition duration-200 hover:-translate-y-0.5 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/30 motion-reduce:transition-none"
              >
                Je veux mieux gérer ma station <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
              </Link>
              <Link to="/auth/sign-in" className="inline-flex min-h-[48px] items-center justify-center rounded-2xl border border-white/20 px-5 text-sm font-semibold text-white/90 transition-colors hover:bg-white/10 motion-reduce:transition-none">
                J’ai déjà un compte
              </Link>
            </div>
            <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2 text-[10px] font-medium text-blue-100/65 sm:text-xs">
              <span className="inline-flex items-center gap-1.5"><Check className="size-3.5 text-emerald-300" aria-hidden="true" /> Pensé pour le terrain ivoirien</span>
              <span className="inline-flex items-center gap-1.5"><Smartphone className="size-3.5 text-sky-200" aria-hidden="true" /> Accessible sur téléphone</span>
            </div>
          </div>

          <div className="relative min-h-[260px] overflow-hidden sm:min-h-[340px] lg:min-h-full">
            <img
              src="/images/wash-owner.jpg"
              alt="Une responsable de station consulte son téléphone près d’un véhicule lavé."
              loading="lazy"
              decoding="async"
              className="absolute inset-0 size-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-[#0b2145] via-[#0b2145]/30 to-transparent lg:bg-gradient-to-l lg:from-[#0b2145]/5 lg:via-transparent lg:to-transparent" />
            <div className="absolute bottom-4 left-4 inline-flex items-center gap-2 rounded-full border border-white/20 bg-[#0b2145]/50 px-3 py-2 text-[10px] font-semibold text-white backdrop-blur-xl sm:bottom-6 sm:left-6 sm:text-xs">
              <MapPin className="size-3.5 text-sky-200" aria-hidden="true" />
              Une solution pensée en Côte d’Ivoire
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  )
}
