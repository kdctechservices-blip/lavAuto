"use client"

import * as React from "react"
import {
  LayoutPanelLeft,
  Settings,
  Wallet,
  Receipt,
  BarChart3,
  Users,
  List,
  BadgeCheck,
  ShieldCheck,
  History,
  Building2,
  Package,
  Truck,
  UserCheck,
  TrendingUp,
  Clock,
  Droplets,
  Gauge,
  RotateCcw,
} from "lucide-react"
import { Link, NavLink, useLocation } from "react-router-dom"
import SimpleBar from "simplebar-react"
import {
  CCloseButton,
  CNavGroup,
  CNavItem,
  CNavLink,
  CNavTitle,
  CSidebar,
  CSidebarBrand,
  CSidebarFooter,
  CSidebarHeader,
  CSidebarNav,
  CSidebarToggler,
} from "@coreui/react"

import { BrandBadge, BrandMark } from "@/components/brand"
import { TrialCountdown } from "@/components/trial/trial-countdown"
import type { CoreUiSidebarState } from "@/components/coreui/coreui-frame"
import { previousVisit, routeLabel } from "@/config/navigation"
import { useOnboardingStatus } from "@/lib/onboarding-api"
import { usePermissions, type Permission } from "@/lib/permissions"

/** Navigation métier, filtrée par les permissions effectives du compte. */
const NAV_GROUPS = [
  {
    label: "Opérations",
    items: [
      { title: "Tableau de bord", url: "/dashboard", icon: LayoutPanelLeft, permission: "dashboard:read" as Permission },
      { title: "Lavages", url: "/washes", icon: Droplets, permission: "wash:read" as Permission },
      { title: "Stock", url: "/stock", icon: Package, permission: "stock:read" as Permission },
      { title: "Achats", url: "/achats", icon: Truck, permission: "purchase:manage" as Permission },
      { title: "Rapports", url: "/reports", icon: BarChart3, permission: "report:operational" as Permission },
      { title: "Historique", url: "/history", icon: History, permission: "audit:read" as Permission },
    ],
  },
  {
    label: "Équipe",
    items: [
      { title: "Équipe du jour", url: "/equipe", icon: UserCheck, permission: "attendance:read" as Permission },
      { title: "Horaires", url: "/horaires", icon: Clock, permission: "attendance:read" as Permission },
      { title: "Rendement", url: "/rendement", icon: TrendingUp, permission: "attendance:read" as Permission },
      { title: "Équipe", url: "/team", icon: Users, permission: "worker:read" as Permission },
    ],
  },
  {
    label: "Finance",
    items: [
      { title: "Encaissements", url: "/payments", icon: BadgeCheck, permission: "payment:read" as Permission },
      { title: "Caisse", url: "/cash-drawer", icon: Wallet, permission: "cash_session:read" as Permission },
      { title: "Dépenses", url: "/expenses", icon: Receipt, permission: "expense:read" as Permission },
      { title: "Compteurs", url: "/compteurs", icon: Gauge, permission: "expense:read" as Permission },
    ],
  },
  {
    label: "Configuration",
    items: [
      { title: "Stations", url: "/sites", icon: Building2, permission: "settings:manage" as Permission },
      { title: "Gestion des accès", url: "/settings/access", icon: ShieldCheck, permission: "user:manage" as Permission },
      {
        title: "Catalogue",
        url: "#",
        icon: List,
        permission: "service:read" as Permission,
        items: [
          { title: "Prestations", url: "/services" },
          { title: "Catégories de prestations", url: "/service-categories" },
          { title: "Catégories de véhicules", url: "/vehicle-categories" },
        ],
      },
      {
        title: "Paramètres",
        url: "#",
        icon: Settings,
        items: [
          { title: "Compte", url: "/settings/account" },
          { title: "Facturation", url: "/settings/billing", permission: "subscription:manage" as Permission },
          { title: "Données et sauvegarde", url: "/settings/data", permission: "data:export" as Permission },
        ],
      },
    ],
  },
]

type NavEntry = {
  title: string
  url: string
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>
  permission?: Permission
  items?: NavEntry[]
}

function filterNav(items: NavEntry[], can: (permission: Permission) => boolean): NavEntry[] {
  return items
    .filter((item) => !item.permission || can(item.permission))
    .map((item) => (item.items ? { ...item, items: filterNav(item.items, can) } : item))
    .filter((item) => !item.items || item.items.length > 0 || item.url !== "#")
}

function Entry({ item, indent = false }: { item: NavEntry; indent?: boolean }) {
  const Icon = item.icon
  const content = (
    <>
      {Icon
        ? <Icon className="nav-icon" aria-hidden="true" />
        : indent
          ? <span className="nav-icon"><span className="nav-icon-bullet" /></span>
          : null}
      <span>{item.title}</span>
    </>
  )
  if (item.items?.length) {
    return (
      <CNavGroup compact as="div" toggler={content}>
        {item.items.map((child) => <Entry key={`${child.title}-${child.url}`} item={child} indent />)}
      </CNavGroup>
    )
  }
  if (item.url === "#") return null
  return (
    <CNavItem as="div">
      <CNavLink as={NavLink} to={item.url} viewTransition>
        {content}
      </CNavLink>
    </CNavItem>
  )
}

function ResumeLastPage() {
  const { pathname } = useLocation()
  const resumePath = previousVisit(pathname)
  if (!resumePath) return null
  return (
    <>
      <CNavTitle>Reprendre</CNavTitle>
      <Entry item={{ title: routeLabel(resumePath), url: resumePath, icon: RotateCcw }} />
    </>
  )
}

export function AppSidebar({ visible, unfoldable, onVisibleChange, onToggleUnfoldable }: CoreUiSidebarState) {
  const { data: status } = useOnboardingStatus()
  const { can, loading: permissionsLoading } = usePermissions()
  const { pathname } = useLocation()
  const stationName = status?.station?.name ?? status?.org_name ?? "WashPilot CI"
  const stationCity = status?.station?.city ?? "Gestion de station de lavage"

  React.useEffect(() => {
    if (window.matchMedia("(max-width: 991.98px)").matches) onVisibleChange(false)
  }, [pathname, onVisibleChange])

  return (
    <CSidebar
      className="coreui-sidebar border-end"
      colorScheme="dark"
      position="fixed"
      unfoldable={unfoldable}
      visible={visible}
      onVisibleChange={onVisibleChange}
    >
      <CSidebarHeader className="border-bottom">
        <CSidebarBrand as={Link} to="/dashboard" viewTransition>
          <span className="sidebar-brand-full coreui-brand-full">
            <BrandMark height={30} tone="dark" />
            <span className="coreui-station-copy">
              <strong>{stationName}</strong>
              <small>{stationCity}</small>
            </span>
          </span>
          <span className="sidebar-brand-narrow"><BrandBadge height={32} tone="dark" /></span>
        </CSidebarBrand>
        <CCloseButton className="d-lg-none" dark onClick={() => onVisibleChange(false)} aria-label="Fermer la navigation" />
      </CSidebarHeader>

      <CSidebarNav as={SimpleBar} aria-label="Navigation principale">
        {!permissionsLoading && NAV_GROUPS.map((group) => {
          const items = filterNav(group.items as NavEntry[], can)
          if (!items.length) return null
          return (
            <React.Fragment key={group.label}>
              <CNavTitle>{group.label}</CNavTitle>
              {items.map((item) => <Entry key={`${item.title}-${item.url}`} item={item} />)}
            </React.Fragment>
          )
        })}
        {!permissionsLoading && <ResumeLastPage />}
      </CSidebarNav>

      <div className="coreui-trial px-3 pb-3"><TrialCountdown /></div>
      <CSidebarFooter className="border-top d-none d-lg-flex">
        <CSidebarToggler onClick={onToggleUnfoldable} aria-label="Réduire ou développer la navigation" />
      </CSidebarFooter>
    </CSidebar>
  )
}
