import { Link } from "react-router-dom"
import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"

interface AppErrorStateProps {
  code: string
  title: string
  description: string
  primaryLabel?: string
  primaryTo?: string
  onRetry?: () => void
}

export function AppErrorState({
  code,
  title,
  description,
  primaryLabel = "Retour au tableau de bord",
  primaryTo = "/dashboard",
  onRetry,
}: AppErrorStateProps) {
  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <section className="flex w-full max-w-xl flex-col items-center gap-5 text-center">
        <div className="grid size-14 place-items-center rounded-2xl bg-muted text-primary">
          <AlertTriangle className="size-7" aria-hidden="true" />
        </div>
        <p className="text-sm font-semibold tracking-widest text-muted-foreground">{code}</p>
        <div className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          <p className="text-muted-foreground">{description}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          {onRetry ? (
            <Button onClick={onRetry}>
              <RefreshCw data-icon="inline-start" /> Réessayer
            </Button>
          ) : (
            <Button render={<Link to={primaryTo} />}>
              <ArrowLeft data-icon="inline-start" /> {primaryLabel}
            </Button>
          )}
          {onRetry && (
            <Button variant="outline" render={<Link to="/dashboard" />}>
              Tableau de bord
            </Button>
          )}
        </div>
      </section>
    </main>
  )
}
