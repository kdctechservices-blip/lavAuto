"use client"

import * as React from "react"
import { CContainer, CFooter } from "@coreui/react"
import { useTheme } from "@/hooks/use-theme"

export interface CoreUiSidebarState {
  visible: boolean
  unfoldable: boolean
  onVisibleChange: (visible: boolean) => void
  onToggleUnfoldable: () => void
}

interface CoreUiFrameProps {
  renderSidebar: (state: CoreUiSidebarState) => React.ReactNode
  renderHeader: (toggleSidebar: () => void) => React.ReactNode
  children: React.ReactNode
  consoleMode?: boolean
}

/** Coquille commune du template CoreUI : sidebar fixe, wrapper et contenu fluide. */
export function CoreUiFrame({ renderSidebar, renderHeader, children, consoleMode = false }: CoreUiFrameProps) {
  const [visible, setVisible] = React.useState(true)
  const [unfoldable, setUnfoldable] = React.useState(false)
  const { resolvedTheme } = useTheme()

  React.useEffect(() => {
    const root = document.documentElement
    root.dataset.coreuiTheme = resolvedTheme === "dark" ? "dark" : "light"
    return () => {
      delete root.dataset.coreuiTheme
    }
  }, [resolvedTheme])

  return (
    <div className={consoleMode ? "coreui-app coreui-console" : "coreui-app"}>
      {renderSidebar({
        visible,
        unfoldable,
        onVisibleChange: setVisible,
        onToggleUnfoldable: () => setUnfoldable((current) => !current),
      })}
      <div className="wrapper d-flex flex-column min-vh-100">
        {renderHeader(() => setVisible((current) => !current))}
        <main id="contenu-principal" tabIndex={-1} className="body flex-grow-1 outline-none">
          <CContainer lg className="coreui-content px-4">
            {children}
          </CContainer>
        </main>
        <CoreUiFooter consoleMode={consoleMode} />
      </div>
    </div>
  )
}

export function CoreUiFooter({ consoleMode = false }: { consoleMode?: boolean }) {
  return (
    <CFooter className="coreui-footer px-4">
      <div>
        <span className="fw-semibold">WashPilot CI</span>
        <span className="ms-1">© 2026{consoleMode ? " — Console éditeur" : ""}.</span>
      </div>
      <div className="ms-auto">
        <span className="me-1">Interface d’administration</span>
        <a href="https://coreui.io/react" target="_blank" rel="noopener noreferrer">
          CoreUI React
        </a>
      </div>
    </CFooter>
  )
}
