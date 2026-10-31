import type { ComponentType } from "react"
import { Navigate, type RouteObject } from "react-router-dom"

/**
 * Every page is code-split. With the data router, a route's code is loaded
 * *before* the navigation commits: the current page stays on screen and the
 * root layout shows a progress bar until the next page is ready.
 */
function page(load: () => Promise<{ default: ComponentType }>) {
  return async () => ({ Component: (await load()).default })
}

export const routes: RouteObject[] = [
  // Public marketing entry point
  { path: "/", element: <Navigate to="/landing" replace /> },
  { path: "/landing", lazy: page(() => import("@/app/landing/page")) },
  // WashPilot CI core routes
  { path: "/dashboard", lazy: page(() => import("@/pages/dashboard")) },
  { path: "/onboarding", lazy: page(() => import("@/app/onboarding/page")) },
  { path: "/washes", lazy: page(() => import("@/app/washes/page")) },
  { path: "/washes/:washID", lazy: page(() => import("@/app/washes/[washID]/page")) },
  { path: "/payments", lazy: page(() => import("@/app/payments/page")) },
  { path: "/cash-drawer", lazy: page(() => import("@/app/cash-drawer/page")) },
  { path: "/expenses", lazy: page(() => import("@/app/expenses/page")) },
  { path: "/compteurs", lazy: page(() => import("@/app/compteurs/page")) },
  { path: "/reports", lazy: page(() => import("@/app/reports/page")) },
  { path: "/history", lazy: page(() => import("@/app/history/page")) },
  { path: "/support", lazy: page(() => import("@/app/support/page")) },
  { path: "/sites", lazy: page(() => import("@/app/sites/page")) },
  { path: "/team", lazy: page(() => import("@/app/team/page")) },
  { path: "/stock", lazy: page(() => import("@/app/stock/page")) },
  { path: "/achats", lazy: page(() => import("@/app/purchases/page")) },
  { path: "/equipe", lazy: page(() => import("@/app/team-attendance/page")) },
  { path: "/horaires", lazy: page(() => import("@/app/work-schedules/page")) },
  { path: "/rendement", lazy: page(() => import("@/app/team-performance/page")) },
  { path: "/services", lazy: page(() => import("@/app/services/page")) },
  { path: "/service-categories", lazy: page(() => import("@/app/service-categories/page")) },
  { path: "/vehicle-categories", lazy: page(() => import("@/app/vehicle-categories/page")) },
  // Authentication routes
  {
    path: "/auth/sign-in",
    lazy: page(() => import("@/app/auth/sign-in/page")),
  },
  {
    path: "/auth/sign-up",
    lazy: page(() => import("@/app/auth/sign-up/page")),
  },
  {
    path: "/auth/forgot-password",
    lazy: page(() => import("@/app/auth/forgot-password/page")),
  },
  {
    path: "/auth/reset-password",
    lazy: page(() => import("@/app/auth/reset-password/page")),
  },
  // Error Pages
  {
    path: "/errors/unauthorized",
    lazy: page(() => import("@/app/errors/unauthorized/page")),
  },
  {
    path: "/errors/forbidden",
    lazy: page(() => import("@/app/errors/forbidden/page")),
  },
  {
    path: "/errors/not-found",
    lazy: page(() => import("@/app/errors/not-found/page")),
  },
  {
    path: "/errors/internal-server-error",
    lazy: page(() => import("@/app/errors/internal-server-error/page")),
  },
  {
    path: "/errors/under-maintenance",
    lazy: page(() => import("@/app/errors/under-maintenance/page")),
  },
  // Settings Routes
  {
    path: "/settings/account",
    lazy: page(() => import("@/app/settings/account/page")),
  },
  {
    path: "/settings/billing",
    lazy: page(() => import("@/app/settings/billing/page")),
  },
  {
    path: "/settings/data",
    lazy: page(() => import("@/app/settings/data/page")),
  },
  {
    path: "/settings/access",
    lazy: page(() => import("@/app/settings/access/page")),
  },
  // Catch-all route for 404
  { path: "*", lazy: page(() => import("@/app/errors/not-found/page")) },
]
