"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import type { LucideIcon } from "lucide-react"
import {
  Check,
  CheckCircle2,
  Receipt,
  ScrollText,
  TriangleAlert,
  Wallet,
} from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { SubmitButton } from "@/components/ui/submit-button"
import { apiFetch, apiErrorMessage } from "@/lib/api"
import {
  EXPENSE_CATEGORIES,
  EXPENSE_PAYMENT_METHODS,
  type ExpenseRecord,
} from "@/lib/expenses"
import { createIdempotencyKey } from "@/lib/idempotency"
import { formatXof, formatXofUnits } from "@/lib/format"
import { toastError, toastSuccess } from "@/lib/toast"
import { cn } from "@/lib/utils"

/* ------------------------------------------------------------------ */
/*  Formulaire                                                          */
/* ------------------------------------------------------------------ */

const expenseSchema = z.object({
  category: z.enum(
    [
      "supply",
      "salary",
      "maintenance",
      "utilities",
      "rent",
      "tax",
      "marketing",
      "other",
    ],
    { error: "Choisissez une catégorie." },
  ),
  // Le champ est saisi en francs ; la conversion en centimes se fait à l'envoi.
  amount: z
    .number({ error: "Indiquez le montant de la dépense." })
    .positive("Le montant doit être supérieur à 0.")
    .max(1_000_000, "Le montant ne peut pas dépasser 1 000 000 F CFA."),
  payment_method: z.enum(
    ["cash", "orange_money", "mtn_momo", "moov_money", "wave", "other"],
    { error: "Choisissez un moyen de paiement." },
  ),
  site_id: z.string().optional(),
  beneficiary: z.string().max(200, "200 caractères maximum.").optional(),
  description: z.string().max(1000, "1 000 caractères maximum.").optional(),
  reference: z.string().max(120, "120 caractères maximum.").optional(),
  cash_session_id: z.string().optional(),
})

type ExpenseFormData = z.infer<typeof expenseSchema>

/** Valeur sentie par la case « Station » quand aucune n'est précisée. */
const NO_SITE = "__none__"

interface Site {
  id: string
  name: string
  city: string | null
  is_active: boolean
}

interface CashSession {
  id: string
  site_id: string
  status: string
  opening_amount_cents: number
  opened_at: string
  theoretical_balance_cents: number
}

interface CreateExpenseRequest {
  category: string
  amount_cents: number
  payment_method: string
  site_id?: string
  beneficiary?: string
  description?: string
  reference?: string
  cash_session_id?: string
}

function formatSessionTime(value: string): string {
  return new Date(value).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function SectionTitle({
  icon: Icon,
  children,
}: {
  icon: LucideIcon
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
      <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {children}
      </h3>
      <div className="h-px flex-1 bg-border/60" aria-hidden="true" />
    </div>
  )
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="text-xs text-destructive">{message}</p>
}

interface CreateExpenseModalProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onExpenseCreated?: (expense: ExpenseRecord) => void
}

/**
 * « Nouvelle dépense » — saisie d'une sortie d'argent de la station.
 *
 * Le montant est saisi en francs (ce que lit le gérant), converti en centimes
 * uniquement à l'envoi. Les paiements en espèces s'appuient sur la session de
 * caisse ouverte : sélectionnée automatiquement quand elle ne fait qu'un,
 * jamais devinée quand il y en a plusieurs.
 */
export function CreateExpenseModal({
  open = false,
  onOpenChange,
  onExpenseCreated,
}: CreateExpenseModalProps) {
  const [sites, setSites] = useState<Site[]>([])
  const [cashSessions, setCashSessions] = useState<CashSession[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [savedExpense, setSavedExpense] = useState<ExpenseRecord | null>(null)

  // Une clé d'idempotency par contenu envoyé : le même formulaire renvoyé
  // deux fois (double-clic, réseau capricieux) ne crée qu'une dépense.
  const idempotencyKeys = useRef(new Map<string, string>())
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const form = useForm<ExpenseFormData>({
    resolver: zodResolver(expenseSchema),
    defaultValues: {
      payment_method: "cash",
      site_id: "",
      beneficiary: "",
      description: "",
      reference: "",
      cash_session_id: "",
    },
  })

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = form

  const category = watch("category")
  const amount = watch("amount")
  const paymentMethod = watch("payment_method")
  const siteId = watch("site_id")
  const cashSessionId = watch("cash_session_id")

  const needsCashSession = paymentMethod === "cash"
  const activeSites = useMemo(
    () => sites.filter((site) => site.is_active),
    [sites],
  )
  // Sans station choisie, toutes les caisses ouvertes restent possibles :
  // le serveur rattache alors la dépense à la station de la session.
  const sessionCandidates = useMemo(
    () =>
      siteId
        ? cashSessions.filter((session) => session.site_id === siteId)
        : cashSessions,
    [cashSessions, siteId],
  )
  const selectedSession = useMemo(
    () => cashSessions.find((session) => session.id === cashSessionId) ?? null,
    [cashSessions, cashSessionId],
  )

  const siteName = (id: string) =>
    sites.find((site) => site.id === id)?.name ?? "Station"

  // À chaque ouverture : données de référence fraîches, formulaire neuf.
  useEffect(() => {
    if (!open) {
      form.reset()
      setMutationError(null)
      setSavedExpense(null)
      return
    }

    void (async () => {
      setLoadingSessions(true)
      try {
        const [sitesRes, sessionsRes] = await Promise.all([
          apiFetch("/api/v1/sites"),
          apiFetch("/api/v1/cash-sessions?status=open"),
        ])
        if (sitesRes.ok) setSites(await sitesRes.json())
        if (sessionsRes.ok) setCashSessions(await sessionsRes.json())
      } catch {
        toastError("Erreur", "Impossible de charger les données de la station.")
      } finally {
        setLoadingSessions(false)
      }
    })()
  }, [open, form])

  // Session de caisse : une seule ouverte → retenue d'office ; plusieurs →
  // l'utilisateur choisit ; plus aucune dans la sélection → on repart propre.
  useEffect(() => {
    if (!needsCashSession) return
    const stillValid = sessionCandidates.some(
      (session) => session.id === form.getValues("cash_session_id"),
    )
    if (stillValid) return
    if (sessionCandidates.length === 1) {
      setValue("cash_session_id", sessionCandidates[0].id)
    } else {
      setValue("cash_session_id", "")
    }
  }, [needsCashSession, sessionCandidates, setValue, form])

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
    }
  }, [])

  async function onSubmit(data: ExpenseFormData) {
    setMutationError(null)

    const body: CreateExpenseRequest = {
      category: data.category,
      amount_cents: Math.round(data.amount * 100),
      payment_method: data.payment_method,
    }
    if (data.site_id) body.site_id = data.site_id
    if (data.beneficiary) body.beneficiary = data.beneficiary
    if (data.description) body.description = data.description
    if (data.reference) body.reference = data.reference
    if (needsCashSession && data.cash_session_id) {
      body.cash_session_id = data.cash_session_id
    }

    const fingerprint = JSON.stringify(body)
    let requestKey = idempotencyKeys.current.get(fingerprint)
    if (!requestKey) {
      requestKey = createIdempotencyKey()
      idempotencyKeys.current.set(fingerprint, requestKey)
    }

    try {
      const res = await apiFetch("/api/v1/expenses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestKey,
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(await apiErrorMessage(res))

      const expense = (await res.json()) as ExpenseRecord
      idempotencyKeys.current.clear()
      toastSuccess(
        "Dépense enregistrée",
        "La nouvelle dépense apparaît dans la liste.",
      )
      setSavedExpense(expense)
      onExpenseCreated?.(expense)

      // Laisse le temps de voir la confirmation avant de refermer.
      closeTimer.current = setTimeout(() => onOpenChange?.(false), 1200)
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Impossible d'enregistrer la dépense."
      setMutationError(message)
      toastError("Échec de l’enregistrement", message)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[88vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-[600px]">
        <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-5">
          <div className="flex items-start gap-3.5 pr-10">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Receipt className="size-5" aria-hidden="true" />
            </div>
            <div className="flex flex-col gap-1.5">
              <DialogTitle className="text-lg font-semibold tracking-tight">
                Nouvelle dépense
              </DialogTitle>
              <DialogDescription className="text-[13px] leading-relaxed">
                Enregistrez une nouvelle dépense pour votre station.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form
          id="create-expense-form"
          onSubmit={handleSubmit(onSubmit)}
          className="min-h-0 space-y-6 overflow-y-auto px-6 py-5"
        >
          {mutationError && (
            <Alert
              variant="destructive"
              className="border-destructive/30 bg-destructive/10"
            >
              <TriangleAlert />
              <AlertTitle>Échec de l’enregistrement</AlertTitle>
              <AlertDescription>{mutationError}</AlertDescription>
            </Alert>
          )}
          {savedExpense && (
            <Alert className="border-success/30 bg-success/10 text-success">
              <CheckCircle2 />
              <AlertTitle>Dépense enregistrée</AlertTitle>
              <AlertDescription className="text-success/90">
                {formatXof(savedExpense.amount_cents)} viennent d’être sortis de
                la caisse.
              </AlertDescription>
            </Alert>
          )}

          {/* — La dépense : le montant commande tout le reste du formulaire. */}
          <div className="space-y-4">
            <SectionTitle icon={Receipt}>La dépense</SectionTitle>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="expense-amount">Montant *</Label>
                <InputGroup className="h-11">
                  <InputGroupInput
                    id="expense-amount"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    placeholder="0"
                    className="h-11 px-3 text-lg font-semibold tabular-nums"
                    aria-invalid={errors.amount ? true : undefined}
                    {...register("amount", {
                      setValueAs: (value: string) =>
                        value === "" ? undefined : Number(value),
                    })}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupText className="font-medium">
                      F CFA
                    </InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
                {typeof amount === "number" && amount > 0 && !errors.amount && (
                  <p className="text-xs text-muted-foreground">
                    Soit {formatXofUnits(amount)}
                  </p>
                )}
                <FieldError message={errors.amount?.message} />
              </div>

              <div className="space-y-2">
                <Label htmlFor="expense-category">Catégorie *</Label>
                <Select
                  value={category || undefined}
                  onValueChange={(value: string | null) =>
                    setValue("category", (value ?? "") as ExpenseFormData["category"], {
                      shouldValidate: true,
                    })
                  }
                >
                  <SelectTrigger
                    id="expense-category"
                    className="w-full data-[size=default]:h-11"
                    aria-invalid={errors.category ? true : undefined}
                  >
                    <SelectValue placeholder="Choisir une catégorie…" />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPENSE_CATEGORIES.map((cat) => (
                      <SelectItem key={cat.value} value={cat.value}>
                        <cat.icon
                          className="text-muted-foreground"
                          aria-hidden="true"
                        />
                        {cat.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError message={errors.category?.message} />
              </div>
            </div>
          </div>

          {/* — Paiement : les moyens du quotidien en Côte d'Ivoire, d'un coup d'œil. */}
          <div className="space-y-4">
            <SectionTitle icon={Wallet}>Paiement</SectionTitle>
            <div
              role="radiogroup"
              aria-label="Moyen de paiement"
              className="grid grid-cols-2 gap-2 sm:grid-cols-3"
            >
              {EXPENSE_PAYMENT_METHODS.map((method) => {
                const selected = paymentMethod === method.value
                return (
                  <label
                    key={method.value}
                    className={cn(
                      "group relative flex cursor-pointer items-center gap-2.5 rounded-xl border p-2.5 transition-all",
                      "hover:bg-muted/60",
                      "has-[:focus-visible]:border-ring has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
                      selected
                        ? "border-primary/70 bg-primary/5 shadow-sm"
                        : "border-border",
                    )}
                  >
                    <input
                      type="radio"
                      value={method.value}
                      className="sr-only"
                      {...register("payment_method")}
                    />
                    <span
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-lg",
                        method.chip,
                      )}
                    >
                      <method.icon className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm leading-tight font-medium">
                        {method.label}
                      </span>
                    </span>
                    <Check
                      className={cn(
                        "size-4 shrink-0 text-primary transition-opacity",
                        selected ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden="true"
                    />
                  </label>
                )
              })}
            </div>
            <FieldError message={errors.payment_method?.message} />

            <div className="space-y-2">
              <Label htmlFor="expense-site">Station</Label>
              <Select
                value={siteId || NO_SITE}
                onValueChange={(value: string | null) =>
                  setValue("site_id", value === NO_SITE ? "" : (value ?? ""))
                }
              >
                <SelectTrigger
                  id="expense-site"
                  className="w-full data-[size=default]:h-11"
                >
                  <SelectValue placeholder="Choisir une station…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_SITE}>Non précisée</SelectItem>
                  {activeSites.map((site) => (
                    <SelectItem key={site.id} value={site.id}>
                      {site.name}
                      {site.city ? ` · ${site.city}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {needsCashSession
                  ? "Sans station, la dépense est rattachée à la caisse choisie ci-dessous."
                  : "Facultatif : précisez la station pour le suivi multi-sites."}
              </p>
            </div>

            {needsCashSession && (
              <div className="space-y-2">
                <Label>Session de caisse *</Label>
                {loadingSessions ? (
                  <p className="text-sm text-muted-foreground">
                    Vérification des sessions de caisse…
                  </p>
                ) : sessionCandidates.length === 0 ? (
                  <div className="rounded-xl border border-warning/40 bg-warning/10 p-3">
                    <div className="flex items-start gap-2.5">
                      <TriangleAlert
                        className="mt-0.5 size-4 text-warning"
                        aria-hidden="true"
                      />
                      <div className="flex flex-col gap-1.5 text-sm">
                        <p className="font-medium text-warning">
                          Aucune session de caisse ouverte
                          {siteId ? " pour cette station" : ""}.
                        </p>
                        <p className="text-xs text-warning/90">
                          Une dépense en espèces doit être rattachée à une caisse
                          ouverte.
                        </p>
                        <Link
                          to="/cash-drawer"
                          onClick={() => onOpenChange?.(false)}
                          className="inline-flex w-fit items-center gap-1 text-xs font-medium text-warning underline underline-offset-2 hover:text-warning/80"
                        >
                          Ouvrir la caisse
                          <span aria-hidden="true">→</span>
                        </Link>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    {sessionCandidates.length > 1 && (
                      <Select
                        value={cashSessionId || undefined}
                        onValueChange={(value: string | null) =>
                          setValue("cash_session_id", value ?? "")
                        }
                      >
                        <SelectTrigger
                          className="w-full data-[size=default]:h-11"
                          aria-label="Session de caisse"
                        >
                          <SelectValue placeholder="Choisir la session…" />
                        </SelectTrigger>
                        <SelectContent>
                          {sessionCandidates.map((session) => (
                            <SelectItem key={session.id} value={session.id}>
                              {siteName(session.site_id)} · ouverte à{" "}
                              {formatSessionTime(session.opened_at)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {selectedSession ? (
                      <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                          <Wallet className="size-4" aria-hidden="true" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            Session ouverte · {siteName(selectedSession.site_id)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Depuis {formatSessionTime(selectedSession.opened_at)}
                            {" · "}Solde théorique{" "}
                            {formatXof(selectedSession.theoretical_balance_cents)}
                          </p>
                        </div>
                        <CheckCircle2
                          className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                          aria-hidden="true"
                        />
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Sélectionnez la session de caisse qui reçoit cette
                        sortie d’argent.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* — Détails : facultatifs, on ne les met pas en travers du geste. */}
          <div className="space-y-4">
            <SectionTitle icon={ScrollText}>Détails</SectionTitle>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="expense-beneficiary">
                  Bénéficiaire{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    optionnel
                  </span>
                </Label>
                <Input
                  id="expense-beneficiary"
                  className="h-11"
                  placeholder="Nom du bénéficiaire…"
                  maxLength={200}
                  {...register("beneficiary")}
                />
                <FieldError message={errors.beneficiary?.message} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="expense-reference">
                  Référence{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    optionnel
                  </span>
                </Label>
                <Input
                  id="expense-reference"
                  className="h-11"
                  placeholder="N° de facture, reçu…"
                  maxLength={120}
                  {...register("reference")}
                />
                <FieldError message={errors.reference?.message} />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="expense-description">
                Description{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  optionnel
                </span>
              </Label>
              <Textarea
                id="expense-description"
                rows={3}
                placeholder="Objet de la dépense, détails utiles…"
                maxLength={1000}
                {...register("description")}
              />
              <FieldError message={errors.description?.message} />
            </div>
          </div>
        </form>

        <DialogFooter className="-mx-0 -mb-0 flex-col-reverse gap-3 rounded-none border-t bg-muted/50 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          {/* Le montant reste visible au moment de valider : c'est la décision. */}
          <div className="flex items-baseline justify-between gap-3 sm:justify-start">
            <span className="text-xs text-muted-foreground">
              Montant à enregistrer
            </span>
            <span className="text-lg font-bold tabular-nums">
              {formatXofUnits(
                typeof amount === "number" && amount > 0 ? amount : 0,
              )}
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11 flex-1 sm:flex-none"
              disabled={isSubmitting}
              onClick={() => onOpenChange?.(false)}
            >
              Annuler
            </Button>
            <SubmitButton
              type="submit"
              form="create-expense-form"
              className="h-11 flex-1 sm:flex-none"
              pending={isSubmitting}
              success={savedExpense !== null}
              pendingLabel="Enregistrement…"
              successLabel="Dépense enregistrée"
              idleIcon={<Receipt className="size-4" />}
              disabled={
                isSubmitting || (needsCashSession && !cashSessionId)
              }
            >
              Enregistrer la dépense
            </SubmitButton>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
