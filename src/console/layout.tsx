import * as React from "react"
import { Link, NavLink, Outlet, useLocation } from "react-router-dom"
import SimpleBar from "simplebar-react"
import {
  Activity,
  ArrowLeftRight,
  LifeBuoy,
  UserCog,
  Users,
  Building2,
  FileClock,
  LayoutDashboard,
  Tags,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from "lucide-react"
import {
  CAvatar,
  CBreadcrumb,
  CBreadcrumbItem,
  CCard,
  CCardBody,
  CCardHeader,
  CCloseButton,
  CContainer,
  CDropdown,
  CDropdownHeader,
  CDropdownItem,
  CDropdownMenu,
  CDropdownToggle,
  CHeader,
  CHeaderNav,
  CHeaderToggler,
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
import CIcon from "@coreui/icons-react"
import { cilAccountLogout, cilMenu, cilUser } from "@coreui/icons"

import { BrandBadge, BrandMark } from "@/components/brand"
import { CoreUiFrame, type CoreUiSidebarState } from "@/components/coreui/coreui-frame"
import { CoreUiThemeDropdown } from "@/components/coreui/theme-dropdown"
import { useConsoleAuth } from "./auth"

interface ConsoleNavItem {
  to: string
  end: boolean
  label: string
  icon: LucideIcon
  adminOnly?: boolean
}

const NAV: ConsoleNavItem[] = [
  { to: "/console", end: true, label: "Vue d'ensemble", icon: LayoutDashboard },
  { to: "/console/stations", end: false, label: "Stations", icon: Building2 },
  { to: "/console/assistance", end: false, label: "Assistance", icon: LifeBuoy },
  { to: "/console/comptes", end: false, label: "Comptes", icon: Users },
  { to: "/console/revenus", end: false, label: "Revenus", icon: TrendingUp },
  { to: "/console/rapprochement", end: false, label: "Rapprochement", icon: ArrowLeftRight },
  { to: "/console/paiements", end: false, label: "Paiements", icon: Wallet },
  { to: "/console/surveillance", end: false, label: "Surveillance", icon: Activity },
  { to: "/console/tarifs", end: false, label: "Tarifs", icon: Tags },
  { to: "/console/operateurs", end: false, label: "Opérateurs", icon: UserCog, adminOnly: true },
  { to: "/console/journal", end: false, label: "Journal", icon: FileClock },
]

function ConsoleSidebar({ visible, unfoldable, onVisibleChange, onToggleUnfoldable }: CoreUiSidebarState) {
  const { pathname } = useLocation()
  const { operator } = useConsoleAuth()
  const navigation = NAV.filter((item) => !item.adminOnly || operator?.role === "admin")
  React.useEffect(() => {
    if (window.matchMedia("(max-width: 991.98px)").matches) onVisibleChange(false)
  }, [pathname, onVisibleChange])

  return (
    <CSidebar
      className="coreui-sidebar border-end"
      colorScheme="dark"
      position="fixed"
      visible={visible}
      unfoldable={unfoldable}
      onVisibleChange={onVisibleChange}
    >
      <CSidebarHeader className="border-bottom">
        <CSidebarBrand as={Link} to="/console">
          <span className="sidebar-brand-full coreui-brand-full">
            <BrandMark height={30} tone="dark" />
            <span className="coreui-station-copy">
              <strong>Console</strong>
              <small>Administration du parc</small>
            </span>
          </span>
          <span className="sidebar-brand-narrow"><BrandBadge height={32} tone="dark" /></span>
        </CSidebarBrand>
        <CCloseButton className="d-lg-none" dark onClick={() => onVisibleChange(false)} aria-label="Fermer la navigation" />
      </CSidebarHeader>
      <CSidebarNav as={SimpleBar} aria-label="Sections de la console">
        <CNavTitle>Administration</CNavTitle>
        {navigation.map((item) => (
          <CNavItem as="div" key={item.to}>
            <CNavLink as={NavLink} to={item.to} end={item.end}>
              <item.icon className="nav-icon" aria-hidden="true" />
              <span>{item.label}</span>
            </CNavLink>
          </CNavItem>
        ))}
      </CSidebarNav>
      <CSidebarFooter className="border-top d-none d-lg-flex">
        <CSidebarToggler onClick={onToggleUnfoldable} aria-label="Réduire ou développer la navigation" />
      </CSidebarFooter>
    </CSidebar>
  )
}

function ConsoleHeader({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const { operator, signOut } = useConsoleAuth()
  const { pathname } = useLocation()
  const current = [...NAV].reverse().find((item) => item.end ? pathname === item.to : pathname.startsWith(item.to))
  const initials = (operator?.email?.slice(0, 2) || "OP").toUpperCase()

  return (
    <CHeader position="sticky" className="coreui-header mb-4 p-0">
      <CContainer className="border-bottom px-4" fluid>
        <CHeaderToggler onClick={onToggleSidebar} style={{ marginInlineStart: "-14px" }} aria-label="Ouvrir ou fermer la navigation">
          <CIcon icon={cilMenu} size="lg" />
        </CHeaderToggler>
        <CHeaderNav className="ms-auto align-items-center">
          <CoreUiThemeDropdown />
          <li className="nav-item py-1"><div className="vr h-100 mx-2 text-body text-opacity-75" /></li>
          <CDropdown variant="nav-item" placement="bottom-end">
            <CDropdownToggle className="py-0 pe-0" caret={false} aria-label="Compte opérateur">
              <CAvatar color="primary" className="text-white" size="md">{initials}</CAvatar>
            </CDropdownToggle>
            <CDropdownMenu className="pt-0">
              <CDropdownHeader className="bg-body-secondary fw-semibold mb-2">
                <span className="d-block text-truncate small fw-normal">{operator?.email ?? "Opérateur"}</span>
              </CDropdownHeader>
              <CDropdownItem as={Link} to={operator?.role === "admin" ? "/console/operateurs" : "/console/comptes"}>
                <CIcon icon={cilUser} className="me-2" />{operator?.role === "admin" ? "Opérateurs" : "Comptes clients"}
              </CDropdownItem>
              <CDropdownItem as="button" type="button" onClick={() => void signOut()}>
                <CIcon icon={cilAccountLogout} className="me-2" />Se déconnecter
              </CDropdownItem>
            </CDropdownMenu>
          </CDropdown>
        </CHeaderNav>
      </CContainer>
      <CContainer className="px-4" fluid>
        <CBreadcrumb className="my-0" aria-label="Fil d'Ariane">
          <CBreadcrumbItem active={!current || current.to === "/console"}>
            {current && current.to !== "/console" ? <Link to="/console">Console</Link> : "Console"}
          </CBreadcrumbItem>
          {current && current.to !== "/console" && <CBreadcrumbItem active>{current.label}</CBreadcrumbItem>}
        </CBreadcrumb>
      </CContainer>
    </CHeader>
  )
}

/** Coquille CoreUI de la console, indépendante de toute station courante. */
export function ConsoleLayout() {
  return (
    <CoreUiFrame
      consoleMode
      renderSidebar={(state) => <ConsoleSidebar {...state} />}
      renderHeader={(toggle) => <ConsoleHeader onToggleSidebar={toggle} />}
    >
      <Outlet />
    </CoreUiFrame>
  )
}

/** Carte de statistique, reprise par plusieurs écrans de la console. */
export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string
  value: React.ReactNode
  hint?: string
  tone?: "default" | "warning" | "danger" | "success"
}) {
  const toneClass = {
    default: "text-body",
    warning: "text-warning",
    danger: "text-danger",
    success: "text-success",
  }[tone]

  return (
    <CCard className="mb-4">
      <CCardBody>
        <p className="text-body-secondary small text-uppercase mb-2">{label}</p>
        <p className={`fs-4 fw-semibold tabular-nums mb-0 ${toneClass}`}>{value}</p>
        {hint && <p className="mt-1 mb-0 small text-body-secondary">{hint}</p>}
      </CCardBody>
    </CCard>
  )
}

/** Panneau standard de la console. */
export function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <CCard className="mb-4">
      <CCardHeader className="d-flex flex-wrap align-items-start justify-content-between gap-2">
        <div>
          <h2 className="fs-6 fw-semibold mb-0">{title}</h2>
          {description && <p className="mt-1 mb-0 small text-body-secondary">{description}</p>}
        </div>
        {action}
      </CCardHeader>
      <CCardBody>{children}</CCardBody>
    </CCard>
  )
}
