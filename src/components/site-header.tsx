"use client"

import * as React from "react"
import { Link, useLocation } from "react-router-dom"
import {
  CBreadcrumb,
  CBreadcrumbItem,
  CContainer,
  CHeader,
  CHeaderNav,
  CHeaderToggler,
  CNavItem,
  CSearchButton,
} from "@coreui/react"
import CIcon from "@coreui/icons-react"
import { cilMenu } from "@coreui/icons"

import { useSearch } from "@/components/command-search"
import { NewWashButton } from "@/components/actions/new-wash-button"
import { NotificationCenter, SyncStatus } from "@/components/notifications/notification-center"
import { CoreUiThemeDropdown } from "@/components/coreui/theme-dropdown"
import { CoreUiUserDropdown } from "@/components/coreui/user-dropdown"
import { breadcrumbsFor } from "@/config/navigation"

export function SiteHeader({
  actions,
  onToggleSidebar,
}: {
  actions?: React.ReactNode
  onToggleSidebar: () => void
}) {
  const { pathname } = useLocation()
  const { openSearch } = useSearch()
  const crumbs = breadcrumbsFor(pathname)
  const headerRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const handleScroll = () => {
      headerRef.current?.classList.toggle("shadow-sm", document.documentElement.scrollTop > 0)
    }
    document.addEventListener("scroll", handleScroll)
    return () => document.removeEventListener("scroll", handleScroll)
  }, [])

  return (
    <CHeader position="sticky" className="coreui-header mb-4 p-0" ref={headerRef}>
      <CContainer className="border-bottom px-4" fluid>
        <CHeaderToggler
          onClick={onToggleSidebar}
          style={{ marginInlineStart: "-14px" }}
          aria-label="Ouvrir ou fermer la navigation"
        >
          <CIcon icon={cilMenu} size="lg" />
        </CHeaderToggler>
        <CSearchButton
          onTrigger={openSearch}
          aria-label="Rechercher"
          aria-keyshortcuts="Control+K Meta+K"
        />

        <CHeaderNav className="ms-auto align-items-center">
          {actions && <CNavItem className="d-flex align-items-center gap-2">{actions}</CNavItem>}
          <CNavItem className="d-flex align-items-center"><SyncStatus /></CNavItem>
          <CNavItem className="d-none d-sm-flex"><NewWashButton /></CNavItem>
          <CNavItem className="d-flex align-items-center"><NotificationCenter /></CNavItem>
          <li className="nav-item py-1"><div className="vr h-100 mx-2 text-body text-opacity-75" /></li>
          <CoreUiThemeDropdown />
          <li className="nav-item py-1"><div className="vr h-100 mx-2 text-body text-opacity-75" /></li>
          <CoreUiUserDropdown />
        </CHeaderNav>
      </CContainer>

      <CContainer className="coreui-breadcrumb-container px-4" fluid>
        <CBreadcrumb className="my-0" aria-label="Fil d'Ariane">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1
            return (
              <CBreadcrumbItem key={`${crumb.label}-${index}`} active={last}>
                {last || !crumb.href
                  ? crumb.label
                  : <Link to={crumb.href} viewTransition>{crumb.label}</Link>}
              </CBreadcrumbItem>
            )
          })}
        </CBreadcrumb>
      </CContainer>
    </CHeader>
  )
}
