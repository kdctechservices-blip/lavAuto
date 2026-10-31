import { createBrowserRouter, RouterProvider } from "react-router-dom"
import { MotionConfig } from "framer-motion"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/toast"
import { RootFallback, RootLayout } from "@/components/router/root-layout"
import { routes } from "@/config/routes"
import { consoleRoutes } from "@/console/routes"
import { useEffect } from "react"
import { initGTM } from "@/utils/analytics"
import { AuthProvider } from "@/lib/auth"
import { SubscriptionProvider } from "@/lib/subscription"
import { PermissionProvider } from "@/lib/permissions"
import { ConfirmProvider } from "@/lib/confirm"
import { NotificationProvider } from "@/lib/notifications"

// Get basename from environment (for deployment) or use empty string for development
const basename = import.meta.env.VITE_BASENAME || ""

const router = createBrowserRouter(
  [
    // -----------------------------------------------------------------------
    // Console de l'éditeur — branche soeur, et non enfant, de `RootLayout`.
    //
    // La placer sous la racine commune lui imposerait la garde de session des
    // stations : une session absente renverrait vers `/auth/sign-in`, et une
    // session de station présente ferait croire à une entrée légitime. La
    // console porte donc sa propre racine, sa propre authentification et sa
    // propre redirection.
    //
    // Conséquence voulue : aucun composant de l'application cliente n'est
    // monté sous /console, et aucun de ses contextes n'y est disponible.
    // -----------------------------------------------------------------------
    {
      path: "/console",
      lazy: async () => ({ Component: (await import("@/console/root")).ConsoleRoot }),
      children: consoleRoutes,
    },
    {
      element: <RootLayout />,
      HydrateFallback: RootFallback,
      children: routes,
    },
  ],
  { basename }
)

function App() {
  // Initialize GTM on app load
  useEffect(() => {
    initGTM()
  }, [])

  return (
    <div
      className="font-sans antialiased"
      style={{ fontFamily: "var(--font-inter)" }}
    >
      {/* reducedMotion="user" : framer-motion neutralise automatiquement les
          animations si le système demande un mouvement réduit. */}
      <MotionConfig reducedMotion="user">
        <ThemeProvider defaultTheme="system">
          <AuthProvider>
            {/* Droits et forfait montés UNE fois, au-dessus du routeur : chaque
                page qui lit `useAccess` est une descendante de ces
                fournisseurs. Avant, ils vivaient dans `BaseLayout` — et un
                écran qui les appelait au-dessus de son propre layout lisait un
                contexte jamais alimenté : le bouton « Nouveau lavage »
                chargeait sans fin parce que `/me/permissions` n'était
                requêté qu'au montage du layout, après le rendu du bouton.
                Montés ici, ils couvrent les 18 écrans qui lisent les droits. */}
            <SubscriptionProvider>
              <PermissionProvider>
                {/* Notifications : alertes réelles (essai, file hors ligne,
                    activité sensible) et acquittements persistés. Montées
                    au-dessus du routeur pour que la cloche de l'en-tête et les
                    pages lisent le même état. */}
                <NotificationProvider>
                  <ConfirmProvider>
                    <Toaster>
                      <RouterProvider router={router} />
                    </Toaster>
                  </ConfirmProvider>
                </NotificationProvider>
              </PermissionProvider>
            </SubscriptionProvider>
          </AuthProvider>
        </ThemeProvider>
      </MotionConfig>
    </div>
  )
}

export default App
