import type { ReactNode } from "react"
import { motion, useReducedMotion } from "framer-motion"

interface RevealProps {
  children: ReactNode
  className?: string
  delay?: number
}

export function Reveal({ children, className, delay = 0 }: RevealProps) {
  const motionPreference = useReducedMotion()
  const reduceMotion = motionPreference !== false

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.16 }}
      transition={{
        duration: reduceMotion ? 0 : 0.48,
        delay: reduceMotion ? 0 : delay,
        ease: "easeOut",
      }}
      className={className}
    >
      {children}
    </motion.div>
  )
}

interface SectionHeadingProps {
  eyebrow: string
  title: string
  description?: string
  align?: "left" | "center"
  light?: boolean
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  align = "center",
  light = false,
}: SectionHeadingProps) {
  const alignClass = align === "center" ? "mx-auto text-center" : "text-left"
  const titleClass = light ? "text-white" : "text-[#102342]"
  const descriptionClass = light ? "text-blue-100/75" : "text-slate-500"

  return (
    <div className={`max-w-3xl ${alignClass}`}>
      <p className={`mb-3 text-xs font-bold uppercase tracking-[0.18em] ${light ? "text-sky-300" : "text-blue-700"}`}>
        {eyebrow}
      </p>
      <h2 className={`text-balance text-3xl font-extrabold leading-tight tracking-[-0.04em] sm:text-4xl lg:text-[2.8rem] ${titleClass}`}>
        {title}
      </h2>
      {description ? (
        <p className={`mt-4 text-pretty text-base leading-7 sm:text-lg ${descriptionClass}`}>
          {description}
        </p>
      ) : null}
    </div>
  )
}
