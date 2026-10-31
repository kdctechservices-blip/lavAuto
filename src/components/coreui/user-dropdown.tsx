"use client"

import { Link, useNavigate } from "react-router-dom"
import {
  CAvatar,
  CDropdown,
  CDropdownDivider,
  CDropdownHeader,
  CDropdownItem,
  CDropdownMenu,
  CDropdownToggle,
} from "@coreui/react"
import CIcon from "@coreui/icons-react"
import { cilCreditCard, cilLockLocked, cilUser } from "@coreui/icons"
import { useAuth } from "@/lib/auth"

export function CoreUiUserDropdown() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "Utilisateur"
  const initials = name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()

  async function handleSignOut() {
    try {
      await signOut()
    } finally {
      navigate("/auth/sign-in", { replace: true })
    }
  }

  return (
    <CDropdown variant="nav-item" placement="bottom-end">
      <CDropdownToggle className="py-0 pe-0" caret={false} aria-label={`Compte de ${name}`}>
        <CAvatar color="primary" className="text-white" size="md">{initials}</CAvatar>
      </CDropdownToggle>
      <CDropdownMenu className="pt-0">
        <CDropdownHeader className="bg-body-secondary fw-semibold mb-2">
          <span className="d-block text-truncate">{name}</span>
          <span className="d-block text-truncate small fw-normal">{user?.email ?? ""}</span>
        </CDropdownHeader>
        <CDropdownItem as={Link} to="/settings/account">
          <CIcon icon={cilUser} className="me-2" />Mon compte
        </CDropdownItem>
        <CDropdownItem as={Link} to="/settings/billing">
          <CIcon icon={cilCreditCard} className="me-2" />Abonnement
        </CDropdownItem>
        <CDropdownDivider />
        <CDropdownItem as="button" type="button" onClick={() => void handleSignOut()}>
          <CIcon icon={cilLockLocked} className="me-2" />Se déconnecter
        </CDropdownItem>
      </CDropdownMenu>
    </CDropdown>
  )
}
