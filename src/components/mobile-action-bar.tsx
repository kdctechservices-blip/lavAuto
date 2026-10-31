"use client"

import { Link, useLocation } from "react-router-dom"
import { CreditCard, Droplets, LayoutPanelLeft, Search, Wallet } from "lucide-react"

import { useSearch } from "@/components/command-search"
import { useAccess, usePermission } from "@/lib/permissions"
import { cn } from "@/lib/utils"

/**
 * Barre d'actions fixe en bas, sur téléphone et tablette.
 *
 * Le pouce atteint le bas de l'écran, pas le coin supérieur droit. Les cinq
 * gestes du quotidien — revenir à l'accueil, voir les lavages, en enregistrer
 * un, ouvrir la caisse, chercher — sont donc là, en permanence, avec une cible
 * d'au moins 44 px et une zone de sécurité pour les encoches iOS.
 *
 * La barre n'apparaît que si elle a quelque chose à proposer : un caissier qui
 * n'a pas accès à la caisse ne voit pas une icône grisée.
 */
export function MobileActionBar() {
  const { pathname } = useLocation()
  const { openSearch } = useSearch()
  const wash = useAccess("wash:create", "washes.create")
  const cash = usePermission("cash_session:read")
  const payments = usePermission("payment:read")

  const items = [
    {
      href: "/dashboard",
      label: "Accueil",
      icon: LayoutPanelLeft,
      active: pathname === "/dashboard",
    },
    {
      href: "/washes",
      label: "Lavages",
      icon: Droplets,
      active: pathname.startsWith("/washes"),
    },
    cash.allowed
      ? {
          href: "/cash-drawer",
          label: "Caisse",
          icon: Wallet,
          active: pathname === "/cash-drawer",
        }
      : null,
    payments.allowed
      ? {
          href: "/payments",
          label: "Encaissements",
          icon: CreditCard,
          active: pathname === "/payments",
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null)

  return (
    <nav
      aria-label="Actions rapides"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80 md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto grid max-w-lg grid-flow-col auto-cols-fr items-stretch px-1">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              to={item.href}
              viewTransition
              aria-current={item.active ? "page" : undefined}
              className={cn(
                "flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-[11px] font-medium transition-colors",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                item.active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon
                className={cn("size-5", item.active && "text-primary")}
                aria-hidden="true"
              />
              <span className="truncate">{item.label}</span>
            </Link>
          )
        })}

        {wash.allowed && (
          <Link
            to="/washes?new=1"
            viewTransition
            aria-label="Nouveau lavage"
            className="mx-1 flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-lg bg-primary px-1 py-1.5 text-[11px] font-semibold text-primary-foreground focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
          >
            <span className="flex size-6 items-center justify-center rounded-full bg-primary-foreground/15 text-base leading-none">
              +
            </span>
            <span>Nouveau</span>
          </Link>
        )}

        <button
          type="button"
          onClick={openSearch}
          className="flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Search className="size-5" aria-hidden="true" />
          <span>Rechercher</span>
        </button>
      </div>
    </nav>
  )
}
