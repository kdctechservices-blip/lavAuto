import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import "@coreui/coreui/dist/css/coreui.min.css"
import "simplebar-react/dist/simplebar.min.css"
import "./coreui.css"
import App from "./App.tsx"
import { registerServiceWorker } from "@/lib/register-sw"

// Mode hors connexion : le service worker met l'application en cache pour
// qu'elle s'ouvre sans réseau. Enregistré avant le rendu, actif après le
// chargement (voir src/lib/register-sw.ts).
registerServiceWorker()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
