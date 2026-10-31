/**
 * Raccourcis clavier — définitions et logique, sans React.
 *
 * Deux règles, apprises à la dure dans les applications de caisse :
 *   1. un raccourci ne se déclenche **jamais** pendant la saisie (une plaque
 *      « AB 1234 » ne doit pas ouvrir les rapports) ;
 *   2. les séquences à deux touches (« g » puis « l ») expirent — sinon un
 *      « g » tapé par erreur transforme la frappe suivante en navigation.
 */

export type ShortcutGroup = "Navigation" | "Actions" | "Recherche"

export interface ShortcutDefinition {
  id: string
  /** Touches affichées, dans l'ordre : ["g", "l"]. */
  keys: string[]
  label: string
  /** Une phrase : ce que fait le raccourci, et dans quel contexte. */
  description: string
  group: ShortcutGroup
  /** Route ouverte, quand le raccourci est une navigation. */
  href?: string
}

export const SHORTCUTS: ShortcutDefinition[] = [
  {
    id: "search",
    keys: ["⌘", "K"],
    label: "Rechercher",
    description: "Ouvre la recherche globale : écrans, actions de la page et pages récentes.",
    group: "Recherche",
  },
  {
    id: "search-slash",
    keys: ["/"],
    label: "Recherche rapide",
    description: "Même recherche, sans quitter le clavier.",
    group: "Recherche",
  },
  {
    id: "help",
    keys: ["?"],
    label: "Aide clavier",
    description: "Affiche la liste complète des raccourcis.",
    group: "Recherche",
  },
  {
    id: "new-wash",
    keys: ["n"],
    label: "Nouveau lavage",
    description: "Ouvre le formulaire de lavage, où que vous soyez.",
    group: "Actions",
    href: "/washes?new=1",
  },
  {
    id: "goto-dashboard",
    keys: ["g", "d"],
    label: "Tableau de bord",
    description: "Revient à l'activité du jour.",
    group: "Navigation",
    href: "/dashboard",
  },
  {
    id: "goto-washes",
    keys: ["g", "l"],
    label: "Lavages",
    description: "Ouvre la liste et le formulaire de lavage.",
    group: "Navigation",
    href: "/washes",
  },
  {
    id: "goto-cash",
    keys: ["g", "c"],
    label: "Caisse",
    description: "Ouvre la session de caisse en cours.",
    group: "Navigation",
    href: "/cash-drawer",
  },
  {
    id: "goto-payments",
    keys: ["g", "p"],
    label: "Encaissements",
    description: "Ouvre le suivi des paiements.",
    group: "Navigation",
    href: "/payments",
  },
  {
    id: "goto-expenses",
    keys: ["g", "x"],
    label: "Dépenses",
    description: "Ouvre les dépenses de la station.",
    group: "Navigation",
    href: "/expenses",
  },
  {
    id: "goto-reports",
    keys: ["g", "r"],
    label: "Rapports",
    description: "Ouvre les rapports de la période.",
    group: "Navigation",
    href: "/reports",
  },
  {
    id: "goto-team",
    keys: ["g", "e"],
    label: "Équipe du jour",
    description: "Ouvre la présence de l'équipe.",
    group: "Navigation",
    href: "/equipe",
  },
  {
    id: "goto-history",
    keys: ["g", "h"],
    label: "Historique",
    description: "Ouvre le journal d'activité.",
    group: "Navigation",
    href: "/history",
  },
]

/** Le focus est-il dans un champ de saisie ? */
export function isTypingTarget(target: EventTarget | null): boolean {
  // Node (tests) n'a pas de DOM : sans ce garde, la fonction lèverait avant
  // même de pouvoir être vérifiée hors navigateur.
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  if (tag === "input" || tag === "textarea" || tag === "select") return true
  if (target.isContentEditable) return true
  if (target.closest("[contenteditable='true']")) return true
  // Les boîtes de dialogue de recherche sont des `div role=combobox`.
  if (target.getAttribute("role") === "combobox") return true
  return false
}

export interface SequenceState {
  /** Première touche déjà frappée (« g »), ou `null`. */
  pending: string | null
  /** Horodatage de la première touche : au-delà de 1,2 s, on abandonne. */
  at: number
}

export const SEQUENCE_TIMEOUT_MS = 1200

/**
 * Résout une frappe contre les séquences de deux touches.
 * Rend la route à ouvrir, ou l'état de séquence à conserver.
 */
export function resolveKey(
  key: string,
  state: SequenceState,
  now = Date.now(),
  shortcuts: ShortcutDefinition[] = SHORTCUTS,
): { href: string | null; state: SequenceState; matchedId: string | null } {
  const pressed = key.toLowerCase()
  const fresh = state.pending !== null && now - state.at <= SEQUENCE_TIMEOUT_MS

  if (fresh && state.pending === "g") {
    const target = shortcuts.find(
      (shortcut) =>
        shortcut.keys.length === 2 &&
        shortcut.keys[0].toLowerCase() === "g" &&
        shortcut.keys[1].toLowerCase() === pressed,
    )
    return {
      href: target?.href ?? null,
      state: { pending: null, at: now },
      matchedId: target?.id ?? null,
    }
  }

  if (pressed === "g") {
    return { href: null, state: { pending: "g", at: now }, matchedId: null }
  }

  const single = shortcuts.find(
    (shortcut) => shortcut.keys.length === 1 && shortcut.keys[0].toLowerCase() === pressed,
  )
  return {
    href: single?.href ?? null,
    state: { pending: null, at: now },
    matchedId: single?.id ?? null,
  }
}

/** Raccourcis groupés, prêts pour le dialogue d'aide. */
export function shortcutGroups(): Array<{
  group: ShortcutGroup
  shortcuts: ShortcutDefinition[]
}> {
  const order: ShortcutGroup[] = ["Actions", "Navigation", "Recherche"]
  return order.map((group) => ({
    group,
    shortcuts: SHORTCUTS.filter((shortcut) => shortcut.group === group),
  }))
}
