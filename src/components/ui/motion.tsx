"use client"

/**
 * Primitives de mouvement — framer-motion + la couche d'élévation CSS.
 *
 * Chaque composant répond à un besoin récurrent de l'application. Rien ici
 * n'est décoratif : un décollement signale qu'un élément est cliquable, une
 * cascade indique un ordre de lecture, une lueur signale un état qui demande
 * une décision.
 *
 * Les durées et les courbes viennent toutes de `@/lib/motion` — aucune valeur
 * en dur dans ce fichier.
 */

import { forwardRef, useRef } from "react"
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type HTMLMotionProps,
} from "framer-motion"
import { useIsDesktop } from "@/hooks/use-media-query"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import {
  HOVER_LIFT,
  HOVER_SCALE,
  IN_VIEW,
  SPRING,
  TAP_PRESS,
  TRANSITION,
  fadeUp,
  pageEnter,
  scaleIn,
  staggerContainer,
  staggerItem,
} from "@/lib/motion"

/* ========================================================================== */
/*  Surfaces élevées                                                          */
/* ========================================================================== */

type ElevationLevel = 1 | 2 | 3 | 4
type GlowTone = "primary" | "success" | "warning" | "danger"

const GLOW_CLASS: Record<GlowTone, string> = {
  primary: "glow-primary",
  success: "glow-success",
  warning: "glow-warning",
  danger: "glow-danger",
}

const ELEVATION_CLASS: Record<ElevationLevel, string> = {
  1: "elev-1",
  2: "elev-2",
  3: "elev-3",
  4: "elev-4",
}

interface SurfaceProps extends HTMLMotionProps<"div"> {
  /** Hauteur au repos. 1 par défaut : une carte posée, pas en lévitation. */
  elevation?: ElevationLevel
  /** Décolle et renforce l'ombre au survol. Pour tout ce qui est cliquable. */
  interactive?: boolean
  /** Teinte la bordure et l'ombre : signale un état, pas une catégorie. */
  glow?: GlowTone
  /** Lueur permanente plutôt que révélée au survol. */
  glowAlways?: boolean
  /** Fait respirer la lueur. À réserver à ce qui exige une action. */
  pulse?: boolean
}

/**
 * Surface avec relief sur la bordure : biseau clair en haut, ombre de contact
 * en bas, liseré, ombre portée. Le survol ne fait varier qu'une opacité (le
 * pseudo-élément `::after`) et un `translateY` — jamais `box-shadow`, qui
 * n'est pas compositée par le GPU et ferait tomber les images par terre sur
 * les téléphones d'entrée de gamme.
 */
export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  {
    elevation = 1,
    interactive = false,
    glow,
    glowAlways = false,
    pulse = false,
    className,
    children,
    ...props
  },
  ref
) {
  return (
    <motion.div
      ref={ref}
      className={cn(
        "rounded-2xl border bg-card",
        interactive ? "surface-3d" : ELEVATION_CLASS[elevation],
        interactive && "cursor-pointer",
        glow && GLOW_CLASS[glow],
        glow && glowAlways && "glow-static",
        glow && pulse && "glow-breathe",
        className
      )}
      {...props}
    >
      {children}
    </motion.div>
  )
})

/**
 * Carte de tableau de bord : apparaît en cascade, décolle au survol,
 * s'enfonce au clic.
 *
 * L'échelle au survol est de 1 % (`HOVER_LIFT`). Sur une grille de quatre
 * indicateurs, 5 % feraient chevaucher les voisines et donneraient
 * l'impression que la grille tremble au passage de la souris.
 */
interface ElevatedCardProps extends SurfaceProps {
  /** Rang dans la grille : sert au décalage de la cascade. */
  index?: number
  /** Désactive le geste de pression (carte non cliquable). */
  readOnly?: boolean
}

export const ElevatedCard = forwardRef<HTMLDivElement, ElevatedCardProps>(
  function ElevatedCard(
    { index = 0, readOnly = false, className, children, ...props },
    ref
  ) {
    return (
      <Surface
        ref={ref}
        interactive
        className={className}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          ...SPRING.soft,
          // Plafonné à 10 : au-delà, la dernière carte d'une longue grille
          // apparaîtrait plus d'une seconde après la première.
          delay: Math.min(index, 10) * 0.055,
        }}
        whileHover={HOVER_LIFT}
        whileTap={readOnly ? undefined : TAP_PRESS}
        {...props}
      >
        {children}
      </Surface>
    )
  }
)

/**
 * `Card` de la bibliothèque, animée.
 *
 * `motion.create` enveloppe le composant existant plutôt que de le recopier :
 * les sous-composants (`CardHeader`, `CardContent`…) continuent de recevoir
 * les variables CSS de la carte, et une correction du style de base profite
 * aux deux versions.
 */
const MotionCardPrimitive = motion.create(Card)

interface MotionCardProps extends React.ComponentProps<typeof MotionCardPrimitive> {
  /** Rang dans la grille : décale l'apparition en cascade. */
  index?: number
}

export function MotionCard({
  index = 0,
  className,
  children,
  ...props
}: MotionCardProps) {
  return (
    <MotionCardPrimitive
      interactive
      className={className}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...SPRING.soft, delay: Math.min(index, 10) * 0.055 }}
      whileHover={HOVER_LIFT}
      {...props}
    >
      {children}
    </MotionCardPrimitive>
  )
}

/* ========================================================================== */
/*  Inclinaison 3D                                                            */
/* ========================================================================== */

interface Tilt3DProps {
  children: React.ReactNode
  className?: string
  /** Inclinaison maximale, en degrés. */
  maxTilt?: number
  /** Translation de l'ombre portée pendant l'inclinaison, en pixels. */
  depth?: number
}

/**
 * Carte qui s'incline vers le curseur, avec l'ombre qui se déporte dans la
 * direction opposée — c'est ce décalage, plus que la rotation, qui fait lire
 * l'objet comme physique.
 *
 * Inactif sous 768 px (pas de curseur, et le coût en images est réel sur les
 * Android d'entrée de gamme) et quand le système demande un mouvement réduit.
 */
export function Tilt3D({
  children,
  className,
  maxTilt = 7,
  depth = 10,
}: Tilt3DProps) {
  const ref = useRef<HTMLDivElement>(null)
  const prefersReduced = useReducedMotion() === true
  const isDesktop = useIsDesktop()
  const enabled = isDesktop && !prefersReduced

  const x = useMotionValue(0)
  const y = useMotionValue(0)

  const rotateX = useSpring(
    useTransform(y, [-0.5, 0.5], [maxTilt, -maxTilt]),
    SPRING.pointer
  )
  const rotateY = useSpring(
    useTransform(x, [-0.5, 0.5], [-maxTilt, maxTilt]),
    SPRING.pointer
  )
  // L'ombre part à l'opposé de l'inclinaison : la lumière reste fixe.
  const shadowX = useSpring(
    useTransform(x, [-0.5, 0.5], [depth, -depth]),
    SPRING.pointer
  )
  const shadowY = useSpring(
    useTransform(y, [-0.5, 0.5], [depth, -depth]),
    SPRING.pointer
  )

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!enabled || !ref.current) return
    const bounds = ref.current.getBoundingClientRect()
    x.set((event.clientX - bounds.left) / bounds.width - 0.5)
    y.set((event.clientY - bounds.top) / bounds.height - 0.5)
  }

  function reset() {
    x.set(0)
    y.set(0)
  }

  if (!enabled) {
    return <div className={cn("h-full", className)}>{children}</div>
  }

  return (
    <div
      ref={ref}
      onPointerMove={handlePointerMove}
      onPointerLeave={reset}
      className={cn("scene-3d h-full", className)}
    >
      <motion.div
        className="layer-3d h-full"
        style={{ rotateX, rotateY }}
        whileHover={{ scale: 1.012 }}
        transition={SPRING.snappy}
      >
        {/* Ombre portée dissociée : elle se déplace seule sous la carte. */}
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute inset-2 -z-10 rounded-2xl bg-foreground/15 blur-xl"
          style={{ x: shadowX, y: shadowY }}
        />
        {children}
      </motion.div>
    </div>
  )
}

/* ========================================================================== */
/*  Apparitions                                                               */
/* ========================================================================== */

interface FadeInProps extends HTMLMotionProps<"div"> {
  /** Attente avant le départ, en secondes. */
  delay?: number
  /** `true` : attend que l'élément entre dans la fenêtre pour se déclencher. */
  inView?: boolean
}

/** Apparition simple, montante. Le cas général. */
export function FadeIn({
  delay = 0,
  inView = false,
  className,
  children,
  ...props
}: FadeInProps) {
  const animation = inView
    ? { whileInView: "visible", viewport: IN_VIEW }
    : { animate: "visible" }

  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      transition={{ ...TRANSITION.enter, delay }}
      className={className}
      {...animation}
      {...props}
    >
      {children}
    </motion.div>
  )
}

interface StaggerProps extends HTMLMotionProps<"div"> {
  /** Décalage entre deux enfants, en secondes. */
  stagger?: number
  /** Attente avant le premier enfant. */
  delay?: number
  /** `true` : attend que la série entre dans la fenêtre pour se déclencher. */
  inView?: boolean
}

/**
 * Conteneur d'une cascade. Les enfants doivent être des `<StaggerItem>` ;
 * le décalage se propage par les variantes, pas par des délais calculés à
 * la main dans chaque écran.
 */
export function Stagger({
  stagger = 0.055,
  delay = 0,
  inView = false,
  className,
  children,
  ...props
}: StaggerProps) {
  const animation = inView
    ? { whileInView: "visible" as const, viewport: IN_VIEW }
    : { animate: "visible" as const }

  return (
    <motion.div
      variants={staggerContainer(stagger, delay)}
      initial="hidden"
      className={className}
      {...animation}
      {...props}
    >
      {children}
    </motion.div>
  )
}

/** Enfant d'une cascade. */
export function StaggerItem({
  className,
  children,
  ...props
}: HTMLMotionProps<"div">) {
  return (
    <motion.div variants={staggerItem} className={className} {...props}>
      {children}
    </motion.div>
  )
}

/* ========================================================================== */
/*  Gestes                                                                    */
/* ========================================================================== */

/**
 * Enveloppe tout élément cliquable d'un retour au survol et à la pression.
 * Utile quand le composant enfant n'est pas un `motion.*` (lien de routeur,
 * bouton de la bibliothèque, tuile composée).
 */
export function Pressable({
  className,
  children,
  ...props
}: HTMLMotionProps<"div">) {
  return (
    <motion.div
      whileHover={HOVER_SCALE}
      whileTap={TAP_PRESS}
      transition={SPRING.snappy}
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  )
}

/* ========================================================================== */
/*  Transitions de page et de panneau                                         */
/* ========================================================================== */

/**
 * Entrée d'un écran. Volontairement discrète : 8 px et 340 ms. L'utilisateur
 * vient de cliquer, il sait qu'il a changé de page — l'animation confirme,
 * elle ne raconte pas.
 */
export function PageTransition({
  className,
  children,
  ...props
}: HTMLMotionProps<"div">) {
  return (
    <motion.div
      variants={pageEnter}
      initial="hidden"
      animate="visible"
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  )
}

/**
 * Apparition d'un élément en surimpression (modale, panneau, info-bulle).
 * C'est le seul cas où l'échelle est justifiée : l'élément vient réellement
 * vers l'utilisateur, au-dessus du reste de la page.
 */
export function PopIn({
  className,
  children,
  ...props
}: HTMLMotionProps<"div">) {
  return (
    <motion.div
      variants={scaleIn}
      initial="hidden"
      animate="visible"
      exit="exit"
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  )
}
