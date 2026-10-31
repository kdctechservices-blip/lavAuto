"use client"

import { Link } from "react-router-dom"
import { Lock, ShieldAlert, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty-state"
import { usePermission, type Permission } from "@/lib/permissions"
import { useCapability, type Capability } from "@/lib/subscription"

/**
 * Écran de blocage affiché à la place d'une page entière.
 *
 * Il tranche entre deux refus que l'utilisateur ne doit surtout pas confondre :
 *
 *   • **Refus de rôle** — « vous n'y avez pas droit ». Définitif pour cette
 *     personne, aucun bouton d'achat : envoyer un caissier réclamer un forfait
 *     supérieur à son patron pour une fonction qu'il n'aurait toujours pas le
 *     droit d'utiliser est une impasse coûteuse.
 *   • **Refus de forfait** — « votre organisation ne l'a pas souscrit ». Là,
 *     l'achat débloque réellement quelque chose : on explique et on propose.
 *
 * Le rôle est évalué en premier, comme côté serveur (voir `server/app.ts`).
 */
export function PlanGate({
  permission,
  capability,
  title,
  pitch,
  children,
}: {
  permission: Permission
  capability: Capability
  /** Nom de la fonctionnalité, pour le titre de l'argumentaire. */
  title: string
  /** Une phrase sur ce que la fonctionnalité apporte concrètement. */
  pitch: string
  children: React.ReactNode
}) {
  const role = usePermission(permission)
  const plan = useCapability(capability)

  if (!role.allowed) {
    return (
      <EmptyState
        icon={ShieldAlert}
        title="Accès réservé"
        description={role.reason ?? "Votre rôle ne dispose pas de ce droit."}
      />
    )
  }

  if (!plan.allowed) {
    return (
      <EmptyState
        icon={plan.readOnly ? Lock : Sparkles}
        title={plan.readOnly ? "Espace en lecture seule" : `${title} : non inclus dans votre forfait`}
        description={plan.readOnly ? (plan.reason ?? "") : `${pitch} ${plan.reason ?? ""}`}
        action={
          <Link to="/settings/billing">
            <Button>Voir les forfaits</Button>
          </Link>
        }
      />
    )
  }

  return <>{children}</>
}

/**
 * Bandeau d'avertissement après une rétrogradation.
 *
 * Il dit trois choses dans cet ordre, parce que c'est l'ordre des inquiétudes :
 * ce qui est conservé, ce qui va changer, et quand.
 */
export function DowngradeNotice({
  limit,
  activeCount,
  excess,
  graceDaysRemaining,
  enforced,
  unit = "station",
}: {
  limit: number
  activeCount: number
  excess: number
  graceDaysRemaining: number
  enforced: boolean
  unit?: string
}) {
  const plural = excess > 1 ? "s" : ""
  return (
    <div
      role="status"
      className={`rounded-md border px-3 py-2 text-sm ${
        enforced
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
      }`}
    >
      <p className="font-medium">
        {enforced
          ? `${excess} ${unit}${plural} au-delà de votre forfait`
          : `Votre forfait couvre ${limit} ${unit}${limit > 1 ? "s" : ""}, vous en avez ${activeCount} active${activeCount > 1 ? "s" : ""}`}
      </p>
      <p className="mt-1">
        Aucune donnée n’a été supprimée : l’historique de toutes vos {unit}s reste
        consultable et exportable.{" "}
        {enforced
          ? `Les ${unit}s excédentaires n’acceptent plus de nouvelle opération. Désactivez-en une pour rendre la main à une autre, ou repassez au forfait supérieur.`
          : `Vous avez ${graceDaysRemaining} jour${graceDaysRemaining > 1 ? "s" : ""} pour choisir celles à garder actives. Passé ce délai, les plus récentes n’accepteront plus de nouvelle opération.`}
      </p>
    </div>
  )
}
