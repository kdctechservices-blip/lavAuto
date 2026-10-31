import type { LucideIcon } from "lucide-react"
import {
  BarChart3,
  BadgeCheck,
  Building2,
  ClipboardList,
  Clock,
  CreditCard,
  Database,
  Droplets,
  Gauge,
  History,
  LayoutPanelLeft,
  List,
  Package,
  Receipt,
  Settings,
  ShieldCheck,
  TrendingUp,
  Truck,
  UserCheck,
  Users,
  Wallet,
} from "lucide-react"

/**
 * Référentiel de navigation — source unique.
 *
 * Trois endroits parlaient jusqu'ici des mêmes écrans sans se connaître : la
 * barre latérale, le fil d'Ariane de l'en-tête et la recherche globale. Leurs
 * libellés avaient déjà divergé (« Nouveau lavage » ici, « Lavages » là), et
 * une route ajoutée dans l'un restait invisible dans l'autre.
 *
 * Ce fichier ne remplace pas la barre latérale — ses entrées y restent, avec
 * leurs permissions — il fixe le vocabulaire : un écran, un libellé, une
 * section, un fil d'Ariane. `tests/navigation.test.ts` garde les deux alignés.
 *
 * Vocabulaire métier imposé partout :
 *   • **lavage** (jamais « wash » ni « ticket ») ;
 *   • **station** (jamais « site » ni « boutique ») ;
 *   • **session de caisse** (jamais « shift » ni « drawer »).
 */

export type NavSection = "Opérations" | "Équipe" | "Finance" | "Configuration" | "Aide"

/** Sections de la barre latérale, dans l'ordre d'affichage. */
export const NAV_SECTIONS: NavSection[] = ["Opérations", "Équipe", "Finance", "Configuration"]

export const SECTION_DESCRIPTIONS: Partial<Record<NavSection, string>> = {
  Opérations: "Lavages, stock, achats, rapports et historique de la station.",
  Équipe: "Présence, horaires, rendement et fiches des employés.",
  Finance: "Encaissements, session de caisse et dépenses.",
  Configuration: "Stations, catalogue, accès et paramètres du compte.",
  Aide: "Assistance et ressources.",
}

/** Première page proposée pour une section — sert au fil d'Ariane. */
export const SECTION_LANDING: Record<NavSection, string> = {
  Opérations: "/dashboard",
  Équipe: "/equipe",
  Finance: "/payments",
  Configuration: "/sites",
  Aide: "/support",
}

export interface RouteMeta {
  /** Libellé unique de l'écran, utilisé partout. */
  label: string
  section: NavSection
  icon: LucideIcon
  /** Rubrique intermédiaire du fil d'Ariane (« Catalogue », « Paramètres »). */
  parent?: { label: string; href: string }
  /** Phrase courte affichée dans la recherche globale et les infobulles. */
  description?: string
  /** Ce que l'écran permet de faire — commandes contextuelles. */
  primaryAction?: { label: string; href: string }
}

export const ROUTE_META: Record<string, RouteMeta> = {
  "/dashboard": {
    label: "Tableau de bord",
    section: "Opérations",
    icon: LayoutPanelLeft,
    description: "Activité du jour, recettes et état de la station.",
  },
  "/washes": {
    label: "Lavages",
    section: "Opérations",
    icon: Droplets,
    description: "Enregistrer un lavage et consulter l'historique récent.",
    primaryAction: { label: "Nouveau lavage", href: "/washes?new=1" },
  },
  "/washes/:washID": {
    label: "Détail du lavage",
    section: "Opérations",
    icon: Droplets,
    parent: { label: "Lavages", href: "/washes" },
    description: "Prestations, paiements et statut d'un lavage.",
  },
  "/payments": {
    label: "Encaissements",
    section: "Finance",
    icon: BadgeCheck,
    description: "Suivi des paiements espèces et mobile money.",
    primaryAction: { label: "Voir les lavages", href: "/washes" },
  },
  "/cash-drawer": {
    label: "Caisse",
    section: "Finance",
    icon: Wallet,
    description: "Session de caisse, mouvements et clôture.",
    primaryAction: { label: "Ouvrir les lavages", href: "/washes" },
  },
  "/expenses": {
    label: "Dépenses",
    section: "Finance",
    icon: Receipt,
    description: "Enregistrer et suivre les dépenses de la station.",
  },
  "/compteurs": {
    label: "Compteurs",
    section: "Finance",
    icon: Gauge,
    description: "Relevés CIE/SODECI, consommations et factures liées.",
  },
  "/reports": {
    label: "Rapports",
    section: "Opérations",
    icon: BarChart3,
    description: "Chiffre d'affaires, dépenses et marges par période.",
  },
  "/history": {
    label: "Historique",
    section: "Opérations",
    icon: History,
    description: "Journal d'activité : qui a fait quoi, et quand.",
  },
  "/stock": {
    label: "Stock",
    section: "Opérations",
    icon: Package,
    description: "Produits, seuils d'alerte et mouvements de stock.",
  },
  "/achats": {
    label: "Achats",
    section: "Opérations",
    icon: Truck,
    description: "Commandes fournisseurs et réceptions.",
  },
  "/equipe": {
    label: "Équipe du jour",
    section: "Équipe",
    icon: UserCheck,
    description: "Qui est présent, et depuis quand.",
  },
  "/horaires": {
    label: "Horaires",
    section: "Équipe",
    icon: Clock,
    description: "Planning hebdomadaire de l'équipe.",
  },
  "/rendement": {
    label: "Rendement",
    section: "Équipe",
    icon: TrendingUp,
    description: "Lavages et recettes par employé.",
  },
  "/team": {
    label: "Équipe",
    section: "Équipe",
    icon: Users,
    description: "Fiches des employés de la station.",
  },
  "/services": {
    label: "Prestations",
    section: "Configuration",
    icon: List,
    parent: { label: "Catalogue", href: "/services" },
    description: "Tarifs et prestations proposées aux clients.",
  },
  "/service-categories": {
    label: "Catégories de prestations",
    section: "Configuration",
    icon: ClipboardList,
    parent: { label: "Catalogue", href: "/services" },
  },
  "/vehicle-categories": {
    label: "Catégories de véhicules",
    section: "Configuration",
    icon: Truck,
    parent: { label: "Catalogue", href: "/services" },
  },
  "/sites": {
    label: "Stations",
    section: "Configuration",
    icon: Building2,
    description: "Stations de lavage de l'organisation.",
  },
  "/settings/access": {
    label: "Gestion des accès",
    section: "Configuration",
    icon: ShieldCheck,
    description: "Rôles et permissions des utilisateurs.",
  },
  "/settings/account": {
    label: "Compte",
    section: "Configuration",
    icon: Settings,
    parent: { label: "Paramètres", href: "/settings/account" },
    description: "Profil, mot de passe et préférences.",
  },
  "/settings/billing": {
    label: "Facturation",
    section: "Configuration",
    icon: CreditCard,
    parent: { label: "Paramètres", href: "/settings/account" },
    description: "Forfait, factures et moyens de paiement.",
  },
  "/settings/data": {
    label: "Données et sauvegarde",
    section: "Configuration",
    icon: Database,
    parent: { label: "Paramètres", href: "/settings/account" },
    description: "Export et sauvegarde des données.",
  },
  "/support": {
    label: "Assistance",
    section: "Aide",
    icon: ClipboardList,
    description: "Signaler un problème ou poser une question.",
  },
  "/onboarding": {
    label: "Configuration initiale",
    section: "Configuration",
    icon: Settings,
    description: "Assistant de mise en route de la station.",
  },
}

export interface Crumb {
  label: string
  /** Absent sur le dernier maillon : la page courante n'est pas un lien. */
  href?: string
}

/** Route connue, ou `null`. Gère les routes de détail (`/washes/:washID`). */
export function matchRoute(pathname: string): { path: string; meta: RouteMeta } | null {
  const clean = pathname.split("?")[0].split("#")[0].replace(/\/+$/, "") || "/"
  if (ROUTE_META[clean]) return { path: clean, meta: ROUTE_META[clean] }
  // `/washes/abc-123` → `/washes/:washID`
  if (/^\/washes\/[^/]+$/.test(clean)) {
    return { path: "/washes/:washID", meta: ROUTE_META["/washes/:washID"] }
  }
  return null
}

/** Libellé d'un écran, même inconnu : « Tableau de bord », « Lavages »… */
export function routeLabel(pathname: string): string {
  const match = matchRoute(pathname)
  if (match) return match.meta.label
  const last = pathname.split("/").filter(Boolean).pop() ?? "Espace de travail"
  return last.charAt(0).toUpperCase() + last.slice(1).replace(/-/g, " ")
}

export function sectionOf(pathname: string): NavSection {
  return matchRoute(pathname)?.meta.section ?? "Opérations"
}

/**
 * Fil d'Ariane complet : Accueil › Section › [Rubrique] › Page.
 *
 * Le doublon « Accueil › Opérations › Opérations » est évité quand un écran
 * porte le nom de sa section (Équipe, Dépenses n'est pas concerné).
 */
export function breadcrumbsFor(pathname: string): Crumb[] {
  const match = matchRoute(pathname)
  const crumbs: Crumb[] = [{ label: "Accueil", href: "/dashboard" }]
  if (!match) {
    crumbs.push({ label: routeLabel(pathname) })
    return crumbs
  }

  const { meta } = match
  crumbs.push({ label: meta.section, href: SECTION_LANDING[meta.section] })
  if (meta.parent && meta.parent.label !== meta.section) {
    crumbs.push(meta.parent)
  }
  if (meta.label !== meta.section) {
    crumbs.push({ label: meta.label })
  } else {
    // La page EST la section : le dernier maillon doit rester non cliquable.
    crumbs[crumbs.length - 1] = { label: meta.label }
  }
  return crumbs
}

// ---------------------------------------------------------------------------
// Mémoire de navigation
//
// « Conserver la dernière section visitée » ne veut pas dire rouvrir l'écran
// précédent à la place de celui demandé : cela veut dire que l'application
// sait, sans le redemander, où l'utilisateur travaillait. On s'en sert pour la
// rubrique « Reprendre » de la barre latérale et pour les résultats récents de
// la recherche globale (⌘K).
// ---------------------------------------------------------------------------

export const LAST_ROUTE_KEY = "washpilot:last-visited-route"
export const LAST_SECTION_KEY = "washpilot:last-visited-section"
export const RECENT_ROUTES_KEY = "washpilot:recent-routes"

const RECENT_LIMIT = 5

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Stockage plein ou bloqué : la mémoire de navigation est un confort,
    // jamais une condition de fonctionnement.
  }
}

/** Enregistre la visite courante (route + section). */
export function rememberVisit(pathname: string) {
  if (!pathname || pathname.startsWith("/auth/") || pathname === "/") return
  const clean = pathname.split("?")[0]
  write(LAST_ROUTE_KEY, clean)
  write(LAST_SECTION_KEY, sectionOf(clean))

  const recent = recentVisits().filter((route) => route !== clean)
  recent.unshift(clean)
  write(RECENT_ROUTES_KEY, JSON.stringify(recent.slice(0, RECENT_LIMIT)))
}

/** Routes récemment visitées, la plus récente d'abord. */
export function recentVisits(): string[] {
  const raw = read(RECENT_ROUTES_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.startsWith("/"))
      : []
  } catch {
    return []
  }
}

/**
 * Page visitée juste avant `pathname` — c'est elle que « Reprendre » propose.
 * On lit la liste récente plutôt qu'une seconde clé : une seule source de
 * vérité, donc pas de valeur orpheline après un nettoyage du stockage.
 */
export function previousVisit(pathname: string) {
  const clean = pathname.split("?")[0]
  return recentVisits().find((route) => route !== clean) ?? null
}

/** Dernière route visitée, si elle diffère de la page courante. */
export function lastVisit(): { path: string; label: string; section: NavSection } | null {
  const path = read(LAST_ROUTE_KEY)
  if (!path || !matchRoute(path)) return null
  return { path, label: routeLabel(path), section: sectionOf(path) }
}

/** Dernière section visitée, pour rouvrir le bon groupe de la barre latérale. */
export function lastSection(): NavSection | null {
  const raw = read(LAST_SECTION_KEY)
  return raw && NAV_SECTIONS.includes(raw as NavSection) ? (raw as NavSection) : null
}

// ---------------------------------------------------------------------------
// Commandes contextuelles
// ---------------------------------------------------------------------------

export interface ContextCommand {
  label: string
  href: string
  hint?: string
  icon: LucideIcon
}

/**
 * Raccourcis proposés dans ⌘K **selon l'écran**. Une recherche globale qui
 * propose toujours la même liste ne fait pas gagner de temps ; celle-ci
 * propose l'étape suivante du travail en cours.
 */
const CONTEXT_COMMANDS: Record<string, ContextCommand[]> = {
  "/dashboard": [
    { label: "Enregistrer un lavage", href: "/washes?new=1", hint: "Action du jour", icon: Droplets },
    { label: "Ouvrir une session de caisse", href: "/cash-drawer", hint: "Finance", icon: Wallet },
    { label: "Vérifier les encaissements", href: "/payments", hint: "Finance", icon: BadgeCheck },
  ],
  "/washes": [
    { label: "Ouvrir la caisse", href: "/cash-drawer", hint: "Session en cours", icon: Wallet },
    { label: "Vérifier les encaissements", href: "/payments", hint: "Mobile money", icon: BadgeCheck },
    { label: "Voir les rapports du jour", href: "/reports", hint: "Chiffre d'affaires", icon: BarChart3 },
  ],
  "/washes/:washID": [
    { label: "Retour aux lavages", href: "/washes", hint: "Liste", icon: Droplets },
    { label: "Vérifier les encaissements", href: "/payments", hint: "Paiement", icon: BadgeCheck },
  ],
  "/cash-drawer": [
    { label: "Voir les lavages du jour", href: "/washes", hint: "Opérations", icon: Droplets },
    { label: "Ajouter une dépense", href: "/expenses", hint: "Finance", icon: Receipt },
  ],
  "/payments": [
    { label: "Ouvrir la caisse", href: "/cash-drawer", hint: "Session en cours", icon: Wallet },
    { label: "Lavages non payés", href: "/washes", hint: "À encaisser", icon: Droplets },
  ],
  "/expenses": [
    { label: "Relever les compteurs", href: "/compteurs", hint: "CIE & SODECI", icon: Gauge },
    { label: "Voir les rapports", href: "/reports", hint: "Dépenses de la période", icon: BarChart3 },
    { label: "Ouvrir la caisse", href: "/cash-drawer", hint: "Solde théorique", icon: Wallet },
  ],
  "/compteurs": [
    { label: "Voir les dépenses", href: "/expenses", hint: "Factures comptabilisées", icon: Receipt },
    { label: "Voir les rapports", href: "/reports", hint: "Charges mensuelles", icon: BarChart3 },
  ],
  "/equipe": [
    { label: "Modifier les horaires", href: "/horaires", hint: "Planning", icon: Clock },
    { label: "Voir le rendement", href: "/rendement", hint: "Par employé", icon: TrendingUp },
  ],
  "/team": [
    { label: "Voir l'équipe du jour", href: "/equipe", hint: "Présence", icon: UserCheck },
    { label: "Modifier les horaires", href: "/horaires", hint: "Planning", icon: Clock },
  ],
  "/stock": [
    { label: "Enregistrer un achat", href: "/achats", hint: "Réapprovisionnement", icon: Truck },
    { label: "Voir les rapports", href: "/reports", hint: "Coûts", icon: BarChart3 },
  ],
  "/history": [
    { label: "Voir les rapports", href: "/reports", hint: "Synthèse chiffrée", icon: BarChart3 },
    { label: "Retour au tableau de bord", href: "/dashboard", hint: "Opérations", icon: LayoutPanelLeft },
  ],
}

export function contextualCommands(pathname: string): ContextCommand[] {
  const match = matchRoute(pathname)
  return CONTEXT_COMMANDS[match?.path ?? pathname] ?? []
}
