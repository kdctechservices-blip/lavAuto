/**
 * Jetons de mouvement — source unique des durées, courbes et variantes.
 *
 * Pourquoi centraliser : une application où chaque écran choisit sa propre
 * durée paraît bricolée. Trois cartes qui apparaissent en 200, 250 et 400 ms
 * ne donnent pas « trois animations », elles donnent une impression de
 * lenteur irrégulière. Un seul fichier, donc, et des noms qui disent l'usage
 * plutôt que la valeur.
 *
 * Les durées sont en **secondes** (convention framer-motion), le CSS du projet
 * les exprime en millisecondes. Les deux échelles sont volontairement alignées.
 *
 * Mouvement réduit : `<MotionConfig reducedMotion="user">` dans App.tsx
 * neutralise déjà transform et layout pour toute l'application. Les variantes
 * ci-dessous n'ont donc pas à tester la préférence — sauf les effets continus
 * (inclinaison au pointeur), qui la lisent explicitement.
 */

import type { Transition, Variants } from "framer-motion"

/* -------------------------------------------------------------------------- */
/*  Durées                                                                     */
/* -------------------------------------------------------------------------- */

export const DURATION = {
  /** 120 ms — survol, pression, bascule d'état. En dessous de 100 ms l'œil ne
   *  perçoit plus une transition mais un saut ; au-dessus de 150 ms l'interface
   *  traîne sous le curseur. */
  hover: 0.12,
  /** 240 ms — apparition d'un élément : carte, ligne, badge, info-bulle. */
  enter: 0.24,
  /** 180 ms — disparition. Toujours plus rapide que l'apparition : on ne fait
   *  pas attendre quelqu'un devant un élément qu'il vient de fermer. */
  exit: 0.18,
  /** 340 ms — changement de page ou ouverture de modale. */
  page: 0.34,
  /** 700 ms — décompte d'un chiffre clé. Jamais pendant une saisie. */
  counter: 0.7,
} as const

/* -------------------------------------------------------------------------- */
/*  Courbes                                                                    */
/* -------------------------------------------------------------------------- */

export const EASE = {
  /** Démarrage franc, arrivée amortie. La courbe par défaut : ce qui entre à
   *  l'écran doit être lisible tout de suite, pas arriver mollement. */
  out: [0.22, 1, 0.36, 1],
  /** Symétrique, pour ce qui se déplace sans apparaître ni disparaître. */
  inOut: [0.65, 0, 0.35, 1],
  /** Accélération : réservée aux sorties. */
  in: [0.4, 0, 1, 1],
} as const satisfies Record<string, [number, number, number, number]>

/* -------------------------------------------------------------------------- */
/*  Transitions prêtes à l'emploi                                              */
/* -------------------------------------------------------------------------- */

export const TRANSITION = {
  hover: { duration: DURATION.hover, ease: EASE.out },
  enter: { duration: DURATION.enter, ease: EASE.out },
  exit: { duration: DURATION.exit, ease: EASE.in },
  page: { duration: DURATION.page, ease: EASE.out },
} as const satisfies Record<string, Transition>

/**
 * Ressorts. Un ressort convient à ce que l'utilisateur manipule (une carte
 * qu'il survole, un panneau qu'il tire) ; une durée fixe convient à ce que
 * l'application décide seule. Mélanger les deux au hasard donne une interface
 * qui semble hésiter.
 */
export const SPRING = {
  /** Réponse immédiate, sans rebond visible : survol et pression. */
  snappy: { type: "spring", stiffness: 420, damping: 32, mass: 0.6 },
  /** Léger dépassement : apparition d'une carte, ouverture d'un panneau. */
  soft: { type: "spring", stiffness: 240, damping: 26, mass: 0.7 },
  /** Suivi de pointeur (inclinaison 3D) : amorti pour ne pas osciller. */
  pointer: { stiffness: 220, damping: 22, mass: 0.4 },
} as const satisfies Record<string, Transition>

/* -------------------------------------------------------------------------- */
/*  Variantes d'apparition                                                     */
/* -------------------------------------------------------------------------- */

/** Monte de 10 px en apparaissant. Le déplacement par défaut. */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: TRANSITION.enter },
  exit: { opacity: 0, y: -6, transition: TRANSITION.exit },
}

/** Fondu seul : quand un déplacement déplacerait aussi le texte voisin. */
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: TRANSITION.enter },
  exit: { opacity: 0, transition: TRANSITION.exit },
}

/**
 * Grossit depuis 96 %. Réservé à ce qui apparaît *par-dessus* le reste —
 * modale, info-bulle, menu. Appliqué à une carte dans le flux, l'effet donne
 * l'impression que la mise en page est instable.
 */
export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: { opacity: 1, scale: 1, transition: SPRING.soft },
  exit: { opacity: 0, scale: 0.97, transition: TRANSITION.exit },
}

/** Entrée de page : très courte distance, l'utilisateur a déjà changé d'écran. */
export const pageEnter: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: TRANSITION.page },
}

/* -------------------------------------------------------------------------- */
/*  Cascades                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Conteneur d'une série d'éléments.
 *
 * @param stagger  Décalage entre deux enfants, en secondes.
 * @param delay    Attente avant le premier enfant.
 *
 * 55 ms par défaut : au-delà de ~70 ms la cascade devient un spectacle, et la
 * huitième carte se fait attendre. Le total est plafonné par `staggerItem`
 * côté consommateur en limitant le nombre d'éléments animés.
 */
export function staggerContainer(stagger = 0.055, delay = 0): Variants {
  return {
    hidden: { opacity: 1 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: stagger, delayChildren: delay },
    },
  }
}

/** Enfant d'une cascade. Même géométrie que `fadeUp`, pilotée par le parent. */
export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: SPRING.soft },
}

/* -------------------------------------------------------------------------- */
/*  Gestes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Survol d'une carte : 1 % d'agrandissement, 2 px de décollement.
 *
 * 1 %, pas 5 %. Sur une grille de cartes, un agrandissement visible chevauche
 * les voisines et fait vibrer la grille entière. L'élévation (l'ombre) porte
 * l'essentiel du message ; l'échelle ne fait que l'appuyer.
 */
export const HOVER_LIFT = { scale: 1.01, y: -2 } as const

/** Survol d'un bouton ou d'une tuile : échelle seule, sans décollement. */
export const HOVER_SCALE = { scale: 1.02 } as const

/** Pression : l'élément s'enfonce. Retour tactile de l'action. */
export const TAP_PRESS = { scale: 0.98 } as const

/** Pression d'un petit élément (icône, badge) : il faut aller plus bas pour
 *  que l'enfoncement soit perceptible à cette taille. */
export const TAP_PRESS_SMALL = { scale: 0.94 } as const

/* -------------------------------------------------------------------------- */
/*  Observation au défilement                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Réglage de `whileInView`. `once: true` : une section déjà vue ne se rejoue
 * pas quand on remonte — sinon la page clignote à chaque aller-retour.
 * `amount: 0.15` déclenche dès qu'un sixième de l'élément est visible, pour
 * que l'animation soit finie quand l'utilisateur y arrive.
 */
export const IN_VIEW = { once: true, amount: 0.15 } as const
