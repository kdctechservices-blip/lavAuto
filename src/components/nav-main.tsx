"use client"

import * as React from "react"
import { ChevronRight, type LucideIcon } from "lucide-react"
import { Link, useLocation } from "react-router-dom"
import { motion } from "framer-motion"

import { SPRING } from "@/lib/motion"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"

/**
 * Un groupe de navigation.
 *
 * L'état replié/déplié des sous-menus (Catalogue, Paramètres) est **mémorisé
 * par groupe** : un gérant qui travaille dans le catalogue n'a pas à le
 * rouvrir à chaque visite. La section qui contient la page courante s'ouvre
 * d'elle-même — la mémoire ne doit jamais cacher l'écran où l'on est.
 */

const OPEN_KEY = "washpilot:nav-open"

function readOpenMap(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(OPEN_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function writeOpenMap(map: Record<string, boolean>) {
  try {
    window.localStorage.setItem(OPEN_KEY, JSON.stringify(map))
  } catch {
    // Sans stockage, le groupe s'ouvre selon la page courante. Suffisant.
  }
}

export function NavMain({
  label,
  items,
}: {
  label: string
  items: {
    title: string
    url: string
    icon?: LucideIcon
    isActive?: boolean
    items?: {
      title: string
      url: string
      isActive?: boolean
    }[]
  }[]
}) {
  const location = useLocation()

  const isSubItemActive = (item: (typeof items)[number]) =>
    Boolean(item.items?.some((subItem) => location.pathname === subItem.url))

  const [openGroups, setOpenGroups] = React.useState<Record<string, boolean>>(() =>
    typeof window === "undefined" ? {} : readOpenMap(),
  )

  // La page courante gagne toujours : `open` retombe sur l'état du sous-menu
  // actif quand aucune préférence n'a été enregistrée. Aucun effet, donc aucun
  // rendu en cascade : l'ouverture est calculée, pas rattrapée après coup.

  const setOpen = (title: string, open: boolean) => {
    setOpenGroups((current) => {
      const next = { ...current, [title]: open }
      writeOpenMap(next)
      return next
    })
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => {
          const active = location.pathname === item.url
          const hasChildren = Boolean(item.items?.length)
          const open = openGroups[item.title] ?? isSubItemActive(item)

          return (
            <Collapsible
              key={item.title}
              open={hasChildren ? open : undefined}
              onOpenChange={(next) => hasChildren && setOpen(item.title, next)}
              className="group/collapsible"
              render={<SidebarMenuItem />}
            >
              {hasChildren ? (
                <>
                  <CollapsibleTrigger
                    render={
                      <SidebarMenuButton
                        tooltip={item.title}
                        className="min-h-11 cursor-pointer md:min-h-8"
                        aria-expanded={open}
                      />
                    }
                  >
                    {item.icon && <item.icon />}
                    <span>{item.title}</span>
                    <ChevronRight
                      className="ml-auto transition-transform duration-200 group-data-open/collapsible:rotate-90"
                      aria-hidden="true"
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {item.items?.map((subItem) => {
                        const subActive = location.pathname === subItem.url
                        return (
                          <SidebarMenuSubItem key={subItem.title}>
                            <SidebarMenuSubButton
                              className="min-h-11 cursor-pointer md:min-h-7"
                              isActive={subActive}
                              aria-current={subActive ? "page" : undefined}
                              render={<Link to={subItem.url} viewTransition />}
                            >
                              <span>{subItem.title}</span>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        )
                      })}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </>
              ) : (
                <SidebarMenuButton
                  tooltip={item.title}
                  // Le fond actif est dessiné par l'indicateur animé ci-dessous.
                  className="group/nav relative isolate min-h-11 cursor-pointer transition-transform duration-150 ease-out hover:translate-x-0.5 data-active:bg-transparent md:min-h-8"
                  isActive={active}
                  aria-current={active ? "page" : undefined}
                  render={<Link to={item.url} viewTransition />}
                >
                  {active && (
                    /* Un seul indicateur pour tout le menu : il glisse d'un
                       élément à l'autre au lieu de clignoter d'un écran à l'autre. */
                    <motion.span
                      layoutId="sidebar-active-indicator"
                      className="edge-3d absolute inset-0 -z-10 rounded-md bg-sidebar-accent"
                      transition={SPRING.snappy}
                    />
                  )}
                  {item.icon && (
                    <item.icon className="transition-transform duration-150 ease-out group-hover/nav:scale-110" />
                  )}
                  <span>{item.title}</span>
                </SidebarMenuButton>
              )}
            </Collapsible>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}
