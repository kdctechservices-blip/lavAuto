import { isRouteErrorResponse, useRouteError } from "react-router-dom"

/** Last-resort UI for errors raised while matching or rendering a route. */
export function RouteErrorBoundary() {
  const error = useRouteError()
  const status = isRouteErrorResponse(error) ? error.status : undefined
  const message = error instanceof Error ? error.message : String(error)

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-6 py-12 text-foreground">
      <section className="w-full max-w-lg rounded-2xl border bg-card p-8 text-center shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {status ? `Erreur ${status}` : "Erreur inattendue"}
        </p>
        <h1 className="mt-3 text-2xl font-bold">Cette page n’a pas pu s’afficher</h1>
        <p className="mt-3 text-sm text-muted-foreground" role="alert">
          Une erreur est survenue. Vous pouvez réessayer ou retourner à l’accueil.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={() => window.location.reload()}
          >
            Réessayer
          </button>
          <button
            type="button"
            className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={() => window.location.assign("/")}
          >
            Retour à l’accueil
          </button>
        </div>
        {import.meta.env.DEV && (
          <details className="mt-6 text-left text-xs text-muted-foreground">
            <summary className="cursor-pointer">Détails techniques</summary>
            <pre className="mt-2 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3">{message}</pre>
          </details>
        )}
      </section>
    </main>
  )
}
