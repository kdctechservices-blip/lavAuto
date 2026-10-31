import { useState } from "react"
import { AnimatePresence, motion, useReducedMotion } from "framer-motion"
import { ArrowLeft, ArrowRight, Images } from "lucide-react"
import { Reveal, SectionHeading } from "./landing-motion"

const gallery = [
  {
    src: "/images/wash-detailing.jpg",
    alt: "Un professionnel ivoirien rince un SUV dans une station de lavage.",
    title: "Le soin du lavage, jusque dans les détails.",
    description: "Un environnement de travail pensé autour des véhicules et de l’équipe.",
  },
  {
    src: "/images/wash-vehicles.jpg",
    alt: "Une berline, un SUV et un pickup dans une station de lavage moderne.",
    title: "Différents véhicules. Un suivi structuré.",
    description: "Organisez les lavages par catégorie et par prestation.",
  },
  {
    src: "/images/wash-owner.jpg",
    alt: "Une responsable de station consulte son téléphone près d’un véhicule propre.",
    title: "Une gestion qui suit le rythme du terrain.",
    description: "Retrouvez vos opérations sur téléphone ou ordinateur.",
  },
  {
    src: "/images/wash-station.jpg",
    alt: "Une équipe travaille dans une station de lavage en Côte d’Ivoire.",
    title: "Une station moderne, un quotidien mieux organisé.",
    description: "WashPilot CI accompagne les stations de lavage ivoiriennes.",
  },
]

export function GallerySection() {
  const [activeIndex, setActiveIndex] = useState(0)
  const motionPreference = useReducedMotion()
  const reduceMotion = motionPreference !== false
  const activeSlide = gallery[activeIndex]

  function move(direction: -1 | 1) {
    setActiveIndex((current) => (current + direction + gallery.length) % gallery.length)
  }

  return (
    <section id="terrain" className="scroll-mt-24 bg-[#f6f8fc] py-20 sm:py-28">
      <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 sm:px-6 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16 lg:px-8">
        <Reveal>
          <SectionHeading
            align="left"
            eyebrow="Pensé pour le terrain"
            title="Une application au service du quotidien de votre station."
            description="Des lavages qui s’enchaînent aux opérations de caisse, WashPilot CI rassemble les repères utiles pour mieux suivre votre activité."
          />
          <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-[10px] font-semibold text-slate-500 shadow-sm sm:text-xs">
            <Images className="size-4 text-blue-600" aria-hidden="true" />
            Visuels d’illustration · Côte d’Ivoire
          </div>
        </Reveal>

        <Reveal delay={0.06}>
          <div className="rounded-[28px] border border-slate-200 bg-white p-2.5 shadow-[0_24px_70px_rgba(16,35,66,0.11)] sm:rounded-[32px] sm:p-3.5">
            <div className="relative aspect-[16/10] overflow-hidden rounded-[21px] bg-[#0b2145] sm:rounded-[24px]">
              <AnimatePresence mode="wait" initial={false}>
                <motion.img
                  key={activeSlide.src}
                  src={activeSlide.src}
                  alt={activeSlide.alt}
                  loading="lazy"
                  decoding="async"
                  initial={reduceMotion ? false : { opacity: 0, scale: 1.025 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={reduceMotion ? undefined : { opacity: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.32, ease: "easeOut" }}
                  className="absolute inset-0 size-full object-cover"
                />
              </AnimatePresence>
              <div className="absolute inset-0 bg-gradient-to-t from-[#061a36]/90 via-[#061a36]/10 to-[#061a36]/5" />
              <div className="absolute left-4 right-4 top-4 flex items-center justify-between sm:left-5 sm:right-5 sm:top-5">
                <span className="rounded-full border border-white/20 bg-[#0b2145]/45 px-3 py-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-white backdrop-blur-lg sm:text-[10px]">
                  {String(activeIndex + 1).padStart(2, "0")} / {String(gallery.length).padStart(2, "0")}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    aria-label="Visuel précédent"
                    onClick={() => move(-1)}
                    className="grid size-9 place-items-center rounded-full border border-white/25 bg-[#0b2145]/45 text-white backdrop-blur-lg transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white motion-reduce:transition-none"
                  >
                    <ArrowLeft className="size-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label="Visuel suivant"
                    onClick={() => move(1)}
                    className="grid size-9 place-items-center rounded-full border border-white/25 bg-[#0b2145]/45 text-white backdrop-blur-lg transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white motion-reduce:transition-none"
                  >
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div aria-live="polite" className="absolute bottom-4 left-4 right-4 text-white sm:bottom-6 sm:left-6 sm:right-6">
                <h3 className="text-xl font-bold leading-tight tracking-tight sm:text-2xl">{activeSlide.title}</h3>
                <p className="mt-2 max-w-[50ch] text-xs leading-5 text-white/75 sm:text-sm">{activeSlide.description}</p>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2 pt-2.5 sm:gap-3 sm:pt-3.5">
              {gallery.map((slide, index) => (
                <button
                  key={slide.src}
                  type="button"
                  aria-label={`Afficher le visuel ${index + 1} : ${slide.title}`}
                  aria-current={activeIndex === index ? "true" : undefined}
                  onClick={() => setActiveIndex(index)}
                  className={`relative aspect-[4/3] overflow-hidden rounded-xl border-2 transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 motion-reduce:transition-none ${activeIndex === index ? "border-blue-600 shadow-md shadow-blue-900/15" : "border-transparent opacity-65 hover:opacity-100"}`}
                >
                  <img src={slide.src} alt="" loading="lazy" className="size-full object-cover" />
                </button>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
