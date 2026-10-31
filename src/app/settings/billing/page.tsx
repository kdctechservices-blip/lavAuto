import { Link } from "react-router-dom"
import { Check, CreditCard, Info } from "lucide-react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useApi } from "@/lib/api"
import type { OnboardingSummary } from "@/lib/onboarding-api"
import { TrialStatusCard } from "@/components/trial/trial-status-card"
import { UpgradeRequestCard } from "@/components/trial/upgrade-request-card"
import { TrialSimulator } from "@/components/trial/trial-simulator"

const statusLabels: Record<string, string> = {
  active: "Actif",
  pending: "En attente de validation",
  trialing: "Essai",
  expired: "Expiré",
  cancelled: "Annulé",
  canceled: "Annulé",
}

const entitlementLabels: Record<string, string> = {
  "sites.multiple": "Gestion multi-stations",
  "reports.advanced": "Rapports avancés",
  "reports.export": "Export des rapports",
  "employees.advanced": "Gestion avancée de l’équipe",
  "cash.reconciliation": "Rapprochement de caisse",
  "audit.advanced": "Journal d’audit avancé",
  "analytics.consolidated": "Analyses consolidées",
}

function formatPrice(priceCents: number, cycle: string) {
  if (priceCents === 0) return "Gratuit"
  const period = cycle === "yearly" ? "an" : "mois"
  return `${(priceCents / 100).toLocaleString("fr-CI")} F CFA / ${period}`
}

export default function BillingSettings() {
  const { data, loading, error } = useApi<OnboardingSummary>("/api/v1/onboarding/summary")
  const plan = data?.plan
  const features = plan
    ? Array.isArray(plan.features)
      ? plan.features
      : Object.entries(plan.features)
          .filter(([, enabled]) => enabled)
          .map(([key]) => entitlementLabels[key] ?? key)
    : []

  return (
    <BaseLayout>
      <div className="flex flex-col gap-6 px-4 lg:px-6">
        <div>
          <h1 className="text-3xl font-bold">Forfait et abonnement</h1>
          <p className="text-muted-foreground">
            Consultez le forfait réellement associé à votre organisation.
          </p>
        </div>

        <TrialStatusCard />
        <UpgradeRequestCard currentPlanCode={plan?.code ?? null} />

        {loading ? (
          <Card role="status" aria-busy="true" aria-label="Chargement du forfait">
            <CardContent className="space-y-4 p-6">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-2">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
              <Skeleton className="h-8 w-32" />
              <div className="space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </CardContent>
          </Card>
        ) : error ? (
          <Card>
            <CardContent className="p-6 text-sm text-destructive">{error}</CardContent>
          </Card>
        ) : plan ? (
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="flex items-center gap-2">
                    <CreditCard className="size-5" /> {plan.name}
                  </CardTitle>
                  <CardDescription>{plan.description || data?.org_name}</CardDescription>
                </div>
                <Badge variant={data?.subscription_status === "active" ? "secondary" : "outline"}>
                  {statusLabels[data?.subscription_status ?? ""] ?? "Statut inconnu"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <p className="text-2xl font-bold">
                {formatPrice(plan.price_cents, plan.billing_cycle)}
              </p>
              <div className="grid gap-3 text-sm sm:grid-cols-2">
                {plan.max_sites !== null && plan.max_sites !== undefined && (
                  <p>Sites : {plan.max_sites}</p>
                )}
                {plan.max_users !== null && plan.max_users !== undefined && (
                  <p>Comptes utilisateurs : {plan.max_users}</p>
                )}
                {plan.max_workers !== null && plan.max_workers !== undefined && (
                  <p>Travailleurs : {plan.max_workers}</p>
                )}
                {plan.max_services !== null && plan.max_services !== undefined && (
                  <p>Prestations : {plan.max_services}</p>
                )}
              </div>
              {features.length > 0 && (
                <ul className="grid gap-2 text-sm sm:grid-cols-2">
                  {features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2">
                      <Check className="size-4 text-primary" /> {feature}
                    </li>
                  ))}
                </ul>
              )}
              {data?.subscription_status === "pending" && (
                <div className="flex items-start gap-2 rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                  <Info className="mt-0.5 size-4 shrink-0" />
                  <p>Le forfait payant est en attente de validation. Aucun paiement n’est traité depuis cette page.</p>
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Aucun forfait associé</CardTitle>
              <CardDescription>
                Terminez la configuration de votre station pour choisir un forfait.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button render={<Link to="/onboarding" />}>Reprendre la configuration</Button>
            </CardContent>
          </Card>
        )}

        <TrialSimulator />
      </div>
    </BaseLayout>
  )
}
