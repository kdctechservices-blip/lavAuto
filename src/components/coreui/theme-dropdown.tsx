"use client"

import {
  CDropdown,
  CDropdownItem,
  CDropdownMenu,
  CDropdownToggle,
} from "@coreui/react"
import CIcon from "@coreui/icons-react"
import { cilContrast, cilMoon, cilSun } from "@coreui/icons"
import { useTheme } from "@/hooks/use-theme"
import { THEME_OPTIONS, type Theme } from "@/lib/theme"

const ICONS = { light: cilSun, dark: cilMoon, system: cilContrast } as const

/** Sélecteur Clair / Sombre / Système du header CoreUI. */
export function CoreUiThemeDropdown() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  const displayed: Theme = theme === "system" && resolvedTheme ? (resolvedTheme as Theme) : theme
  return (
    <CDropdown variant="nav-item" placement="bottom-end">
      <CDropdownToggle caret={false} aria-label="Choisir le thème" title="Thème">
        <CIcon icon={ICONS[displayed]} size="lg" />
      </CDropdownToggle>
      <CDropdownMenu>
        {THEME_OPTIONS.map((option) => (
          <CDropdownItem
            key={option.value}
            as="button"
            type="button"
            active={theme === option.value}
            className="d-flex align-items-center"
            onClick={() => setTheme(option.value)}
          >
            <CIcon className="me-2" icon={ICONS[option.value]} size="lg" />
            {option.label}
            {option.value === "system" && resolvedTheme && (
              <span className="text-body-secondary small ms-auto ps-3">{resolvedTheme === "dark" ? "sombre" : "clair"}</span>
            )}
          </CDropdownItem>
        ))}
      </CDropdownMenu>
    </CDropdown>
  )
}
