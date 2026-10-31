import type { ComponentType } from "react"
import { Navigate, type RouteObject } from "react-router-dom"
import { ConsoleAdminOnly } from "./auth"

/**
 * Routes de la console.
 *
 * Même découpage à la demande que l'application cliente : le code de la
 * console ne doit pas peser sur le chargement d'une station, et vice versa.
 */
function page(load: () => Promise<{ default: ComponentType }>) {
  return async () => ({ Component: (await load()).default })
}

function adminPage(load: () => Promise<{ default: ComponentType }>) {
  return async () => {
    const Page = (await load()).default
    function AdminPage() {
      return <ConsoleAdminOnly fallback={<Navigate to="/console" replace />}><Page /></ConsoleAdminOnly>
    }
    return { Component: AdminPage }
  }
}

export const consoleRoutes: RouteObject[] = [
  { index: true, lazy: page(() => import("@/console/pages/overview")) },
  { path: "stations", lazy: page(() => import("@/console/pages/stations")) },
  { path: "stations/:id", lazy: page(() => import("@/console/pages/station-detail")) },
  { path: "assistance", lazy: page(() => import("@/console/pages/support")) },
  { path: "assistance/:id", lazy: page(() => import("@/console/pages/support-detail")) },
  { path: "comptes", lazy: page(() => import("@/console/pages/accounts")) },
  { path: "comptes/:userId", lazy: page(() => import("@/console/pages/account-detail")) },
  { path: "revenus", lazy: page(() => import("@/console/pages/revenue")) },
  { path: "rapprochement", lazy: page(() => import("@/console/pages/reconciliation")) },
  { path: "paiements", lazy: page(() => import("@/console/pages/payments")) },
  { path: "surveillance", lazy: page(() => import("@/console/pages/monitoring")) },
  { path: "surveillance/:id", lazy: page(() => import("@/console/pages/monitoring-error")) },
  { path: "tarifs", lazy: page(() => import("@/console/pages/plans")) },
  { path: "operateurs", lazy: adminPage(() => import("@/console/pages/operators")) },
  { path: "journal", lazy: page(() => import("@/console/pages/journal")) },
]
