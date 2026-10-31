"use client"

import * as React from "react"
import { useLocation } from "react-router-dom"
import { motion } from "framer-motion"

import { AppSidebar } from "@/components/app-sidebar"
import { SearchProvider } from "@/components/command-search"
import { GlobalShortcuts } from "@/components/keyboard-shortcuts"
import { MobileActionBar } from "@/components/mobile-action-bar"
import { SiteHeader } from "@/components/site-header"
import { OfflineIndicator } from "@/components/offline-indicator"
import { SupportButton } from "@/components/support/support-button"
import { TrialBanner } from "@/components/trial/trial-banner"
import { CoreUiFrame } from "@/components/coreui/coreui-frame"
import { rememberVisit, routeLabel } from "@/config/navigation"
import { pageEnter } from "@/lib/motion"

interface BaseLayoutProps {
  children: React.ReactNode
  title?: string
  description?: string
  actions?: React.ReactNode
  hideHeading?: boolean
}

/** Coquille CoreUI des écrans authentifiés de la station. */
export function BaseLayout({ children, title, description, actions, hideHeading = false }: BaseLayoutProps) {
  const { pathname } = useLocation()

  React.useEffect(() => {
    rememberVisit(pathname)
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior })
  }, [pathname])

  const announcement = title && title !== routeLabel(pathname)
    ? `${routeLabel(pathname)} — ${title}`
    : routeLabel(pathname)

  return (
    <SearchProvider>
      <a
        href="#contenu-principal"
        className="sr-only rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[1100]"
      >
        Aller au contenu principal
      </a>

      <CoreUiFrame
        renderSidebar={(state) => <AppSidebar {...state} />}
        renderHeader={(toggleSidebar) => <SiteHeader actions={actions} onToggleSidebar={toggleSidebar} />}
      >
        <div className="@container/main flex flex-1 flex-col">
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {announcement}
          </p>
          <motion.div
            key={pathname}
            variants={pageEnter}
            initial="hidden"
            animate="visible"
            className="coreui-page flex flex-col gap-4 pb-24 md:gap-6 md:pb-6"
          >
            <TrialBanner />
            <OfflineIndicator />
            {title && !hideHeading && (
              <div className="coreui-page-heading">
                <h1>{title}</h1>
                {description && <p>{description}</p>}
              </div>
            )}
            {children}
          </motion.div>
        </div>
      </CoreUiFrame>

      <SupportButton />
      <GlobalShortcuts />
      <MobileActionBar />
    </SearchProvider>
  )
}
