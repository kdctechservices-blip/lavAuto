import * as React from "react"
import { AlertTriangle, Copy, MessageCircle, Printer } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { LoadingSpinner } from "@/components/ui/loading-spinner"
import { apiFetch, apiErrorMessage } from "@/lib/api"

/**
 * Le reçu de lavage, format 80 mm.
 *
 * ## Pourquoi l'impression passe par le navigateur
 *
 * Un pilote ESC/POS imposerait une bibliothèque supplémentaire et un pont
 * local sur chaque poste. `window.print()` avec une feuille `@page` sort
 * correctement d'une imprimante de comptoir USB, d'un modèle Bluetooth sous
 * Android et d'un export PDF — sans rien installer. Le rendu texte aligné sur
 * 48 colonnes reste disponible en secours pour les pilotes qui n'acceptent
 * que du brut.
 *
 * ## Ouvrir le reçu, c'est l'émettre
 *
 * La requête est un POST, pas un GET. Elle attribue un numéro de copie et
 * laisse une trace. Un aperçu gratuit permettrait d'imprimer autant de
 * papiers qu'on veut sans que le compteur bouge, ce qui viderait la mention
 * DUPLICATA de son sens : deux reçus indiscernables pour un seul versement,
 * c'est la même somme justifiée deux fois.
 */

interface ReceiptItem {
  service_name: string
  quantity: number
  unit_price_cents: number
  line_total_cents: number
}

interface ReceiptPayment {
  method: string
  amount_cents: number
  status: string
  created_at: string
}

export interface WashReceipt {
  number: string
  issued_at: string
  copy_number: number
  duplicate: boolean
  station: { name: string; site: string; city: string; address: string | null; phone: string | null }
  wash: {
    reference: string
    created_at: string
    vehicle: string | null
    plate: string | null
    customer: string | null
  }
  cashier: string | null
  workers: string[]
  items: ReceiptItem[]
  total_cents: number
  payments: ReceiptPayment[]
  paid_cents: number
  remaining_cents: number
}

const METHOD_LABELS: Record<string, string> = {
  cash: "Espèces",
  orange_money: "Orange Money",
  mtn_momo: "MTN MoMo",
  moov_money: "Moov Money",
  wave: "Wave",
  card: "Carte",
  bank_transfer: "Virement",
  other: "Autre",
}

/** Le franc CFA n'a pas de subdivision en circulation : aucune décimale. */
function amount(cents: number): string {
  return Math.round(cents / 100).toLocaleString("fr-FR").replace(/\u202f|\u00a0/g, " ")
}

function dateTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function Separator() {
  return <div className="recu-separateur my-1.5 border-t border-dashed border-black/40" />
}

/** Une ligne « libellé à gauche, montant à droite ». */
function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-2 ${strong ? "font-bold" : ""}`}>
      <span className="min-w-0 break-words">{label}</span>
      <span className="shrink-0 tabular-nums">{value}</span>
    </div>
  )
}

/**
 * Le papier lui-même.
 *
 * `id="recu-impression"` est l'ancrage de la feuille de style d'impression
 * (voir src/index.css) : tout le reste de la page est masqué, ce bloc seul
 * est envoyé à l'imprimante.
 */
export function ReceiptPaper({ receipt }: { receipt: WashReceipt }) {
  return (
    <div
      id="recu-impression"
      className="mx-auto w-[72mm] bg-white p-2 font-mono text-[11px] leading-tight text-black"
    >
      <div className="text-center">
        <p className="text-[13px] font-bold uppercase">{receipt.station.name}</p>
        <p>{receipt.station.site}</p>
        {receipt.station.address && <p>{receipt.station.address}</p>}
        <p>{receipt.station.city}</p>
        {receipt.station.phone && <p>Tél {receipt.station.phone}</p>}
      </div>

      <div className="recu-separateur my-1.5 border-t-2 border-double border-black" />
      <p className="text-center text-[12px] font-bold">REÇU {receipt.number}</p>
      <div className="recu-separateur my-1.5 border-t-2 border-double border-black" />

      <Row label="Date" value={dateTime(receipt.wash.created_at)} />
      {receipt.cashier && <Row label="Caissier" value={receipt.cashier} />}
      {receipt.wash.vehicle && <Row label="Véhicule" value={receipt.wash.vehicle} />}
      {receipt.wash.plate && <Row label="Plaque" value={receipt.wash.plate} />}
      {receipt.wash.customer && <Row label="Client" value={receipt.wash.customer} />}

      <Separator />

      {receipt.items.map((item, index) => (
        <div key={`${item.service_name}-${index}`}>
          <p className="break-words">{item.service_name}</p>
          <Row
            label={`  ${item.quantity} × ${amount(item.unit_price_cents)}`}
            value={amount(item.line_total_cents)}
          />
        </div>
      ))}

      <Separator />
      <Row label="TOTAL" value={`${amount(receipt.total_cents)} FCFA`} strong />
      <Separator />

      {receipt.payments.length > 0 && (
        <>
          <p className="font-bold">RÈGLEMENTS</p>
          {receipt.payments.map((payment, index) => (
            <Row
              key={index}
              label={`  ${METHOD_LABELS[payment.method] ?? payment.method}${payment.status === "pending" ? " (à vérifier)" : ""
                }`}
              value={amount(payment.amount_cents)}
            />
          ))}
          <Separator />
        </>
      )}

      <Row label="PAYÉ" value={`${amount(receipt.paid_cents)} FCFA`} strong />
      {receipt.remaining_cents > 0 && (
        <Row label="RESTE À PAYER" value={`${amount(receipt.remaining_cents)} FCFA`} strong />
      )}

      {receipt.workers.length > 0 && (
        <>
          <Separator />
          <p className="break-words">Laveurs : {receipt.workers.join(", ")}</p>
        </>
      )}

      {receipt.duplicate && (
        <>
          <Separator />
          <p className="text-center text-[12px] font-bold">*** DUPLICATA ***</p>
          <p className="text-center">
            Copie n°{receipt.copy_number} du {dateTime(receipt.issued_at)}
          </p>
        </>
      )}

      <Separator />
      <p className="text-center">Merci de votre visite</p>
      {/* Aucune mention fiscale : ce document n'est pas un Reçu Normalisé
          Électronique, et lui en donner l'apparence exposerait la station. */}
    </div>
  )
}

export function WashReceiptButton({
  washId,
  disabled,
  label = "Imprimer le reçu",
}: {
  washId: string
  disabled?: boolean
  label?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [receipt, setReceipt] = React.useState<WashReceipt | null>(null)
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)

  async function issue() {
    setBusy(true)
    setError(null)
    try {
      const response = await apiFetch(`/api/v1/washes/${encodeURIComponent(washId)}/receipt`, {
        method: "POST",
      })
      if (!response.ok) {
        setError(await apiErrorMessage(response))
        return
      }
      const payload = (await response.json()) as { receipt: WashReceipt; text: string }
      setReceipt(payload.receipt)
      setText(payload.text)
      setOpen(true)
    } catch {
      setError("Reçu indisponible : serveur injoignable.")
    } finally {
      setBusy(false)
    }
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <>
      <Button variant="outline" onClick={issue} disabled={disabled || busy} aria-busy={busy}>
        {busy ? <LoadingSpinner className="mr-2 size-4" /> : <Printer className="mr-2 size-4" />}
        {label}
      </Button>

      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Reçu {receipt?.number}</DialogTitle>
            <DialogDescription>
              {receipt?.duplicate
                ? `Copie n°${receipt.copy_number} — le papier portera la mention DUPLICATA.`
                : "Original. Toute réimpression sera marquée DUPLICATA."}
            </DialogDescription>
          </DialogHeader>

          {receipt && (
            <>
              <div className="rounded-md border bg-neutral-100 p-3">
                <ReceiptPaper receipt={receipt} />
              </div>

              {receipt.remaining_cents > 0 && (
                <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  Ce lavage n'est pas soldé : le reçu annonce le reste à payer.
                </p>
              )}

              <div className="flex flex-wrap gap-2 print:hidden">
                <Button onClick={() => window.print()}>
                  <Printer className="mr-2 size-4" /> Imprimer
                </Button>
                {receipt && (
                  <Button
                    variant="outline"
                    onClick={() => window.open(`https://wa.me/${"2250700000000".replace(/[^0-9]/g, "")}?text=${encodeURIComponent(text)}`, "_blank")}
                    disabled={busy}
                  >
                    <MessageCircle className="mr-2 size-4" /> WhatsApp
                  </Button>
                )}
                <Button variant="outline" onClick={copyText}>
                  <Copy className="mr-2 size-4" /> {copied ? "Copié" : "Copier le texte"}
                </Button>
              </div>

              <p className="text-xs text-muted-foreground print:hidden">
                Format 80 mm. « Copier le texte » donne un rendu aligné sur 48 colonnes, pour les
                imprimantes pilotées en texte brut. Ce reçu est un justificatif commercial, pas un
                reçu normalisé de la DGI.
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

export default WashReceiptButton
