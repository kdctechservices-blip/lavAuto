"use client"

import * as React from "react"
import { FileText, LifeBuoy, Mail, MessageCircle, X } from "lucide-react"
import { Link } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { useApi } from "@/lib/api"
import { useSubscription } from "@/lib/subscription"
import { cn } from "cn"

/**
 * Assistance WhatsApp.
 *
 * Un bouton flottant ouvre une carte proposant une mise en relation WhatsApp
 * avec un message déjà rédigé (station, forfait, écran consulté) : le gérant
 * n'a plus qu'à décrire son problème.
 */

interface SupportConfig {
  commitment?: {
    label: string
    guaranteed: boolean
    business_hours: string
  }
  whatsapp_number: string
  whatsapp_display: string
  email: string
  is_placeholder: boolean
  context: {
    organization_name: string | null
    contact_name: string | null
    contact_email: string | null
    contact_phone: string | null
    plan_name: string | null
    subscription_status: string | null
  }
}

const PAGE_LABELS: { prefix: string; label: string }[] = [
  { prefix: "/dashboard", label: "le tableau de bord" },
  { prefix: "/washes", label: "les lavages" },
  { prefix: "/payments", label: "les encaissements" },
  { prefix: "/cash-drawer", label: "la caisse" },
  { prefix: "/expenses", label: "les dépenses" },
  { prefix: "/reports", label: "les rapports" },
  { prefix: "/team", label: "l’équipe" },
  { prefix: "/services", label: "le catalogue" },
  { prefix: "/settings/billing", label: "le forfait" },
  { prefix: "/settings/data", label: "les sauvegardes" },
  { prefix: "/onboarding", label: "la configuration" },
]

function currentPageLabel(pathname: string): string {
  return PAGE_LABELS.find((entry) => pathname.startsWith(entry.prefix))?.label ?? "l’application"
}

/** Message WhatsApp pré-rempli, assez précis pour éviter un aller-retour. */
export function buildSupportMessage(options: {
  contactName: string | null
  organizationName: string | null
  planName: string | null
  pageLabel: string
}): string {
  const who = options.contactName ? `${options.contactName}` : "un utilisateur"
  const station = options.organizationName ? ` de la station ${options.organizationName}` : ""
  const plan = options.planName ? ` (forfait ${options.planName})` : ""
  return `Bonjour WashPilot CI, je suis ${who}${station}${plan}. J’ai besoin d’aide concernant ${options.pageLabel} : `
}

export function SupportButton() {
  const [open, setOpen] = React.useState(false)
  const { data } = useApi<SupportConfig>("/api/v1/support/config")
  const { state } = useSubscription()

  const pathname = typeof window === "undefined" ? "" : window.location.pathname
  const message = buildSupportMessage({
    contactName: data?.context.contact_name ?? null,
    organizationName: data?.context.organization_name ?? null,
    planName: data?.context.plan_name ?? state?.plan_name ?? null,
    pageLabel: currentPageLabel(pathname),
  })

  const whatsappUrl = data?.whatsapp_number
    ? `https://wa.me/${data.whatsapp_number}?text=${encodeURIComponent(message)}`
    : null
  const mailUrl = data?.email
    ? `mailto:${data.email}?subject=${encodeURIComponent("Assistance WashPilot CI")}&body=${encodeURIComponent(message)}`
    : null

  if (!data) return null

  return (
    <>
      {/* Carte d'assistance */}
      <div
        hidden={!open}
        role="dialog"
        aria-label="Assistance WashPilot CI"
        className={cn(
          "fixed right-4 bottom-36 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border bg-popover p-4 shadow-lg md:bottom-20",
          "duration-200 ease-out data-[visible=true]:animate-in data-[visible=true]:fade-in-0 data-[visible=true]:zoom-in-95",
        )}
        data-visible={open}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-semibold">Besoin d’aide ?</p>
            <p className="text-sm text-muted-foreground">
              {data.commitment?.guaranteed
                ? `Votre forfait vous garantit une réponse sous ${data.commitment.label}.`
                : "Écrivez-nous sur WhatsApp, on répond pendant les heures d’ouverture."}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Fermer l’assistance"
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          {/* En premier : le chemin qui laisse une trace. WhatsApp reste
              proposé juste en dessous pour l'urgence, parce que c'est le
              canal que les gérants utilisent réellement. */}
          <Link
            to="/support"
            onClick={() => setOpen(false)}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground transition-transform duration-150 hover:scale-[1.02] active:scale-[0.98]"
          >
            <FileText className="size-4" aria-hidden="true" />
            Décrire mon problème
          </Link>

          {whatsappUrl ? (
            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-[#25D366] px-4 text-sm font-semibold text-white transition-transform duration-150 hover:scale-[1.02] active:scale-[0.98]"
            >
              <MessageCircle className="size-4" aria-hidden="true" />
              Discuter sur WhatsApp
            </a>
          ) : (
            <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
              Numéro d’assistance non configuré (variable <code>SUPPORT_WHATSAPP</code>).
            </p>
          )}

          {mailUrl && (
            <a
              href={mailUrl}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors duration-150 hover:bg-accent"
            >
              <Mail className="size-4" aria-hidden="true" />
              {data.email}
            </a>
          )}
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          {data.whatsapp_display && (
            <>
              Numéro : {data.whatsapp_display}
              {data.is_placeholder && " (numéro de démonstration)"} ·{" "}
            </>
          )}
          Une demande écrite garde une trace et reçoit une réponse suivie ; WhatsApp va plus
          vite mais se perd dans le fil.
        </p>
      </div>

      {/* Bouton flottant */}
      <Button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="Assistance"
        className="fixed right-4 bottom-20 z-50 h-12 gap-2 rounded-full px-5 shadow-lg transition-transform duration-150 hover:scale-[1.03] active:scale-[0.97] md:bottom-4"
      >
        <LifeBuoy className="size-5" aria-hidden="true" />
        <span className="hidden sm:inline">Aide</span>
      </Button>
    </>
  )
}
