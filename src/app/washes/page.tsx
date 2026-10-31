"use client"

import { useEffect, useMemo, useState, type FormEvent } from "react"
import { Link, useSearchParams, useViewTransitionState } from "react-router-dom"
import { BaseLayout } from "@/components/layouts/base-layout"
import { useAccess } from "@/lib/permissions"
import { BlockedReason } from "@/components/access/blocked-reason"
import {
  isWashButtonClickable,
  resolvePendingOpen,
  washButtonState,
  washPrerequisites,
  washSubmitBlockedReason,
} from "@/lib/action-blocking"
import { apiErrorMessage, apiFetch, useApi } from "@/lib/api"
import { createIdempotencyKey } from "@/lib/idempotency"
import { isNetworkError } from "@/lib/offline-queue"
import { enqueueMutation } from "@/lib/offline-sync"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { plateKey } from "@/lib/plate"
import { configuredPriceFor, isEligibleFor } from "@/lib/service-pricing"
import { VEHICLE_FAMILIES, familyOrder } from "@/config/vehicle-taxonomy"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TableSkeleton } from "@/components/ui/table-skeleton"
import {
  ResponsiveTable,
  SortableHead,
  TableEmptyRow,
  TableErrorRow,
  TablePagination,
  TableToolbar,
  useDataTable,
  type ColumnDefinition,
} from "@/components/ui/data-table"
import { formatDateTime, formatXof } from "@/lib/format"
import {
  OperationStatusBadge,
} from "@/components/washes/operation-status-badge"
import { ActiveWashTasks } from "@/components/washes/active-wash-tasks"
import { taskLabel } from "@/lib/wash-tasks"
import { toast } from "@/components/ui/toast"
import { OPERATION_STATUS_LABELS, type OperationStatus } from "@/lib/wash-operation-status"
import { SubmitButton } from "@/components/ui/submit-button"
import { Skeleton } from "@/components/ui/skeleton"
import { useSuccessFlash } from "@/hooks/use-success-flash"
import { WashReceiptButton } from "@/components/receipt/wash-receipt"
import { ArrowRight, Check, Droplets, Loader2, Lock, Plus } from "lucide-react"

interface Site {
  id: string
  name: string
  city: string | null
  is_active: boolean
}

interface VehicleCategory {
  id: string
  name: string
  family?: string | null
  is_active: boolean
}

interface Service {
  id: string
  category_id: string | null
  name: string
  price_cents: number
  /**
   * Tarifs propres à un véhicule : par identifiant de catégorie ou par code de
   * famille. Facultatif — un serveur plus ancien que l'écran ne l'envoie pas.
   */
  price_by_vehicle_type?: Record<string, number> | null
  /**
   * Catégories autorisées et leur tarif (modèle explicite). La présence de la
   * clé est l'autorisation ; une clé absente = indisponible, sans repli.
   */
  vehicle_prices?: Record<string, number> | null
  is_active: boolean
}

interface Worker {
  id: string
  first_name: string
  last_name: string
  role: string
  status: string
}

interface CashSession {
  id: string
  status: string
}

interface VehicleHistory {
  plate: string | null
  visits: number
  cancelled: number
  total_cents: number
  first_visit_at: string | null
  last_visit_at: string | null
}

interface Wash {
  plate: string | null
  id: string
  reference: string
  site_id: string | null
  vehicle_category_id: string | null
  total_cents: number
  status: string
  operation_status: string
  operation_started_at: string | null
  estimated_minutes: number | null
  customer_name: string | null
  /**
   * Les laveurs affectes. Facultatif : un serveur plus ancien que l'ecran
   * ne les envoie pas encore.
   */
  washers?: Array<{ id: string; name: string; role: string }>
  payment_status: string
  created_at: string
}

const paymentMethods = [
  { value: "cash", label: "Espèces" },
  { value: "orange_money", label: "Orange Money" },
  { value: "mtn_momo", label: "MTN MoMo" },
  { value: "moov_money", label: "Moov Money" },
  { value: "wave", label: "Wave" },
  { value: "other", label: "Autre" },
]

function parseXofAmount(value: string): number | null {
  if (!value.trim()) return null
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) return null
  const cents = Math.round(amount * 100)
  return Number.isSafeInteger(cents) ? cents : null
}

function paymentStatusLabel(status: string): string {
  if (status === "paid") return "Payé"
  if (status === "partial") return "Partiel"
  if (status === "refunded") return "Remboursé"
  if (status === "unpaid") return "Non payé"
  return status
}

/**
 * Référence du lavage : pendant la navigation vers la fiche, cet élément porte
 * le même `view-transition-name` que le titre de la page de détail. Le
 * navigateur fait glisser l'un vers l'autre — on comprend d'où vient l'écran.
 */
function WashReference({ washId, reference }: { washId: string; reference: string }) {
  const isTransitioning = useViewTransitionState(`/washes/${washId}`)
  return (
    <span
      style={{ viewTransitionName: isTransitioning ? "wash-reference" : undefined }}
    >
      {reference}
    </span>
  )
}

export default function WashesPage() {
  const createWash = useAccess("wash:create", "washes.create")
  const [selectedSiteId, setSelectedSiteId] = useState("")
  const sitePath = "/api/v1/sites"
  const { data: sites, loading: sitesLoading, error: sitesError } = useApi<Site[]>(sitePath)
  const { data: categories, loading: categoriesLoading, error: categoriesError } =
    useApi<VehicleCategory[]>("/api/v1/vehicle-categories")
  const { data: serviceCatalog, loading: servicesLoading, error: servicesError } =
    useApi<Service[]>("/api/v1/services")
  const { data: workers, loading: workersLoading, error: workersError } =
    useApi<Worker[]>("/api/v1/workers")

  const siteId = selectedSiteId || sites?.[0]?.id || ""
  const [refreshKey, setRefreshKey] = useState(0)
  const { data: cashSession, loading: cashSessionLoading } = useApi<CashSession | null>(
    siteId ? `/api/v1/cash-sessions/current?site_id=${encodeURIComponent(siteId)}&refresh=${refreshKey}` : ""
  )
  const { data: washesData, loading: washesLoading, error: washesError } = useApi<Wash[]>(
    `/api/v1/washes?refresh=${refreshKey}`
  )
  const [searchParams, setSearchParams] = useSearchParams()
  // `?new=1` ouvre le formulaire : c'est la cible du bouton « Nouveau lavage »
  // de l'en-tête, de la barre mobile et du raccourci N. L'URL reste partageable
  // et un rechargement ne referme pas le formulaire sous les doigts.
  const requestedNew = searchParams.get("new") === "1"
  const [formOpen, setFormOpen] = useState(false)
  // Clic reçu avant que les droits soient connus : on le garde pour l'honorer
  // dès qu'ils arrivent, plutôt que de griser le bouton par précaution.
  const [openRequested, setOpenRequested] = useState(false)
  const [vehicleCategoryId, setVehicleCategoryId] = useState("")
  const [plate, setPlate] = useState("")
  // Plaque figee apres une pause de frappe : sans cela, on interrogerait le
  // serveur a chaque caractere pendant que le caissier tape.
  const [plateSettled, setPlateSettled] = useState("")

  useEffect(() => {
    const timer = window.setTimeout(() => setPlateSettled(plate), 400)
    return () => window.clearTimeout(timer)
  }, [plate])

  const plateLookup = plateKey(plateSettled)
  // On n'interroge qu'a partir de quatre caracteres : en dessous, la saisie
  // est trop partielle pour designer un vehicule.
  const { data: vehicleHistory } = useApi<VehicleHistory>(
    plateLookup && plateLookup.length >= 4 ? `/api/v1/vehicles/${encodeURIComponent(plateLookup)}` : "",
  )
  const [quantities, setQuantities] = useState<Record<string, number>>({})
  const [selectedWorkerIds, setSelectedWorkerIds] = useState<string[]>([])
  const [principalWorkerId, setPrincipalWorkerId] = useState<string | null>(null)
  const [paymentMethod, setPaymentMethod] = useState("cash")
  const [amountReceived, setAmountReceived] = useState("0")
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Coche verte du bouton après enregistrement, puis retour à l'état normal.
  const [saveSuccess, flashSaveSuccess] = useSuccessFlash()
  // Identifiant du dernier lavage créé : sa ligne est surlignée une seconde
  // dans l'historique, pour que l'œil retrouve immédiatement l'opération.
  const [highlightedWashId, setHighlightedWashId] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [mutationSuccess, setMutationSuccess] = useState<string | null>(null)
  /**
   * Lavage qui vient d'être intégralement réglé.
   *
   * Le reçu n'est pas émis tout seul : une ligne d'émission veut dire qu'un
   * papier est sorti. On le propose donc en un clic, juste après la vente,
   * tant que le client est encore devant le comptoir.
   */
  const [washToReceipt, setWashToReceipt] = useState<{ id: string; reference: string } | null>(null)
  // Lavages dont l'avancement est en cours de changement : leur pastille est
  // figee tant que la reponse du serveur n'est pas revenue.
  const [advancingWashIds, setAdvancingWashIds] = useState<string[]>([])
  // Avancement affichée localement, le temps que la liste se recharge.
  // sans cela, la pastille ne bougerait qu'après un aller-retour reseau.
  const [operationOverrides, setOperationOverrides] = useState<Record<string, OperationStatus>>({})
  // Erreur d'avancement : elle se lit dans l'historique, la ou le geste a ete
  // fait, et non dans le formulaire de creation, qui n'a rien a voir.
  const [advanceError, setAdvanceError] = useState<string | null>(null)
  const advanceStatus = useAccess("wash:status")
  // Nom du client saisi au comptoir. Une etiquette, pas une fiche : ni
  // telephone, ni historique.
  const [customerName, setCustomerName] = useState("")

  // Deux listes, deux usages distincts.
  //
  // « allSites » sert à retrouver le nom d'une station dans l'historique :
  // fermer une station ne doit pas effacer le nom des lavages déjà passés.
  // « activeSites » sert au formulaire : on n'enregistre pas une vente sur
  // une station qui ne tourne plus.
  const allSites = sites ?? []
  const activeSites = allSites.filter((site) => site.is_active)

  const washFormBlocked = washButtonState({
    sitesLoading,
    accessLoading: createWash.loading,
    activeSiteCount: activeSites.length,
    allowed: createWash.allowed,
    reason: createWash.reason,
  })
  // Le bouton reste actif tant qu'on ne sait pas : un clic reçu pendant
  // l'attente est honoré dès que les droits arrivent, ou abandonné si le
  // refus se confirme — auquel cas le motif est déjà affiché sous le bouton.
  const pendingOutcome = resolvePendingOpen(washFormBlocked)
  // Dérivé plutôt que recopié dans un effet : un clic en attente ouvre le
  // formulaire de lui-même dès que les droits le permettent, et s'efface tout
  // seul si le refus se confirme — le motif est alors déjà sous le bouton.
  const awaitingRights = openRequested && pendingOutcome === "attendre"
  const showForm = requestedNew || formOpen || (openRequested && pendingOutcome === "ouvrir")
  const closeForm = () => {
    setFormOpen(false)
    setOpenRequested(false)
    if (requestedNew) {
      const next = new URLSearchParams(searchParams)
      next.delete("new")
      setSearchParams(next, { replace: true })
    }
  }
  const activeCategories = useMemo(
    () => (categories ?? []).filter((item) => item.is_active),
    [categories],
  )
  // Sélecteur groupé par famille, dans l'ordre du référentiel. Les catégories
  // sans famille connue restent accessibles, en fin de liste.
  const categoryGroups = useMemo(() => {
    const known = VEHICLE_FAMILIES.map((family) => ({
      code: family.code as string | null,
      label: family.label,
      categories: activeCategories
        .filter((category) => category.family === family.code)
        .sort((a, b) => a.name.localeCompare(b.name, "fr-CI")),
    })).filter((group) => group.categories.length > 0)
    const others = activeCategories
      .filter((category) => !category.family || familyOrder(category.family) >= VEHICLE_FAMILIES.length)
      .sort((a, b) => a.name.localeCompare(b.name, "fr-CI"))
    if (others.length > 0) {
      known.push({ code: null, label: "Autres véhicules", categories: others })
    }
    return known
  }, [activeCategories])
  const activeServices = (serviceCatalog ?? []).filter((item) => item.is_active)
  const activeWorkers = (workers ?? []).filter((worker) => worker.status === "active")

  const washes = washesData ?? []

  // -------------------------------------------------------------------------
  // Historique : recherche instantanée, filtres persistants, tri, colonnes.
  // -------------------------------------------------------------------------
  const tableColumns: ColumnDefinition[] = [
    { id: "reference", label: "Référence", required: true },
    { id: "plate", label: "Plaque" },
    { id: "site", label: "Station" },
    { id: "category", label: "Catégorie" },
    { id: "total", label: "Total" },
    { id: "status", label: "Statut" },
    { id: "payment", label: "Paiement" },
    { id: "date", label: "Date" },
  ]

  const siteName = (id: string | null) =>
    allSites.find((site) => site.id === id)?.name ?? "—"
  const categoryName = (id: string | null) =>
    (categories ?? []).find((category) => category.id === id)?.name ?? "—"

  const dataTable = useDataTable<Wash>({
    storageKey: "washpilot:table:lavages",
    rows: washes,
    columns: tableColumns,
    initialSort: { column: "date", direction: "desc" },
    searchText: (wash) =>
      [
        wash.reference,
        wash.plate ?? "",
        wash.customer_name ?? "",
        siteName(wash.site_id),
        categoryName(wash.vehicle_category_id),
        paymentStatusLabel(wash.payment_status),
      ].join(" "),
    sorters: {
      reference: (a, b) => a.reference.localeCompare(b.reference),
      plate: (a, b) => (a.plate ?? "").localeCompare(b.plate ?? ""),
      site: (a, b) => siteName(a.site_id).localeCompare(siteName(b.site_id)),
      category: (a, b) =>
        categoryName(a.vehicle_category_id).localeCompare(categoryName(b.vehicle_category_id)),
      total: (a, b) => a.total_cents - b.total_cents,
      payment: (a, b) =>
        paymentStatusLabel(a.payment_status).localeCompare(paymentStatusLabel(b.payment_status)),
      date: (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    },
    initialFilters: { status: "", site: "" },
    filterPredicates: {
      status: (wash, value) =>
        value === "cancelled"
          ? wash.status === "cancelled"
          : wash.status !== "cancelled" &&
            (currentOperationStatus(wash.id) ?? wash.operation_status) === value,
      site: (wash, value) => wash.site_id === value,
    },
  })

  /**
   * L'avancement affichee d'un lavage.
   *
   * L'affichage local prime sur la valeur du serveur tant qu'il n'a pas ete
   * confirme : c'est lui qui donne au doigt la sensation que la pastille a
   * repondu. Le serveur reste seul juge — des qu'il tranche, c'est sa valeur
   * qui s'affiche.
   */
  function currentOperationStatus(washId: string): OperationStatus | undefined {
    const wash = washes.find((item) => item.id === washId)
    if (!wash) return undefined
    const override = operationOverrides[washId]
    if (!override) return wash.operation_status as OperationStatus
    // Tant que l'ecriture est en cours, l'ecran montre la valeur posee.
    if (advancingWashIds.includes(washId)) return override
    // Sinon le serveur a tranche : s'il dit autre chose, c'est lui qui compte.
    if (wash.operation_status === override) return override
    return wash.operation_status as OperationStatus
  }

  /**
   * Les taches que la station a en main.
   *
   * Ce qui attend encore et ce qui tourne. Un lavage annule n'en fait pas
   * partie : il est annule, c'est tout, et une carte qui compte du temps
   * pour un travail qui n'aura pas lieu serait un mensonge de plus.
   *
   * L'avancement local compte aussi : une carte qui vient de demarrer doit
   * le montrer tout de suite, sans attendre le rafraichissement.
   */
  const tachesActives = washes
    .filter((wash) => wash.status !== "cancelled")
    .map((wash) => ({
      ...wash,
      operation_status: currentOperationStatus(wash.id) ?? wash.operation_status,
    }))
    .filter(
      (wash) => wash.operation_status === "pending" || wash.operation_status === "in_progress" || wash.operation_status === "overtime",
    )

  // Véhicule retenu : sa catégorie. C'est elle qui décide de l'éligibilité
  // et du prix, comme côté serveur — un seul calcul, une seule vérité.
  const selectedVehicle = useMemo(() => {
    const category = activeCategories.find((item) => item.id === vehicleCategoryId)
    return category ? { id: category.id, family: category.family ?? null } : null
  }, [activeCategories, vehicleCategoryId])

  // Prestations offertes pour le véhicule retenu : une prestation non
  // autorisée pour sa catégorie n'est même pas proposée — elle ne peut donc
  // pas finir dans le panier. Sans véhicule choisi, la liste reste complète
  // mais les tarifs sont annoncés « selon la catégorie ».
  const eligibleServices = useMemo(
    () =>
      selectedVehicle
        ? activeServices.filter((service) => isEligibleFor(service, selectedVehicle.id))
        : activeServices,
    [activeServices, selectedVehicle],
  )

  const selectedServices = useMemo(
    () =>
      activeServices.filter(
        (service) =>
          (quantities[service.id] ?? 0) > 0 &&
          (!selectedVehicle || isEligibleFor(service, selectedVehicle.id)),
      ),
    [activeServices, quantities, selectedVehicle]
  )
  // Tant qu'une de ces listes charge, on ne conclut rien : annoncer « aucune
  // station » pendant une seconde ferait croire à une installation vide.
  const setupLoading = sitesLoading || servicesLoading || workersLoading
  const missingSetup = washPrerequisites({
    activeSiteCount: activeSites.length,
    activeServiceCount: activeServices.length,
    activeWorkerCount: activeWorkers.length,
  })

  const totalCents = selectedServices.reduce(
    (total, service) =>
      total + (configuredPriceFor(service, selectedVehicle?.id ?? null) ?? 0) * (quantities[service.id] ?? 0),
    0
  )
  const amountReceivedCents = parseXofAmount(amountReceived)
  const amountIsValid = amountReceivedCents != null && amountReceivedCents <= totalCents
  const cashNeedsSession = amountReceivedCents != null && amountReceivedCents > 0 && paymentMethod === "cash"

  const submitBlockedReason = washSubmitBlockedReason({
    allowed: createWash.allowed,
    accessReason: createWash.reason,
    siteId,
    vehicleCategoryId,
    selectedServiceCount: selectedServices.length,
    assignedWorkerCount: selectedWorkerIds.length,
    amountIsValid,
    cashNeedsSession,
    cashSessionLoading,
    hasCashSession: Boolean(cashSession),
  })

  function markFormChanged() {
    setIdempotencyKey(null)
    setMutationError(null)
    setMutationSuccess(null)
    setWashToReceipt(null)
  }

  /**
   * Changer la catégorie du véhicule purge le panier des prestations qui ne
   * sont plus autorisées : une case cochée ne doit jamais survivre à
   * l'interdiction, ni en silence ni en espérant un prix de repli.
   */
  function chooseVehicleCategory(value: string) {
    setVehicleCategoryId(value)
    const category = activeCategories.find((item) => item.id === value)
    if (!category) return
    setQuantities((previous) => {
      const next = { ...previous }
      for (const service of activeServices) {
        if (next[service.id] != null && !isEligibleFor(service, category.id)) {
          delete next[service.id]
        }
      }
      return next
    })
  }

  function toggleService(serviceId: string, checked: boolean) {
    markFormChanged()
    setQuantities((current) => {
      const next = { ...current }
      if (checked) next[serviceId] = 1
      else delete next[serviceId]
      return next
    })
  }

  function changeQuantity(serviceId: string, rawValue: string) {
    const quantity = Number(rawValue)
    markFormChanged()
    setQuantities((current) => {
      const next = { ...current }
      if (!Number.isInteger(quantity) || quantity < 1) delete next[serviceId]
      else next[serviceId] = Math.min(quantity, 100)
      return next
    })
  }

  function toggleWorker(workerId: string, checked: boolean) {
    markFormChanged()
    setSelectedWorkerIds((current) => {
      const next = checked ? [...current, workerId] : current.filter((id) => id !== workerId)
      // Si le responsable principal n'est plus sélectionné, on le dégage.
      if (principalWorkerId && !next.includes(principalWorkerId)) {
        setPrincipalWorkerId(null)
      }
      return next
    })
  }

  function setPrincipal(workerId: string | null) {
    // Le responsable doit figurer parmi les laveurs sélectionnés.
    if (workerId && !selectedWorkerIds.includes(workerId)) return
    setPrincipalWorkerId(workerId)
    markFormChanged()
  }

  async function submitWash(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    // Double soumission : le bouton est déjà désactivé pendant l'envoi, mais
    // un double appui au clavier ou un second onglet peut appeler cette
    // fonction. La clé d'idempotence protège le serveur ; ce garde protège
    // l'utilisateur d'un second message contradictoire.
    if (saving) return
    setMutationError(null)
    setMutationSuccess(null)
    // Le reçu de la vente précédente ne doit jamais survivre à celle-ci.
    setWashToReceipt(null)

    if (!siteId || !vehicleCategoryId || selectedServices.length === 0) {
      setMutationError("Choisissez une station, une catégorie et au moins une prestation.")
      return
    }
    if (selectedWorkerIds.length === 0) {
      setMutationError("Indiquez qui lave ce véhicule avant de valider.")
      return
    }
    if (amountReceivedCents == null || amountReceivedCents > totalCents) {
      setMutationError("Le montant reçu doit être valide et ne pas dépasser le total.")
      return
    }
    if (cashNeedsSession && (cashSessionLoading || !cashSession)) {
      setMutationError("Ouvrez d’abord une session de caisse pour enregistrer un paiement en espèces.")
      return
    }

    const requestKey = idempotencyKey ?? createIdempotencyKey()
    setIdempotencyKey(requestKey)
    setSaving(true)

    // Sorti de l'appel : le même corps doit pouvoir repartir plus tard, à
    // l'identique, si le réseau manque maintenant.
    const payload = {
      site_id: siteId,
      vehicle_category_id: vehicleCategoryId,
      ...(plate.trim() ? { plate: plate.trim() } : {}),
      ...(customerName.trim() ? { customer_name: customerName.trim() } : {}),
      items: selectedServices.map((service) => ({
        service_id: service.id,
        quantity: quantities[service.id],
      })),
      worker_ids: selectedWorkerIds,
      ...(principalWorkerId ? { principal_worker_id: principalWorkerId } : {}),
      payment_method: paymentMethod,
      amount_received_cents: amountReceivedCents,
      ...(cashNeedsSession && cashSession ? { cash_session_id: cashSession.id } : {}),
    }

    try {
      const response = await apiFetch(
        "/api/v1/washes",
        {
          method: "POST",
          headers: { "Idempotency-Key": requestKey },
          body: JSON.stringify(payload),
        }
      )
      if (!response.ok) {
        throw new Error((await response.text()) || `Erreur ${response.status}`)
      }
      const replayed = response.headers.get("Idempotency-Replayed") === "true"
      const created = (await response.json().catch(() => null)) as
        | { id?: string; reference?: string; payment_status?: string }
        | null
      if (created?.id) setHighlightedWashId(created.id)
      setWashToReceipt(
        created?.id && created.payment_status === "paid"
          ? { id: created.id, reference: created.reference ?? "" }
          : null,
      )
      flashSaveSuccess()
      setMutationSuccess(replayed ? "Cette opération avait déjà été enregistrée." : "Lavage enregistré avec succès.")
      toast.add({
        type: "success",
        title: replayed ? "Lavage déjà enregistré" : "Lavage enregistré",
        description: created?.reference
          ? `Référence ${created.reference}.${created.payment_status === "paid" ? " Payé en totalité." : ""}`
          : "L’opération est prise en compte.",
      })
      setQuantities({})
      setSelectedWorkerIds([])
      setPrincipalWorkerId(null)
      setVehicleCategoryId("")
      setPlate("")
      setCustomerName("")
      setAmountReceived("0")
      setIdempotencyKey(null)
      setRefreshKey((key) => key + 1)
      closeForm()
    } catch (err) {
      // Réseau coupé : la vente est conservée sur l'appareil et repartira
      // seule. La clé d'idempotence voyage avec elle — c'est elle qui
      // empêchera un doublon si la requête était déjà passée sans que la
      // réponse nous revienne.
      if (isNetworkError(err)) {
        const total = Math.round(totalCents / 100).toLocaleString("fr-FR")
        const queued = await enqueueMutation({
          url: "/api/v1/washes",
          method: "POST",
          body: payload,
          headers: { "Idempotency-Key": requestKey },
          offline: { label: `Lavage ${total} F` },
        })
        if (queued) {
          setMutationSuccess(
            "Pas de réseau : le lavage est enregistré sur cet appareil et sera envoyé automatiquement.",
          )
          toast.add({
            type: "info",
            title: "Lavage enregistré sur cet appareil",
            description: "Il partira automatiquement au retour du réseau. Rien n’est perdu.",
          })
          setQuantities({})
          setSelectedWorkerIds([])
          setPrincipalWorkerId(null)
          setVehicleCategoryId("")
          setPlate("")
          setCustomerName("")
          setAmountReceived("0")
          setIdempotencyKey(null)
          closeForm()
          setSaving(false)
          return
        }
      }
      // Keep the key while the payload stays unchanged: retrying after a lost
      // response returns the original record instead of creating a duplicate.
      const message = err instanceof Error ? err.message : "Impossible d’enregistrer le lavage."
      setMutationError(message)
      toast.add({
        type: "error",
        title: "Lavage non enregistré",
        description: `${message} Vérifiez les informations, puis réessayez.`,
      })
    } finally {
      setSaving(false)
    }
  }

  /**
   * Ecrit l'avancement du lavage. Leve si le serveur refuse.
   *
   * Un seul endroit ecrit, donc un seul endroit peut se tromper : le bouton
   * de l'historique, la carte de la tache et la fin automatique du decompte
   * passent tous par la meme porte.
   */
  async function writeOperationStatus(washId: string, next: OperationStatus): Promise<void> {
    const response = await apiFetch(`/api/v1/washes/${washId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: next }),
    })
    if (!response.ok) {
      throw new Error(await apiErrorMessage(response))
    }
  }

  /**
   * Fait avancer l'avancement d'un lavage d'un cran.
   *
   * L'affichage bouge tout de suite, avant l'aller-retour reseau : sur le
   * terrain, la pasteille doit repondre au doigt. Si le serveur refuse, on
   * remet l'ancien et on dit pourquoi — un affichage optimiste qui laisse
   * croire a un changement annule serait pire que pas d'affichage du tout.
   */
  async function advanceWashStatus(washId: string, next: OperationStatus) {
    const precedent = currentOperationStatus(washId)
    setAdvancingWashIds((ids) => [...ids, washId])
    setOperationOverrides((overrides) => ({ ...overrides, [washId]: next }))
    setAdvanceError(null)
    try {
      await writeOperationStatus(washId, next)
      setRefreshKey((key) => key + 1)
      toast.add({
        type: "success",
        title: "Statut du lavage mis à jour",
        description: `Le lavage est maintenant « ${OPERATION_STATUS_LABELS[next] ?? next} ».`,
      })
    } catch (err) {
      setOperationOverrides((overrides) => {
        const suivant = { ...overrides }
        if (precedent) suivant[washId] = precedent
        else delete suivant[washId]
        return suivant
      })
      setAdvanceError(
        err instanceof Error ? err.message : "Impossible de changer l’avancement de ce lavage.",
      )
    } finally {
      setAdvancingWashIds((ids) => ids.filter((id) => id !== washId))
    }
  }

  /**
   * Lance le decompte d'une tache.
   *
   * C'est le clic sur la carte : le serveur note l'instant du depart, et
   * l'ecran ne fait plus que compter.
   */
  async function startTask(washId: string) {
    setAdvancingWashIds((ids) => [...ids, washId])
    setAdvanceError(null)
    try {
      await writeOperationStatus(washId, "in_progress")
      setRefreshKey((key) => key + 1)
      toast.add({
        type: "success",
        title: "Lavage démarré",
        description: "Le décompte est lancé pour cette tâche.",
      })
    } catch (err) {
      setAdvanceError(
        err instanceof Error ? err.message : "Impossible de démarrer cette tâche.",
      )
    } finally {
      setAdvancingWashIds((ids) => ids.filter((id) => id !== washId))
    }
  }

  /**
   * Termine une tache.
   *
   * La carte disparait, la tache rejoint l'historique, et le comptoir est
   * prevenu par une notification : une tache terminee sans bruit est une
   * tache dont personne ne sait qu'elle l'est.
   */
  async function finishTask(washId: string) {
    const wash = washes.find((item) => item.id === washId)
    setAdvancingWashIds((ids) => [...ids, washId])
    setAdvanceError(null)
    try {
      await writeOperationStatus(washId, "completed")
      setRefreshKey((key) => key + 1)
      toast.add({
        type: "success",
        title: "Tâche terminée",
        description: `${taskLabel(wash)} — le lavage est terminé et rejoint l’historique.`,
      })
    } catch (err) {
      setAdvanceError(
        err instanceof Error ? err.message : "Impossible de terminer cette tâche.",
      )
    } finally {
      setAdvancingWashIds((ids) => ids.filter((id) => id !== washId))
    }
  }

  async function moveToOvertime(washId: string) {
    setAdvancingWashIds((ids) => [...ids, washId])
    setAdvanceError(null)
    try {
      await writeOperationStatus(washId, "overtime")
      setRefreshKey((key) => key + 1)
    } catch (_err) {
      // If can't move to overtime, just ask to finish
      finishTask(washId)
    } finally {
      setAdvancingWashIds((ids) => ids.filter((id) => id !== washId))
    }
  }

  return (
    <BaseLayout title="Lavages" description="Enregistrement et historique des lavages." hideHeading>
      <div className="space-y-6 p-4">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-bold tracking-tight">Lavages</h1>
            <p className="text-muted-foreground">
              Enregistrez un lavage et consultez son historique détaillé.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex min-w-56 flex-col gap-1 text-sm font-medium">
              Station
              <select
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={siteId}
                onChange={(event) => {
                  setSelectedSiteId(event.target.value)
                  markFormChanged()
                }}
                disabled={sitesLoading || activeSites.length === 0}
              >
                {activeSites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}{site.city ? ` — ${site.city}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-1.5">
              <Button
                onClick={() => {
                  setMutationError(null)
                  setMutationSuccess(null)
                  if (washFormBlocked.preparing) {
                    setOpenRequested(true)
                    return
                  }
                  if (showForm) {
                    closeForm()
                    return
                  }
                  setFormOpen(true)
                }}
                disabled={!isWashButtonClickable(washFormBlocked)}
                aria-busy={awaitingRights}
                title={washFormBlocked.reason ?? undefined}
              >
                {awaitingRights ? (
                  <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                ) : washFormBlocked.denied ? (
                  <Lock className="mr-2 size-4" />
                ) : (
                  <Plus className="mr-2 size-4" />
                )}{" "}
                Nouveau lavage
              </Button>
              <BlockedReason reason={washFormBlocked.reason} className="max-w-72" />
            </div>
          </div>
        </div>

        {!setupLoading && missingSetup.length > 0 && (
          <section
            className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4"
            aria-labelledby="mise-en-route"
          >
            <h2 id="mise-en-route" className="text-sm font-semibold">
              Avant d&apos;enregistrer un premier lavage
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Il manque {missingSetup.length === 1 ? "une chose" : `${missingSetup.length} choses`} pour
              pouvoir encaisser. Chaque point se règle en une minute.
            </p>
            <ul className="mt-3 space-y-2">
              {missingSetup.map((item) => (
                <li
                  key={item.to}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-3 py-2"
                >
                  <span className="text-sm">
                    <span className="font-medium">{item.label}</span>{" "}
                    <span className="text-muted-foreground">{item.why}</span>
                  </span>
                  <Link to={item.to} className={buttonVariants({ size: "sm", variant: "outline" })}>
                    {item.action}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(sitesError || categoriesError || servicesError || workersError) && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {[sitesError, categoriesError, servicesError, workersError].filter(Boolean).join(" · ")}
          </div>
        )}
        {mutationSuccess && (
          <div className="rounded-md border border-emerald-600/30 bg-emerald-600/5 p-3 text-sm text-emerald-700 dark:text-emerald-400">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>
                {mutationSuccess}
                {washToReceipt && " Le client a réglé la totalité : remettez-lui son reçu."}
              </span>
              {washToReceipt && (
                <WashReceiptButton washId={washToReceipt.id} label="Remettre le reçu au client" />
              )}
            </div>
          </div>
        )}

        {showForm && (
          <section className="elev-1 rounded-lg border bg-card p-4 md:p-6">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Nouveau lavage</h2>
                <p className="text-sm text-muted-foreground">
                  Les prix du catalogue seront copiés sur le lavage à l’enregistrement.
                </p>
              </div>
              <Button variant="ghost" onClick={closeForm}>Fermer</Button>
            </div>

            <form onSubmit={submitWash} className="space-y-6">
              <div className="grid gap-4 md:grid-cols-3">
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Client <span className="font-normal text-muted-foreground">(facultatif)</span>
                  <Input
                    value={customerName}
                    onChange={(event) => {
                      setCustomerName(event.target.value)
                      markFormChanged()
                    }}
                    placeholder="Ex. Mme Konan"
                    maxLength={80}
                    autoComplete="off"
                    className="h-10"
                  />
                  <span className="text-xs font-normal text-muted-foreground">
                    Un simple nom pour appeler la voiture. Ni téléphone, ni fiche.
                  </span>
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Catégorie du véhicule
                  <select
                    className="h-10 rounded-md border border-input bg-background px-3"
                    value={vehicleCategoryId}
                    onChange={(event) => {
                      chooseVehicleCategory(event.target.value)
                      markFormChanged()
                    }}
                    disabled={categoriesLoading || activeCategories.length === 0}
                    required
                  >
                    <option value="">Sélectionner une catégorie</option>
                    {/* Regroupées par famille : sur 60 catégories, une liste
                        plate se parcourt mal, et le caissier cherche un
                        gabarit (« SUV », « camion ») avant un modèle. */}
                    {categoryGroups.map((group) => (
                      <optgroup key={group.code ?? "autres"} label={group.label}>
                        {group.categories.map((category) => (
                          <option key={category.id} value={category.id}>{category.name}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {/* Sans catégorie, le sélecteur reste vide et le bouton
                      d'enregistrement ne s'active jamais : on dit où en créer
                      plutôt que de laisser un champ mort. */}
                  {!categoriesLoading && activeCategories.length === 0 && (
                    <span className="text-xs font-normal text-destructive">
                      Aucune catégorie de véhicule.{" "}
                      <Link to="/vehicle-categories" className="underline underline-offset-4">
                        Créez-en une
                      </Link>{" "}
                      pour enregistrer un lavage.
                    </span>
                  )}
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                  Plaque <span className="font-normal text-muted-foreground">(facultatif)</span>
                  <Input
                    value={plate}
                    onChange={(event) => {
                      setPlate(event.target.value)
                      markFormChanged()
                    }}
                    placeholder="Ex. 1234 AB 01"
                    maxLength={32}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-10 uppercase"
                  />
                  {vehicleHistory && vehicleHistory.visits > 0 ? (
                    <span className="text-xs font-normal text-muted-foreground">
                      Déjà venu <strong>{vehicleHistory.visits} fois</strong>
                      {vehicleHistory.last_visit_at
                        ? `, la dernière le ${new Date(vehicleHistory.last_visit_at).toLocaleDateString("fr-CI")}`
                        : ""}
                      .
                    </span>
                  ) : (
                    <span className="text-xs font-normal text-muted-foreground">
                      Sert à retrouver l’historique du véhicule. Aucun nom, aucun téléphone.
                    </span>
                  )}
                </label>
                <div className="flex flex-col gap-1.5 text-sm font-medium">
                  Station sélectionnée
                  <div className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-muted-foreground">
                    {allSites.find((site) => site.id === siteId)?.name ?? "Aucune station"}
                  </div>
                </div>
              </div>

              <fieldset className="space-y-3">
                <legend className="mb-2 text-sm font-semibold">Prestations</legend>
                {servicesLoading ? (
                  <div className="grid gap-3 sm:grid-cols-2" role="status" aria-busy="true" aria-label="Chargement du catalogue">
                    {[0, 1, 2, 3].map((item) => (
                      <div
                        key={item}
                        className="row-in flex items-center gap-3 rounded-md border p-3"
                        style={{ "--row": item } as React.CSSProperties}
                      >
                        <Skeleton className="size-4 rounded" />
                        <div className="flex-1 space-y-2">
                          <Skeleton className="h-4 w-32" />
                          <Skeleton className="h-3 w-20" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : activeServices.length === 0 ? (
                  <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                    Aucune prestation active. Configurez le catalogue avant d’enregistrer un lavage.
                  </p>
                ) : eligibleServices.length === 0 ? (
                  <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                    Aucune prestation n’est autorisée pour cette catégorie de véhicule. Ouvrez
                    Prestations pour cocher les catégories autorisées et leurs tarifs.
                  </p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {eligibleServices.map((service) => {
                      const quantity = quantities[service.id] ?? 0
                      return (
                        <div
                          key={service.id}
                          className={`flex items-center gap-3 rounded-md border p-3 transition-all duration-150 ${
                            quantity > 0 ? "border-primary/50 bg-primary/5" : "hover:border-primary/30 hover:bg-muted/40"
                          }`}
                        >
                          <input
                            id={`service-${service.id}`}
                            type="checkbox"
                            checked={quantity > 0}
                            onChange={(event) => toggleService(service.id, event.target.checked)}
                            className="size-4 accent-primary"
                          />
                          <label htmlFor={`service-${service.id}`} className="min-w-0 flex-1 cursor-pointer">
                            <span className="block truncate font-medium">{service.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {selectedVehicle
                                ? `${formatXof(configuredPriceFor(service, selectedVehicle.id) ?? 0)} / unité`
                                : "Tarif selon la catégorie de véhicule"}
                            </span>
                          </label>
                          {quantity > 0 && (
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              Qté
                              <Input
                                type="number"
                                min={1}
                                max={100}
                                step={1}
                                className="h-8 w-16"
                                aria-label={`Quantité de ${service.name}`}
                                value={quantity}
                                onChange={(event) => changeQuantity(service.id, event.target.value)}
                              />
                            </label>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </fieldset>

              <fieldset className="space-y-3">
                <legend className="mb-2 text-sm font-semibold">
                  Qui lave ce véhicule&nbsp;?{" "}
                  <span className="font-normal text-muted-foreground">
                    (obligatoire &mdash; plusieurs possibles, la part se partage)
                  </span>
                </legend>
                {workersLoading ? (
                  <div className="flex flex-wrap gap-2" role="status" aria-busy="true" aria-label="Chargement des employés">
                    {[0, 1, 2].map((item) => (
                      <Skeleton
                        key={item}
                        className="row-in h-9 w-32 rounded-md"
                        style={{ "--row": item } as React.CSSProperties}
                      />
                    ))}
                  </div>
                ) : activeWorkers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Aucun employé actif pour le moment. Ajoutez-le dans{" "}
                    <Link to="/team" className="font-medium underline underline-offset-4">
                      Équipe
                    </Link>{" "}
                    pour pouvoir enregistrer un lavage.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {activeWorkers.map((worker) => {
                      const checked = selectedWorkerIds.includes(worker.id)
                      return (
                        <label key={worker.id} className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => toggleWorker(worker.id, event.target.checked)}
                            className="size-4 accent-primary"
                          />
                          {worker.first_name} {worker.last_name}
                        </label>
                      )
                    })}
                  </div>
                )}
                {selectedWorkerIds.length > 0 && (
                  <div className="mt-3 flex items-center gap-2">
                    <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      Responsable principal
                    </label>
                    <select
                      className="h-9 rounded-md border border-input bg-background px-3 text-sm flex-1"
                      value={principalWorkerId ?? ""}
                      onChange={(event) => setPrincipal(event.target.value || null)}
                    >
                      <option value="">Aucun — responsabilité partagée</option>
                      {activeWorkers
                        .filter((worker) => selectedWorkerIds.includes(worker.id))
                        .map((worker) => (
                          <option key={worker.id} value={worker.id}>
                            {worker.first_name} {worker.last_name}
                          </option>
                        ))}
                    </select>
                  </div>
                )}
              </fieldset>

              <div className="rounded-lg border bg-muted/20 p-4">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">Total des prestations</span>
                  <span className="text-xl font-bold">{formatXof(totalCents)}</span>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5 text-sm font-medium">
                    Moyen de paiement
                    <select
                      className="h-10 rounded-md border border-input bg-background px-3"
                      value={paymentMethod}
                      onChange={(event) => {
                        setPaymentMethod(event.target.value)
                        markFormChanged()
                      }}
                    >
                      {paymentMethods.map((method) => (
                        <option key={method.value} value={method.value}>{method.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm font-medium">
                    Montant reçu / enregistré (XOF)
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        min={0}
                        step="any"
                        value={amountReceived}
                        onChange={(event) => {
                          setAmountReceived(event.target.value)
                          markFormChanged()
                        }}
                        aria-invalid={!amountIsValid}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setAmountReceived((totalCents / 100).toString())
                          markFormChanged()
                        }}
                      >
                        Total
                      </Button>
                    </div>
                  </label>
                </div>
                <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                  {amountReceivedCents != null && amountReceivedCents > 0 && amountReceivedCents < totalCents && (
                    <p>Reste à payer : {formatXof(totalCents - amountReceivedCents)}.</p>
                  )}
                  {amountReceivedCents != null && amountReceivedCents > 0 && paymentMethod !== "cash" && (
                    <p>Ce paiement sera enregistré en attente de vérification.</p>
                  )}
                  {cashNeedsSession && !cashSessionLoading && !cashSession && (
                    <p className="text-destructive">
                      Aucune session de caisse ouverte pour cette station. <Link to="/cash-drawer" className="underline">Ouvrir la caisse</Link> ou saisir zéro pour enregistrer le lavage sans paiement.
                    </p>
                  )}
                  {amountReceivedCents != null && amountReceivedCents > totalCents && (
                    <p className="text-destructive">Le paiement ne peut pas dépasser le total du lavage.</p>
                  )}
                  {!amountIsValid && amountReceivedCents == null && (
                    <p className="text-destructive">Saisissez un montant valide.</p>
                  )}
                </div>
              </div>

              {mutationError && (
                <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  {mutationError}
                </div>
              )}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="outline" onClick={closeForm}>Annuler</Button>
                <SubmitButton
                  type="submit"
                  pending={saving}
                  success={saveSuccess}
                  successLabel="Lavage enregistré"
                  idleIcon={<Check className="size-4" />}
                  disabled={submitBlockedReason !== null}
                  title={submitBlockedReason ?? undefined}
                >
                  Enregistrer le lavage
                </SubmitButton>
              </div>
              <BlockedReason reason={submitBlockedReason} className="sm:justify-end sm:text-right" />
            </form>
          </section>
        )}

        <ActiveWashTasks
          washes={tachesActives}
          canAdvance={advanceStatus.allowed}
          busyWashIds={advancingWashIds}
          onStart={(washId) => void startTask(washId)}
          onFinish={(washId) => void finishTask(washId)}
          onAutoFinish={(washId) => void moveToOvertime(washId)}
        />

        <section className="overflow-hidden rounded-lg border bg-card">
          <div className="border-b p-4">
            <h2 className="text-lg font-semibold">Historique des lavages</h2>
            <p className="text-sm text-muted-foreground">
              Les 200 opérations les plus récentes de l’organisation. La recherche,
              le tri et les colonnes affichées sont conservés d’une visite à l’autre.
            </p>
          </div>

          {washesLoading && (
            <div className="p-4">
              <TableSkeleton rows={6} cols={6} label="Chargement de l’historique des lavages" />
            </div>
          )}

          {advanceError && (
            <div
              role="alert"
              className="mx-4 mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {advanceError} Le statut du lavage n’a pas changé. Réessayez ; si le
              problème persiste, ouvrez la fiche du lavage.
            </div>
          )}

          {!washesLoading && (
            <ResponsiveTable>
              <TableToolbar
                search={dataTable.search}
                onSearchChange={dataTable.setSearch}
                searchLabel="Rechercher un lavage par référence, plaque, client ou station"
                placeholder="Référence, plaque, client…"
                total={dataTable.total}
                filtered={dataTable.filtered.length}
                columns={tableColumns}
                hiddenColumns={dataTable.hiddenColumns}
                onToggleColumn={dataTable.toggleColumn}
                onReset={dataTable.reset}
                activeFilterCount={dataTable.activeFilterCount + dataTable.hiddenColumns.length}
              >
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="sr-only">Filtrer par statut de lavage</span>
                  <select
                    value={dataTable.filters.status ?? ""}
                    onChange={(event) => dataTable.setFilter("status", event.target.value)}
                    className="h-9 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
                  >
                    <option value="">Tous les statuts</option>
                    <option value="pending">En attente</option>
                    <option value="in_progress">En cours</option>
                    <option value="overtime">En retard</option>
                    <option value="done">Terminé</option>
                    <option value="cancelled">Annulé</option>
                  </select>
                </label>
                {activeSites.length > 1 && (
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="sr-only">Filtrer par station</span>
                    <select
                      value={dataTable.filters.site ?? ""}
                      onChange={(event) => dataTable.setFilter("site", event.target.value)}
                      className="h-9 max-w-44 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
                    >
                      <option value="">Toutes les stations</option>
                      {activeSites.map((site) => (
                        <option key={site.id} value={site.id}>
                          {site.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </TableToolbar>

              <Table>
                <TableHeader>
                  <TableRow>
                    {!dataTable.isColumnHidden("reference") && (
                      <SortableHead
                        label="Référence"
                        column="reference"
                        sort={dataTable.sort}
                        onSort={dataTable.toggleSort}
                      />
                    )}
                    {!dataTable.isColumnHidden("plate") && (
                      <SortableHead
                        label="Plaque"
                        column="plate"
                        sort={dataTable.sort}
                        onSort={dataTable.toggleSort}
                      />
                    )}
                    {!dataTable.isColumnHidden("site") && (
                      <SortableHead
                        label="Station"
                        column="site"
                        sort={dataTable.sort}
                        onSort={dataTable.toggleSort}
                      />
                    )}
                    {!dataTable.isColumnHidden("category") && (
                      <SortableHead
                        label="Catégorie"
                        column="category"
                        sort={dataTable.sort}
                        onSort={dataTable.toggleSort}
                      />
                    )}
                    {!dataTable.isColumnHidden("total") && (
                      <SortableHead
                        label="Total"
                        column="total"
                        sort={dataTable.sort}
                        onSort={dataTable.toggleSort}
                        align="right"
                      />
                    )}
                    {!dataTable.isColumnHidden("status") && (
                      <TableHead>Statut</TableHead>
                    )}
                    {!dataTable.isColumnHidden("payment") && (
                      <SortableHead
                        label="Paiement"
                        column="payment"
                        sort={dataTable.sort}
                        onSort={dataTable.toggleSort}
                      />
                    )}
                    {!dataTable.isColumnHidden("date") && (
                      <SortableHead
                        label="Date"
                        column="date"
                        sort={dataTable.sort}
                        onSort={dataTable.toggleSort}
                      />
                    )}
                    <TableHead>
                      <span className="sr-only">Détail</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {washesError && (
                    <TableErrorRow
                      colSpan={9}
                      message={washesError}
                      onRetry={() => setRefreshKey((key) => key + 1)}
                    />
                  )}

                  {!washesError && washes.length === 0 && (
                    <TableEmptyRow
                      colSpan={9}
                      icon={Droplets}
                      title="Aucun lavage enregistré"
                      description="Enregistrez votre premier lavage : il apparaîtra ici avec sa référence, son montant et son statut de paiement."
                      action={
                        <Button size="sm" onClick={() => setFormOpen(true)}>
                          <Plus className="size-4" aria-hidden="true" />
                          Enregistrer un lavage
                        </Button>
                      }
                    />
                  )}

                  {!washesError && washes.length > 0 && dataTable.filtered.length === 0 && (
                    <TableEmptyRow
                      colSpan={9}
                      icon={Droplets}
                      title="Aucun lavage ne correspond à ces filtres"
                      description="Aucune opération ne correspond à la recherche ou aux filtres actifs. Vos données n’ont pas été modifiées."
                      action={
                        <Button variant="outline" size="sm" onClick={dataTable.reset}>
                          Réinitialiser les filtres
                        </Button>
                      }
                    />
                  )}

                  {dataTable.pageRows.map((wash, index) => {
                    return (
                      <TableRow
                        key={wash.id}
                        className={`row-in transition-colors hover:bg-muted/40 ${
                          wash.id === highlightedWashId ? "row-flash" : ""
                        }`}
                        style={{ "--row": Math.min(index, 10) } as React.CSSProperties}
                      >
                        {!dataTable.isColumnHidden("reference") && (
                          <TableCell data-label="Référence" className="font-medium">
                            <WashReference washId={wash.id} reference={wash.reference} />
                          </TableCell>
                        )}
                        {!dataTable.isColumnHidden("plate") && (
                          <TableCell
                            data-label="Plaque"
                            className="font-mono text-xs uppercase tabular-nums"
                          >
                            {wash.plate ?? "—"}
                          </TableCell>
                        )}
                        {!dataTable.isColumnHidden("site") && (
                          <TableCell data-label="Station">{siteName(wash.site_id)}</TableCell>
                        )}
                        {!dataTable.isColumnHidden("category") && (
                          <TableCell data-label="Catégorie">
                            {categoryName(wash.vehicle_category_id)}
                          </TableCell>
                        )}
                        {!dataTable.isColumnHidden("total") && (
                          <TableCell data-label="Total" className="text-right font-medium tabular-nums">
                            {formatXof(wash.total_cents)}
                          </TableCell>
                        )}
                        {!dataTable.isColumnHidden("status") && (
                          <TableCell data-label="Statut">
                            <OperationStatusBadge
                              status={currentOperationStatus(wash.id)}
                              cancelled={wash.status === "cancelled"}
                              canAdvance={advanceStatus.allowed}
                              busy={advancingWashIds.includes(wash.id)}
                              onAdvance={(next) => void advanceWashStatus(wash.id, next)}
                            />
                          </TableCell>
                        )}
                        {!dataTable.isColumnHidden("payment") && (
                          <TableCell data-label="Paiement">
                            {paymentStatusLabel(wash.payment_status)}
                          </TableCell>
                        )}
                        {!dataTable.isColumnHidden("date") && (
                          <TableCell data-label="Date" className="text-muted-foreground">
                            <time dateTime={wash.created_at}>
                              {formatDateTime(wash.created_at)}
                            </time>
                          </TableCell>
                        )}
                        <TableCell data-label="">
                          <Button
                            render={<Link to={`/washes/${wash.id}`} viewTransition />}
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Voir le détail du lavage ${wash.reference}`}
                          >
                            <ArrowRight
                              className="size-4 transition-transform group-hover/button:translate-x-0.5"
                              aria-hidden="true"
                            />
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>

              {dataTable.filtered.length > 0 && (
                <TablePagination
                  page={dataTable.page}
                  pageCount={dataTable.pageCount}
                  pageSize={dataTable.pageSize}
                  pageSizeOptions={dataTable.pageSizeOptions}
                  total={dataTable.total}
                  filtered={dataTable.filtered.length}
                  onPage={dataTable.setPage}
                  onPageSize={dataTable.setPageSize}
                />
              )}
            </ResponsiveTable>
          )}
        </section>
      </div>
    </BaseLayout>
  )
}
