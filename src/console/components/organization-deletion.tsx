import * as React from "react"
import { useNavigate } from "react-router-dom"
import {
  CalendarClock,
  Check,
  CircleAlert,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Trash2,
  Users,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

import { consoleRequest, formatDate } from "../api"
import type { ConsoleOrganization } from "../types"

const DEFAULT_GRACE_DAYS = 30

type DeletionMode = "schedule" | "cancel" | "purge" | null

interface OrganizationDeletionFlowProps {
  organization: ConsoleOrganization
  /** Recharge la fiche après une action qui conserve la station. */
  onChanged: (message: string) => void
}

function actionError(error: unknown): string {
  return error instanceof Error ? error.message : "L'action n'a pas pu aboutir. Réessayez."
}

function sameOrganizationName(value: string, expected: string): boolean {
  return value.trim().toLocaleLowerCase("fr") === expected.trim().toLocaleLowerCase("fr")
}

/**
 * Parcours de suppression d'une station.
 *
 * Les règles restent portées par l'API : coupure immédiate, délai de grâce,
 * restauration et purge. Ce composant rend leurs conséquences lisibles avant
 * chaque geste et empêche surtout les doubles soumissions. La purge quitte la
 * fiche au lieu de recharger une organisation qui n'existe plus.
 */
export function OrganizationDeletionFlow({
  organization,
  onChanged,
}: OrganizationDeletionFlowProps) {
  const navigate = useNavigate()
  const [mode, setMode] = React.useState<DeletionMode>(null)
  const [reason, setReason] = React.useState("")
  const [graceDays, setGraceDays] = React.useState(DEFAULT_GRACE_DAYS)
  const [acknowledged, setAcknowledged] = React.useState(false)
  const [confirmName, setConfirmName] = React.useState("")
  const [dialogOpenedAt, setDialogOpenedAt] = React.useState<number | null>(null)
  const [busy, setBusy] = React.useState(false)
  const inFlight = React.useRef(false)
  const [error, setError] = React.useState<string | null>(null)

  const validGraceDays =
    Number.isInteger(graceDays) && graceDays >= 1 && graceDays <= 90
  const canSchedule =
    reason.trim().length >= 10 && validGraceDays && acknowledged
  const nameMatches = sameOrganizationName(confirmName, organization.name)
  const canPurge = nameMatches && acknowledged
  const previewDate =
    validGraceDays && dialogOpenedAt !== null
      ? new Date(dialogOpenedAt + graceDays * 86_400_000).toISOString()
      : null

  function openDialog(next: Exclude<DeletionMode, null>) {
    setError(null)
    setAcknowledged(false)
    setConfirmName("")
    setDialogOpenedAt(Date.now())
    setMode(next)
  }

  function closeDialog() {
    if (busy) return
    setMode(null)
    setError(null)
  }

  async function schedule() {
    if (!canSchedule || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const payload = await consoleRequest<{ scheduled_for: string }>(
        `/organizations/${organization.id}/schedule-deletion`,
        {
          method: "POST",
          body: JSON.stringify({ reason: reason.trim(), grace_days: graceDays }),
        },
      )
      setMode(null)
      onChanged(
        `Accès coupé. Les données sont conservées jusqu'au ${formatDate(payload.scheduled_for)}.`,
      )
    } catch (cause) {
      setError(actionError(cause))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  async function cancel() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await consoleRequest(`/organizations/${organization.id}/cancel-deletion`, {
        method: "POST",
      })
      setMode(null)
      onChanged(
        "Suppression annulée. La station est restaurée, mais son abonnement reste résilié.",
      )
    } catch (cause) {
      setError(actionError(cause))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  async function purge() {
    if (!canPurge || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const payload = await consoleRequest<{ name: string; users_deleted: number }>(
        `/organizations/${organization.id}/purge`,
        {
          method: "POST",
          body: JSON.stringify({ confirm_name: confirmName }),
        },
      )
      // Ne pas recharger la fiche : l'organisation vient de disparaître.
      navigate("/console/stations", {
        replace: true,
        state: {
          notice: `Station « ${payload.name} » effacée définitivement. ${payload.users_deleted} compte(s) utilisateur(s) supprimé(s) ; les comptes partagés avec une autre station ont été conservés.`,
        },
      })
    } catch (cause) {
      setError(actionError(cause))
      inFlight.current = false
      setBusy(false)
    }
  }

  const title =
    mode === "schedule"
      ? "Programmer la suppression"
      : mode === "cancel"
        ? "Restaurer la station"
        : "Effacer définitivement la station"
  const description =
    mode === "schedule"
      ? `Vérifiez les conséquences pour « ${organization.name} » avant de couper son accès.`
      : mode === "cancel"
        ? `Les données de « ${organization.name} » sont encore intactes.`
        : `Cette action concerne « ${organization.name} » et ne peut pas être annulée.`

  return (
    <>
      {organization.pending_deletion ? (
        <section className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
          <div className="flex items-start gap-3">
            <Trash2 className="mt-0.5 size-5 shrink-0 text-red-300" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-red-200">
                Suppression programmée
              </h2>
              <p className="mt-1 text-sm text-red-200/80">
                L'accès est coupé depuis le {formatDate(organization.deletion_requested_at)}.
                Effacement définitif prévu le {formatDate(organization.deletion_scheduled_for)}.
              </p>
              {organization.deletion_reason && (
                <p className="mt-2 rounded-lg bg-slate-950/25 px-3 py-2 text-xs text-red-100/80">
                  Motif : {organization.deletion_reason}
                </p>
              )}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-red-500/20 pt-3">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => openDialog("cancel")}
            >
              <RotateCcw className="mr-1.5 size-4" aria-hidden />
              Restaurer la station
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-red-300 hover:bg-red-500/10 hover:text-red-200"
              onClick={() => openDialog("purge")}
            >
              <Trash2 className="mr-1.5 size-4" aria-hidden />
              Effacer définitivement maintenant…
            </Button>
          </div>
        </section>
      ) : (
        <section className="rounded-xl border border-red-500/25 bg-red-500/5">
          <div className="border-b border-red-500/20 px-4 py-3">
            <h2 className="text-sm font-semibold text-red-200">Supprimer la station</h2>
            <p className="mt-0.5 text-xs text-red-200/70">
              Une suppression en deux temps : l'accès est coupé maintenant, les données sont
              effacées après un délai de grâce. La restauration reste possible avant la purge.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="max-w-2xl text-xs text-slate-400">
              Le motif, le délai et le récapitulatif de l'impact seront vérifiés à l'étape
              suivante. Aucune donnée n'est effacée lors de la programmation.
            </p>
            <Button type="button" variant="destructive" onClick={() => openDialog("schedule")}>
              <Trash2 className="mr-1.5 size-4" aria-hidden />
              Programmer la suppression…
            </Button>
          </div>
        </section>
      )}

      <Dialog
        open={mode !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog()
        }}
      >
        <DialogContent
          className="border-slate-700 bg-slate-900 p-0 text-slate-100 sm:max-w-[560px]"
          showCloseButton={!busy}
        >
          <DialogHeader className="border-b border-slate-800 px-6 py-5 pr-12">
            <DialogTitle className="text-lg text-white">{title}</DialogTitle>
            <DialogDescription className="leading-relaxed text-slate-400">
              {description}
            </DialogDescription>
          </DialogHeader>

          <form
            id="organization-deletion-form"
            className="max-h-[65vh] space-y-5 overflow-y-auto px-6 py-5"
            onSubmit={(event) => {
              event.preventDefault()
              if (mode === "schedule") void schedule()
              else if (mode === "cancel") void cancel()
              else if (mode === "purge") void purge()
            }}
          >
            {mode === "schedule" && (
              <>
                <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
                  <div className="space-y-2">
                    <Label htmlFor="deletion-reason" className="text-slate-300">
                      Motif de la suppression
                    </Label>
                    <Textarea
                      id="deletion-reason"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="Demande du client, fermeture de l'activité…"
                      maxLength={300}
                      rows={3}
                      className="border-white/15 bg-slate-950 text-white placeholder:text-slate-600"
                      required
                      minLength={10}
                      disabled={busy}
                    />
                    <p className="text-xs text-slate-500">
                      10 caractères minimum, visibles dans le journal des opérations.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="deletion-grace-days" className="text-slate-300">
                      Délai de grâce
                    </Label>
                    <div className="relative">
                      <Input
                        id="deletion-grace-days"
                        type="number"
                        min={1}
                        max={90}
                        value={graceDays}
                        onChange={(event) => setGraceDays(Number(event.target.value))}
                        className="border-white/15 bg-slate-950 pr-12 text-white"
                        disabled={busy}
                        required
                      />
                      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-500">
                        jours
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">Entre 1 et 90 jours.</p>
                  </div>
                </div>

                <ImpactSummary organization={organization} />
                <div className="space-y-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
                  <ImpactLine icon={ShieldAlert}>
                    L'accès est coupé immédiatement et toutes les sessions sont fermées.
                  </ImpactLine>
                  <ImpactLine icon={CircleAlert}>
                    L'abonnement est résilié. Une restauration ne le réactive pas automatiquement.
                  </ImpactLine>
                  <ImpactLine icon={CalendarClock}>
                    Les données sont conservées jusqu'au {previewDate ? formatDate(previewDate) : "—"},
                    puis effacées automatiquement.
                  </ImpactLine>
                </div>
                <Acknowledgement
                  id="schedule-acknowledged"
                  checked={acknowledged}
                  onChange={setAcknowledged}
                  disabled={busy}
                  label="Je confirme vouloir couper immédiatement l'accès de cette station."
                />
              </>
            )}

            {mode === "cancel" && (
              <div className="space-y-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                <ImpactLine icon={Check} tone="text-emerald-300">
                  La station et toutes ses données redeviennent accessibles.
                </ImpactLine>
                <ImpactLine icon={CircleAlert} tone="text-amber-300">
                  L'abonnement reste résilié : il faudra le réactiver séparément si nécessaire.
                </ImpactLine>
                <ImpactLine icon={CalendarClock} tone="text-emerald-300">
                  La purge prévue le {formatDate(organization.deletion_scheduled_for)} est annulée.
                </ImpactLine>
              </div>
            )}

            {mode === "purge" && (
              <>
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold text-red-200">
                    <CircleAlert className="size-4" aria-hidden />
                    Action irréversible
                  </p>
                  <p className="mt-2 text-sm leading-relaxed text-red-100/80">
                    Les lavages, encaissements, caisses, dépenses, stocks, achats, équipes et
                    paramètres de cette station seront définitivement effacés. Aucune restauration
                    ne sera possible ensuite.
                  </p>
                </div>
                <ImpactSummary organization={organization} />
                <p className="text-xs leading-relaxed text-slate-400">
                  Les comptes utilisateurs rattachés à une autre station sont conservés. Le registre
                  comptable de la plateforme et la trace de cette intervention le sont également.
                </p>
                <div className="space-y-2">
                  <Label htmlFor="purge-confirm-name" className="text-slate-300">
                    Saisissez le nom exact de la station
                  </Label>
                  <Input
                    id="purge-confirm-name"
                    value={confirmName}
                    onChange={(event) => setConfirmName(event.target.value)}
                    placeholder={organization.name}
                    autoComplete="off"
                    className="border-red-500/30 bg-slate-950 text-white placeholder:text-slate-600"
                    disabled={busy}
                    required
                  />
                  {confirmName && !nameMatches && (
                    <p className="text-xs text-red-300">
                      Le nom saisi ne correspond pas à « {organization.name} ».
                    </p>
                  )}
                </div>
                <Acknowledgement
                  id="purge-acknowledged"
                  checked={acknowledged}
                  onChange={setAcknowledged}
                  disabled={busy}
                  label="Je comprends que l'effacement est immédiat et définitivement irréversible."
                />
              </>
            )}

            {error && (
              <p
                role="alert"
                className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200"
              >
                {error}
              </p>
            )}
          </form>

          <DialogFooter className="-mx-0 -mb-0 flex-col-reverse gap-2 rounded-none border-t border-slate-800 bg-slate-950/40 px-6 py-4 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              className="text-slate-300"
              onClick={closeDialog}
              disabled={busy}
            >
              Annuler
            </Button>
            <Button
              type="submit"
              form="organization-deletion-form"
              variant={mode === "cancel" ? "default" : "destructive"}
              disabled={
                busy ||
                (mode === "schedule" && !canSchedule) ||
                (mode === "purge" && !canPurge)
              }
            >
              {busy && <Loader2 className="mr-1.5 size-4 animate-spin" aria-hidden />}
              {busy
                ? "Traitement…"
                : mode === "schedule"
                  ? "Couper l'accès et programmer"
                  : mode === "cancel"
                    ? "Restaurer la station"
                    : "Effacer définitivement"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ImpactSummary({ organization }: { organization: ConsoleOrganization }) {
  return (
    <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
      <div>
        <p className="flex items-center gap-1.5 text-xs text-slate-500">
          <Users className="size-3.5" aria-hidden /> Comptes actifs rattachés
        </p>
        <p className="mt-1 text-lg font-semibold text-white">{organization.member_count}</p>
      </div>
      <div>
        <p className="text-xs text-slate-500">Sites actifs rattachés</p>
        <p className="mt-1 text-lg font-semibold text-white">{organization.site_count}</p>
      </div>
    </div>
  )
}

function ImpactLine({
  icon: Icon,
  tone = "text-amber-300",
  children,
}: {
  icon: LucideIcon
  tone?: string
  children: React.ReactNode
}) {
  return (
    <p className="flex items-start gap-2 text-xs leading-relaxed text-slate-300">
      <Icon className={`mt-0.5 size-3.5 shrink-0 ${tone}`} aria-hidden />
      <span>{children}</span>
    </p>
  )
}

function Acknowledgement({
  id,
  checked,
  onChange,
  disabled,
  label,
}: {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled: boolean
  label: string
}) {
  return (
    <Label htmlFor={id} className="flex cursor-pointer items-start gap-3 text-sm font-normal text-slate-200">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        disabled={disabled}
        className="mt-0.5 border-slate-600"
      />
      <span>{label}</span>
    </Label>
  )
}
