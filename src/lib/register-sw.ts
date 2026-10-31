/**
 * Enregistrement du service worker.
 *
 * Deux garde-fous qui évitent des heures de confusion :
 *
 *   • **Jamais en développement.** Le serveur Vite sert des modules non
 *     compilés ; les mettre en cache conduirait à déboguer une version
 *     fantôme de son propre code. C'est le piège classique des PWA.
 *
 *   • **On désenregistre en développement**, au cas où un service worker de
 *     production traînerait encore sur la machine après un test. Sans cela,
 *     il continuerait de servir ses fichiers en cache sur le même port.
 */
export function registerServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return

  if (!import.meta.env.PROD) {
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const registration of registrations) void registration.unregister()
    })
    return
  }

  // Après le chargement : l'enregistrement ne doit pas disputer la bande
  // passante au premier affichage, qui compte davantage.
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* Refusé (navigation privée, origine non sécurisée) : l'application
         fonctionne normalement, simplement sans mode hors connexion. */
    })
  })
}

/**
 * Efface les réponses d'API gardées sur l'appareil.
 *
 * À appeler à la déconnexion : sur un téléphone partagé entre deux
 * caissiers, le catalogue et les tarifs d'une station n'ont pas à rester
 * lisibles après le départ du premier.
 */
export function clearOfflineApiCache(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return
  void navigator.serviceWorker.ready
    .then((registration) => registration.active?.postMessage("clear-api-cache"))
    .catch(() => {
      /* Aucun service worker actif : il n'y a rien à vider. */
    })
}
