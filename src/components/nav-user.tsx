"use client"

import {
  CreditCard,
  EllipsisVertical,
  LogOut,
  CircleUser,
} from "lucide-react"
import { Link, useNavigate } from "react-router-dom"
import { useAuth } from "@/lib/auth"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

export function NavUser({
  user: initialUser,
}: {
  user?: {
    name: string
    email: string
    avatar: string
  }
}) {
  const { isMobile } = useSidebar()
  const { signOut, user } = useAuth()
  const navigate = useNavigate()

  const displayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    initialUser?.name ||
    "Utilisateur"
  const displayEmail = user?.email || initialUser?.email || ""

  const handleSignOut = async () => {
    try {
      await signOut()
    } finally {
      navigate("/auth/sign-in", { replace: true })
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground cursor-pointer"
              />
            }
          >
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <CircleUser className="size-5" aria-hidden />
            </div>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{displayName}</span>
              <span className="text-muted-foreground truncate text-xs">
                {displayEmail}
              </span>
            </div>
            <EllipsisVertical className="ml-auto size-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--anchor-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal text-foreground">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <CircleUser className="size-5" aria-hidden />
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{displayName}</span>
                    <span className="text-muted-foreground truncate text-xs">
                      {displayEmail}
                    </span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                className="cursor-pointer"
                render={<Link to="/settings/account" viewTransition />}
              >
                <CircleUser className="size-4 mr-2" />
                Mon compte
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                render={<Link to="/settings/billing" viewTransition />}
              >
                <CreditCard className="size-4 mr-2" />
                Abonnement
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                className="cursor-pointer text-destructive focus:text-destructive"
                onClick={handleSignOut}
              >
                <LogOut className="size-4 mr-2" />
                Se déconnecter
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
