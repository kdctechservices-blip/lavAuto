"use client"

import * as React from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { ArrowRight, History, Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { Kbd } from "@/components/ui/kbd"
import {
  ROUTE_META,
  contextualCommands,
  matchRoute,
  recentVisits,
  routeLabel,
} from "@/config/navigation"
import { usePermissions, type Permission } from "@/lib/permissions"

/**
 * Recherche globale (⌘K).
 *
 * Trois blocs, dans l'ordre où l'on en a besoin :
 *   1. **les pages récentes** — on revient neuf fois sur dix là où on était ;
 *   2. **les actions de l'écran courant** — l'étape suivante du travail, pas
 *      une liste de liens indifférenciée ;
 *   3. **tous les écrans**, groupés par section, filtrés par permission.
 *
 * La palette ne propose jamais une destination que l'utilisateur ne peut pas
 * ouvrir : un résultat qui mène à un refus est pire qu'une absence.
 */

interface SearchContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  openSearch: () => void
}

const SearchContext = React.createContext<SearchContextValue | null>(null)

export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)

  const value = React.useMemo<SearchContextValue>(
    () => ({ open, setOpen, openSearch: () => setOpen(true) }),
    [open],
  )

  return (
    <SearchContext.Provider value={value}>
      {children}
      <CommandSearch open={open} onOpenChange={setOpen} />
    </SearchContext.Provider>
  )
}

export function useSearch(): SearchContextValue {
  const context = React.useContext(SearchContext)
  return (
    context ?? {
      open: false,
      setOpen: () => {},
      openSearch: () => {},
    }
  )
}

/** Permission minimale pour ouvrir un écran, alignée sur la barre latérale. */
const ROUTE_PERMISSION: Record<string, Permission> = {
  "/dashboard": "dashboard:read",
  "/washes": "wash:read",
  "/payments": "payment:read",
  "/cash-drawer": "cash_session:read",
  "/expenses": "expense:read",
  "/compteurs": "expense:read",
  "/stock": "stock:read",
  "/achats": "purchase:manage",
  "/equipe": "attendance:read",
  "/horaires": "attendance:read",
  "/rendement": "attendance:read",
  "/team": "worker:read",
  "/reports": "report:operational",
  "/history": "audit:read",
  "/services": "service:read",
  "/service-categories": "service:read",
  "/vehicle-categories": "service:read",
  "/sites": "settings:manage",
  "/settings/access": "user:manage",
  "/settings/account": "dashboard:read",
  "/settings/billing": "subscription:manage",
  "/settings/data": "data:export",
  "/support": "dashboard:read",
}

interface CommandSearchProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface PaletteItem {
  title: string
  url: string
  context: string
  description?: string
}

export function CommandSearch({ open, onOpenChange }: CommandSearchProps) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { can, loading } = usePermissions()

  /** Les pages récentes sont relues à chaque ouverture, pas au montage. */
  const recents = React.useMemo<PaletteItem[]>(() => {
    if (!open) return []
    return recentVisits()
      .filter((path) => path !== pathname && allowed(path))
      .slice(0, 3)
      .map((path) => {
        const meta = matchRoute(path)?.meta
        return {
          title: routeLabel(path),
          url: path,
          context: meta?.section ?? "Récent",
          description: meta?.description,
        }
      })
    // `allowed` dépend des permissions ; `open` force la relecture du stockage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pathname, can, loading])

  function allowed(path: string) {
    if (loading) return false
    const permission = ROUTE_PERMISSION[path]
    return !permission || can(permission)
  }

  const actions = React.useMemo<PaletteItem[]>(() => {
    if (!open) return []
    return contextualCommands(pathname)
      .filter((command) => allowed(command.href.split("?")[0]))
      .map((command) => ({
        title: command.label,
        url: command.href,
        context: command.hint ?? "Action",
      }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pathname, can, loading])

  const screens = React.useMemo(() => {
    const groups = new Map<string, PaletteItem[]>()
    for (const [path, meta] of Object.entries(ROUTE_META)) {
      if (!allowed(path)) continue
      const item: PaletteItem = {
        title: meta.label,
        url: path,
        context: meta.parent?.label ?? meta.section,
      }
      const group = meta.section
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group)!.push(item)
    }
    return [...groups.entries()]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [can, loading])

  const select = React.useCallback(
    (url: string) => {
      onOpenChange(false)
      navigate(url)
    },
    [navigate, onOpenChange],
  )

  const renderItem = (item: PaletteItem) => (
    <CommandItem
      key={`${item.title}-${item.url}`}
      value={`${item.title} ${item.url} ${item.context}`}
      onSelect={() => select(item.url)}
    >
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">{item.context}</span>
    </CommandItem>
  )

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Recherche"
      description="Rechercher un écran, une action ou une page récente"
      className="sm:max-w-[640px]"
    >
      <Command>
        <CommandInput placeholder="Rechercher un lavage, une page, une action…" autoFocus />
        <CommandList className="max-h-[420px]">
          <CommandEmpty>
            Aucun résultat. Essayez « caisse », « lavage » ou le nom d'une page.
          </CommandEmpty>

          {recents.length > 0 && (
            <CommandGroup heading="Reprendre où vous étiez">
              {recents.map((item) => (
                <CommandItem
                  key={`recent-${item.url}`}
                  value={`récent ${item.title} ${item.url}`}
                  onSelect={() => select(item.url)}
                >
                  <History aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                    Récent
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {actions.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Actions pour cet écran">
                {actions.map((item) => (
                  <CommandItem
                    key={`action-${item.url}`}
                    value={`action ${item.title} ${item.url}`}
                    onSelect={() => select(item.url)}
                  >
                    <ArrowRight aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">
                      {item.context}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          <CommandSeparator />
          <CommandGroup heading="Aide">
            <CommandItem
              value="raccourcis clavier aide ? commandes"
              onSelect={() => {
                onOpenChange(false)
                window.dispatchEvent(new Event("washpilot:shortcuts"))
              }}
            >
              <span className="min-w-0 flex-1 truncate">Raccourcis clavier</span>
              <span className="ml-2 shrink-0 text-[11px] text-muted-foreground">?</span>
            </CommandItem>
          </CommandGroup>

          <CommandSeparator />
          {screens.map(([section, items]) => (
            <CommandGroup key={section} heading={section}>
              {items.map(renderItem)}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

export function SearchTrigger({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      aria-label="Rechercher — raccourci Commande K"
      aria-keyshortcuts="Control+K Meta+K"
      className="relative w-full justify-start font-normal text-muted-foreground sm:pr-12 md:w-44 lg:w-64"
    >
      <Search data-icon="inline-start" aria-hidden="true" />
      <span className="truncate">Rechercher…</span>
      <Kbd className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 sm:inline-flex">
        ⌘K
      </Kbd>
    </Button>
  )
}
