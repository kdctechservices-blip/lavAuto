/**
 * Pourquoi une action est indisponible.
 *
 * Un bouton gris qui n'explique rien est un bug d'interface, pas une
 * protection. La question « nouveau lavage grisé, pourquoi ? » venait de là :
 * trois causes sans rapport entre elles — droits pas encore chargés, aucune
 * station, rôle insuffisant — étaient fondues dans un seul `disabled`, et le
 * seul indice était un `title` sur un élément désactivé, que les navigateurs
 * n'affichent le plus souvent pas.
 *
 * Ces fonctions sont **pures** pour être testables sans navigateur : elles
 * reçoivent un état et rendent la cause. L'ordre des causes suit celui dans
 * lequel l'utilisateur les rencontre — on nomme le premier obstacle, pas tous.
 */

export interface BlockedState {
  /** Faut-il désactiver le contrôle ? */
  disabled: boolean
  /** Attente passagère : afficher un indicateur d'activité, jamais un cadenas. */
  preparing: boolean
  /** Refus de droit avéré : le cadenas est alors honnête. */
  denied: boolean
  /** Motif à afficher visiblement. `null` quand il n'y a rien à dire. */
  reason: string | null
}

const READY: BlockedState = { disabled: false, preparing: false, denied: false, reason: null }

export interface WashButtonInput {
  /** La liste des stations est-elle encore en cours de chargement ? */
  sitesLoading: boolean
  /** Les droits (rôle + forfait) sont-ils encore en cours de chargement ? */
  accessLoading: boolean
  /** Nombre de stations actives sur lesquelles enregistrer un lavage. */
  activeSiteCount: number
  /** Le rôle et le forfait autorisent-ils la création ? */
  allowed: boolean
  /** Motif du refus fourni par `useAccess`. */
  reason: string | null
}

/**
 * État du bouton « Nouveau lavage ».
 *
 * Une attente n'est pas un refus : tant que `/me/permissions` n'a pas répondu,
 * on ne sait pas si l'action est permise, et montrer un cadenas revient à
 * affirmer une interdiction qu'on n'a pas vérifiée.
 */
export function washButtonState(input: WashButtonInput): BlockedState {
  if (input.sitesLoading || input.accessLoading) {
    return { disabled: true, preparing: true, denied: false, reason: null }
  }
  if (input.activeSiteCount === 0) {
    return {
      disabled: true,
      preparing: false,
      denied: false,
      reason: "Aucune station active. Créez d'abord une station dans Configuration › Stations.",
    }
  }
  if (!input.allowed) {
    return {
      disabled: true,
      preparing: false,
      denied: true,
      // Un refus sans motif resterait muet : on garantit une phrase.
      reason: input.reason ?? "Vous n'avez pas le droit d'enregistrer un lavage.",
    }
  }
  return READY
}

/**
 * Le bouton doit-il rester cliquable ?
 *
 * Pendant l'attente des droits, **oui**. Griser par précaution punit tout le
 * monde pour une incertitude qui dure une seconde : l'utilisateur voit un
 * bouton mort sans savoir si c'est passager. On le laisse donc actif et on
 * mémorise son clic — c'est le serveur qui refuse pour de bon, de toute façon,
 * et il revérifie chaque permission à chaque requête.
 *
 * Une fois les droits connus, un refus avéré grise franchement : à ce
 * moment-là le cadenas dit quelque chose de vrai.
 */
export function isWashButtonClickable(state: BlockedState): boolean {
  return !state.disabled || state.preparing
}

/** Ce qu'il faut faire d'un clic reçu avant que les droits soient connus. */
export type PendingClickOutcome =
  /** Les droits ne sont pas encore là : garder le clic en mémoire. */
  | "attendre"
  /** Droits connus et favorables : ouvrir le formulaire. */
  | "ouvrir"
  /** Droits connus et défavorables : ne pas ouvrir, le motif est affiché. */
  | "abandonner"

/**
 * Résout un clic mis en attente, une fois les droits arrivés.
 *
 * Volontairement sans effet de bord pour être vérifiable sans navigateur.
 */
export function resolvePendingOpen(state: BlockedState): PendingClickOutcome {
  if (state.preparing) return "attendre"
  return state.disabled ? "abandonner" : "ouvrir"
}

export interface WashSubmitInput {
  allowed: boolean
  accessReason: string | null
  siteId: string
  vehicleCategoryId: string
  selectedServiceCount: number
  /**
   * Combien de laveurs sont affectés à ce lavage.
   *
   * Exigé **au formulaire**, pas au serveur : un lavage rejoué hors ligne ou
   * ressaisi après coup peut légitimement n'avoir personne de nommé. Au
   * comptoir, en revanche, le caissier a le laveur sous les yeux — c'est le
   * seul moment où l'information est encore sûre.
   */
  assignedWorkerCount: number
  /** Le montant reçu est-il exploitable (nombre, et ≤ total) ? */
  amountIsValid: boolean
  /** Cet encaissement exige-t-il une session de caisse ? */
  cashNeedsSession: boolean
  cashSessionLoading: boolean
  hasCashSession: boolean
}

/**
 * Ce qui empêche d'enregistrer le lavage, ou `null` si rien n'empêche.
 *
 * Six conditions cumulées dans un `disabled` muet laissaient l'utilisateur
 * deviner laquelle manquait.
 */
export function washSubmitBlockedReason(input: WashSubmitInput): string | null {
  if (!input.allowed) {
    return input.accessReason ?? "Vous n'avez pas le droit d'enregistrer un lavage."
  }
  if (!input.siteId) return "Choisissez une station."
  if (!input.vehicleCategoryId) return "Choisissez une catégorie de véhicule."
  if (input.selectedServiceCount === 0) return "Sélectionnez au moins une prestation."
  if (input.assignedWorkerCount === 0) {
    return "Indiquez qui lave ce véhicule."
  }
  if (!input.amountIsValid) {
    return "Le montant reçu doit être un nombre, et ne peut pas dépasser le total du lavage."
  }
  if (input.cashNeedsSession && input.cashSessionLoading) {
    return "Vérification de la session de caisse en cours…"
  }
  if (input.cashNeedsSession && !input.hasCashSession) {
    return "Un encaissement en espèces exige une session de caisse ouverte."
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Porte générique, pour tous les écrans
 * ------------------------------------------------------------------ */

export interface ActionGateInput {
  /** Les droits (rôle + forfait) sont-ils encore en cours de chargement ? */
  loading: boolean
  allowed: boolean
  /** Motif du refus fourni par `useAccess`. */
  reason: string | null
  /**
   * Obstacle propre à l'écran, évalué une fois les droits connus : quota
   * atteint, ligne déjà en cours de traitement, prérequis manquant. Porte son
   * propre motif, car l'utilisateur n'a pas à deviner lequel des deux joue.
   */
  blockedBy?: string | null
  /**
   * L'action écrit-elle immédiatement, sans étape intermédiaire ?
   *
   * La distinction change le traitement de l'attente :
   *   • **ouverture d'un formulaire** (défaut) : on reste cliquable pendant
   *     le chargement. Rien n'est écrit, et griser pour une incertitude d'une
   *     seconde punit tout le monde.
   *   • **écriture immédiate** (`true`) : on attend de connaître les droits.
   *     Laisser partir une requête vouée au 403 ne gagne rien et fait
   *     apparaître une erreur que l'utilisateur n'a pas provoquée.
   */
  writesImmediately?: boolean
}

export interface ActionGate {
  disabled: boolean
  /** Attente en cours : indicateur d'activité, jamais de cadenas. */
  busy: boolean
  /** Refus de droit avéré : le cadenas est alors honnête. */
  denied: boolean
  /** Motif à afficher visiblement. */
  reason: string | null
}

/**
 * État d'une action soumise à un droit.
 *
 * Même principe que `washButtonState`, généralisé aux autres écrans : on ne
 * confond pas une attente avec un refus, et tout état désactivé hors attente
 * porte un motif affichable.
 */
export function actionGate(input: ActionGateInput): ActionGate {
  if (input.loading) {
    return {
      disabled: input.writesImmediately === true,
      busy: true,
      denied: false,
      reason: null,
    }
  }
  if (!input.allowed) {
    return {
      disabled: true,
      busy: false,
      denied: true,
      reason: input.reason ?? "Vous n'avez pas le droit d'effectuer cette action.",
    }
  }
  if (input.blockedBy) {
    return { disabled: true, busy: false, denied: false, reason: input.blockedBy }
  }
  return { disabled: false, busy: false, denied: false, reason: null }
}


/* ------------------------------------------------------------------ *
 * Mise en route : ce qu'il faut avoir avant de pouvoir vendre
 * ------------------------------------------------------------------ */

export interface WashPrerequisiteInput {
  activeSiteCount: number
  activeServiceCount: number
  activeWorkerCount: number
}

/** Un prérequis manquant, et l'écran où le créer. */
export interface WashPrerequisite {
  /** Ce qui manque, dit comme au comptoir. */
  label: string
  /** Pourquoi c'est nécessaire. */
  why: string
  /** Où aller le créer. */
  to: string
  /** Libellé du lien. */
  action: string
}

/**
 * Ce qui manque encore pour pouvoir enregistrer un lavage.
 *
 * Une station neuve n'a ni station, ni prestation, ni employé. Le bouton
 * « Nouveau lavage » est alors grisé à juste titre — mais un bouton gris ne
 * dit pas quoi faire, et le gérant conclut que le logiciel est cassé. On
 * énumère donc les manques dans l'ordre où on les règle, chacun avec son
 * lien : la mise en route devient une liste à cocher, pas une devinette.
 */
export function washPrerequisites(input: WashPrerequisiteInput): WashPrerequisite[] {
  const missing: WashPrerequisite[] = []
  if (input.activeSiteCount === 0) {
    missing.push({
      label: "Aucune station",
      why: "C'est le lieu où la vente est encaissée.",
      to: "/sites",
      action: "Créer une station",
    })
  }
  if (input.activeServiceCount === 0) {
    missing.push({
      label: "Aucune prestation au catalogue",
      why: "C'est elle qui porte le prix appliqué au client.",
      to: "/services",
      action: "Ajouter une prestation",
    })
  }
  if (input.activeWorkerCount === 0) {
    missing.push({
      label: "Aucun employé actif",
      why: "Chaque lavage doit dire qui l'a fait.",
      to: "/team",
      action: "Ajouter un employé",
    })
  }
  return missing
}
