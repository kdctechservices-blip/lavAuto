"use client"

import * as React from "react"
import { Link } from "react-router-dom"
import { ArrowRight, BadgeCheck, Clock, Loader2, Wallet } from "lucide-react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty-state"
import { TableSkeleton, CardsSkeleton } from "@/components/ui/table-skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useApi } from "@/lib/api"
import { useMutation } from "@/lib/use-mutation"
import { useAccess } from "@/lib/permissions"
import { actionGate } from "@/lib/action-blocking"
import { BlockedReason } from "@/components/access/blocked-reason"
import {
  PAYMENT_METHODS,
  PAYMENT_STATUS_LABELS,
  paymentMethodLabel,
  type PaymentRow,
  type PaymentsResponse,
} from "@/lib/payments-api"
import {
  ResponsiveTable,
  SortableHead,
  TableEmptyRow,
  TablePagination,
  TableToolbar,
  useDataTable,
  type ColumnDefinition,
} from "@/components/ui/data-table"
import { formatDateTime, formatXof } from "@/lib/format"

const STATUS_FILTERS = [
  { value: "all", label: "Tous" },
  { value: "pending", label: "À confirmer" },
  { value: "verified", label: "Confirmés" },
] as const

export default function PaymentsPage() {
  const managePayments = useAccess("payment:verify", "payments.manage")
  // Le remboursement est réservé au propriétaire : il touche la caisse et la
  // comptabilité, et ne peut pas être délégué.
  const refundPayments = useAccess("payment:cancel", "payments.manage")
  // Confirmer écrit immédiatement : on attend de connaître les droits plutôt
  // que de laisser partir une requête vouée au refus.
  const confirmGate = actionGate({
    loading: managePayments.loading,
    allowed: managePayments.allowed,
    reason: managePayments.reason,
    writesImmediately: true,
  })
  // Les filtres survivent au rechargement : un caissier qui ne travaille que
  // sur un canal (Wave, par exemple) n'a pas à le choisir à chaque visite.
  // Seules les valeurs réellement proposées sont restaurées.
  const FILTERS_KEY = "washpilot:payments-filters"
  const savedFilters = React.useMemo(() => {
    try {
      const raw = window.localStorage.getItem(FILTERS_KEY)
      return raw ? (JSON.parse(raw) as { status?: string; method?: string }) : {}
    } catch {
      return {}
    }
  }, [])
  const [status, setStatus] = React.useState<(typeof STATUS_FILTERS)[number]["value"]>(
    STATUS_FILTERS.some((filter) => filter.value === savedFilters.status)
      ? (savedFilters.status as (typeof STATUS_FILTERS)[number]["value"])
      : "all",
  )
  const [method, setMethod] = React.useState<string>(
    savedFilters.method && savedFilters.method !== "all"
      ? savedFilters.method
      : "all",
  )

  React.useEffect(() => {
    try {
      window.localStorage.setItem(FILTERS_KEY, JSON.stringify({ status, method }))
    } catch {
      // Sans stockage, les filtres valent pour la session.
    }
  }, [status, method])
  const [refreshKey, setRefreshKey] = React.useState(0)
  // Une seule écriture à la fois sur cette page : le contrôleur porte la
  // ligne occupée et le message d'échec.
  const mutation = useMutation()
  const busyId = mutation.busyKey
  const error = mutation.error
  const [confirmedId, setConfirmedId] = React.useState<string | null>(null)

  const { data, loading, error: loadError } = useApi<PaymentsResponse>(
    `/api/v1/payments?status=${status}&method=${method}&refresh=${refreshKey}`,
  )

  /** Remboursement tracé : l'encaissement est conservé, jamais supprimé. */
  async function refundPayment(paymentId: string) {
    const reason = window.prompt(
      "Motif du remboursement (conservé dans le journal d’audit) :",
    )
    if (!reason || reason.trim().length < 3) return
    const outcome = await mutation.run({
      url: `/api/v1/payments/${paymentId}/refund`,
      method: "POST",
      body: { reason: reason.trim() },
      failure: "Remboursement impossible : serveur injoignable.",
      busyKey: paymentId,
    })
    if (outcome.ok) setRefreshKey((key) => key + 1)
  }

  const totals = data?.totals_by_method ?? []

  const tableColumns: ColumnDefinition[] = [
    { id: "wash", label: "Lavage", required: true },
    { id: "method", label: "Canal" },
    { id: "amount", label: "Montant" },
    { id: "status", label: "Statut" },
    { id: "date", label: "Date" },
    { id: "action", label: "Action" },
  ]

  const table = useDataTable<PaymentRow>({
    storageKey: "washpilot:table:encaissements",
    rows: data?.payments ?? [],
    columns: tableColumns,
    initialSort: { column: "date", direction: "desc" },
    searchText: (payment) =>
      [
        payment.wash_reference,
        paymentMethodLabel(payment.method),
        PAYMENT_STATUS_LABELS[payment.status] ?? payment.status,
        payment.reference ?? "",
      ].join(" "),
    sorters: {
      wash: (a, b) => a.wash_reference.localeCompare(b.wash_reference),
      method: (a, b) => paymentMethodLabel(a.method).localeCompare(paymentMethodLabel(b.method)),
      amount: (a, b) => a.amount_cents - b.amount_cents,
      date: (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      status: (a, b) =>
        (PAYMENT_STATUS_LABELS[a.status] ?? a.status).localeCompare(
          PAYMENT_STATUS_LABELS[b.status] ?? b.status,
        ),
    },
  })

  // Le toast est émis par `useMutation` : une seule source de feedback, donc
  // pas de doublon quand une page affiche aussi le message en ligne.
  const pendingTotal = totals.reduce((sum, row) => sum + row.pending_cents, 0)
  const verifiedTotal = totals.reduce((sum, row) => sum + row.verified_cents, 0)

  async function confirmPayment(id: string) {
    const outcome = await mutation.run({
      url: `/api/v1/payments/${id}/verify`,
      method: "POST",
      body: {},
      failure: "Confirmation impossible : serveur injoignable.",
      busyKey: id,
    })
    if (!outcome.ok) return
    setConfirmedId(id)
    setRefreshKey((key) => key + 1)
  }

  return (
    <BaseLayout
      title="Encaissements"
      description="Espèces, Orange Money, MTN MoMo, Moov Money et Wave — suivis séparément, avec confirmation des paiements mobile money."
    >
      <div className="space-y-6 p-4">
        {/* Totaux par canal ------------------------------------------------ */}
        {loading && !data ? (
          <CardsSkeleton count={4} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Card className="row-in" style={{ "--row": 0 } as React.CSSProperties}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardDescription>Encaissements confirmés</CardDescription>
                <BadgeCheck className="size-4 text-muted-foreground" aria-hidden="true" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatXof(verifiedTotal)}</p>
              </CardContent>
            </Card>
            <Card
              className={`row-in ${pendingTotal > 0 ? "border-amber-500/50" : ""}`}
              style={{ "--row": 1 } as React.CSSProperties}
            >
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardDescription>À confirmer</CardDescription>
                <Clock className="size-4 text-muted-foreground" aria-hidden="true" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatXof(pendingTotal)}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Paiements mobile money en attente de vérification
                </p>
              </CardContent>
            </Card>
            {totals.slice(0, 2).map((row, index) => (
              <Card
                key={row.method}
                className="row-in"
                style={{ "--row": index + 2 } as React.CSSProperties}
              >
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardDescription>{paymentMethodLabel(row.method)}</CardDescription>
                  <Wallet className="size-4 text-muted-foreground" aria-hidden="true" />
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">{formatXof(row.amount_cents)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.payment_count} encaissement{row.payment_count === 1 ? "" : "s"}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Répartition complète -------------------------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="size-4" aria-hidden="true" /> Répartition par moyen de paiement
            </CardTitle>
            <CardDescription>Tous les encaissements non remboursés de la station.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loading && !data ? (
              <TableSkeleton rows={4} cols={4} label="Chargement de la répartition" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Moyen de paiement</TableHead>
                    <TableHead className="text-right">Encaissements</TableHead>
                    <TableHead className="text-right">Confirmé</TableHead>
                    <TableHead className="text-right">À confirmer</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {totals.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="p-0">
                        <EmptyState
                          icon={Wallet}
                          title="Aucun encaissement"
                          description="Les paiements enregistrés sur les lavages apparaîtront ici, canal par canal."
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    totals.map((row, index) => (
                      <TableRow
                        key={row.method}
                        className="row-in"
                        style={{ "--row": Math.min(index, 10) } as React.CSSProperties}
                      >
                        <TableCell className="font-medium">{paymentMethodLabel(row.method)}</TableCell>
                        <TableCell className="text-right">{formatXof(row.amount_cents)}</TableCell>
                        <TableCell className="text-right">{formatXof(row.verified_cents)}</TableCell>
                        <TableCell className="text-right">
                          {row.pending_cents > 0 ? (
                            <span className="font-medium text-amber-600 dark:text-amber-400">
                              {formatXof(row.pending_cents)}
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Journal des encaissements ---------------------------------------- */}
        <Card>
          <CardHeader className="gap-3">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <CardTitle>Journal des encaissements</CardTitle>
                <CardDescription>200 derniers encaissements enregistrés.</CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                <div className="flex overflow-hidden rounded-md border" role="group" aria-label="Filtrer par statut">
                  {STATUS_FILTERS.map((filter) => (
                    <button
                      key={filter.value}
                      type="button"
                      aria-pressed={status === filter.value}
                      onClick={() => setStatus(filter.value)}
                      className={`h-9 px-3 text-sm transition-colors duration-150 ${
                        status === filter.value
                          ? "bg-primary text-primary-foreground"
                          : "bg-background hover:bg-accent"
                      }`}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
                <select
                  aria-label="Filtrer par moyen de paiement"
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  value={method}
                  onChange={(event) => setMethod(event.target.value)}
                >
                  <option value="all">Tous les canaux</option>
                  {PAYMENT_METHODS.map((value) => (
                    <option key={value} value={value}>
                      {paymentMethodLabel(value)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {(error || loadError) && (
              <p role="alert" className="text-sm text-destructive">
                {error ?? loadError}
              </p>
            )}
          </CardHeader>
          <CardContent className="p-0">
            <BlockedReason reason={confirmGate.reason} className="px-6 pb-3" />
            {loading && !data ? (
              <TableSkeleton rows={6} cols={6} label="Chargement des encaissements" />
            ) : (
              <ResponsiveTable>
                <TableToolbar
                  search={table.search}
                  onSearchChange={table.setSearch}
                  searchLabel="Rechercher un encaissement par lavage, canal ou référence"
                  placeholder="Référence de lavage, canal…"
                  total={table.total}
                  filtered={table.filtered.length}
                  columns={tableColumns}
                  hiddenColumns={table.hiddenColumns}
                  onToggleColumn={table.toggleColumn}
                  onReset={table.reset}
                  activeFilterCount={table.activeFilterCount + table.hiddenColumns.length}
                />
                <Table>
                  <TableHeader>
                    <TableRow>
                      {!table.isColumnHidden("wash") && (
                        <SortableHead
                          label="Lavage"
                          column="wash"
                          sort={table.sort}
                          onSort={table.toggleSort}
                        />
                      )}
                      {!table.isColumnHidden("method") && (
                        <SortableHead
                          label="Canal"
                          column="method"
                          sort={table.sort}
                          onSort={table.toggleSort}
                        />
                      )}
                      {!table.isColumnHidden("amount") && (
                        <SortableHead
                          label="Montant"
                          column="amount"
                          sort={table.sort}
                          onSort={table.toggleSort}
                          align="right"
                        />
                      )}
                      {!table.isColumnHidden("status") && (
                        <SortableHead
                          label="Statut"
                          column="status"
                          sort={table.sort}
                          onSort={table.toggleSort}
                        />
                      )}
                      {!table.isColumnHidden("date") && (
                        <SortableHead
                          label="Date"
                          column="date"
                          sort={table.sort}
                          onSort={table.toggleSort}
                        />
                      )}
                      {!table.isColumnHidden("action") && (
                        <TableHead className="text-right">Action</TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {table.filtered.length === 0 ? (
                      <TableEmptyRow
                        colSpan={6}
                        icon={Wallet}
                        title={
                          (data?.payments ?? []).length === 0
                            ? "Aucun encaissement sur ce filtre"
                            : "Aucun encaissement ne correspond à cette recherche"
                        }
                        description={
                          (data?.payments ?? []).length === 0
                            ? "Changez de statut ou de canal : les encaissements apparaissent dès qu’un lavage est réglé."
                            : "Vos données sont intactes. Réinitialisez la recherche pour retrouver tous les encaissements de ce filtre."
                        }
                        action={
                          (data?.payments ?? []).length === 0 ? (
                            <Button variant="outline" size="sm" render={<Link to="/washes" viewTransition />}>
                              Voir les lavages
                            </Button>
                          ) : (
                            <Button variant="outline" size="sm" onClick={table.reset}>
                              Réinitialiser la recherche
                            </Button>
                          )
                        }
                      />
                    ) : (
                      table.pageRows.map((payment, index) => (
                        <TableRow
                          key={payment.id}
                          className={`row-in transition-colors ${confirmedId === payment.id ? "row-flash" : ""}`}
                          style={{ "--row": Math.min(index, 10) } as React.CSSProperties}
                        >
                          {!table.isColumnHidden("wash") && (
                            <TableCell data-label="Lavage" className="font-medium">
                              <Link
                                to={`/washes/${payment.wash_id}`}
                                viewTransition
                                className="inline-flex items-center gap-1 hover:underline"
                              >
                                {payment.wash_reference}
                                <ArrowRight className="size-3.5 opacity-60" aria-hidden="true" />
                              </Link>
                            </TableCell>
                          )}
                          {!table.isColumnHidden("method") && (
                            <TableCell data-label="Canal">
                              {paymentMethodLabel(payment.method)}
                            </TableCell>
                          )}
                          {!table.isColumnHidden("amount") && (
                            <TableCell data-label="Montant" className="text-right font-medium tabular-nums">
                              {formatXof(payment.amount_cents)}
                            </TableCell>
                          )}
                          {!table.isColumnHidden("status") && (
                            <TableCell data-label="Statut">
                              <Badge
                                variant={payment.status === "verified" ? "secondary" : "outline"}
                                className={
                                  payment.status === "pending"
                                    ? "border-amber-500/60 text-amber-700 dark:text-amber-300"
                                    : ""
                                }
                              >
                                {PAYMENT_STATUS_LABELS[payment.status] ?? payment.status}
                              </Badge>
                            </TableCell>
                          )}
                          {!table.isColumnHidden("date") && (
                            <TableCell data-label="Date" className="text-muted-foreground">
                              <time dateTime={payment.created_at}>
                                {formatDateTime(payment.created_at)}
                              </time>
                            </TableCell>
                          )}
                          {!table.isColumnHidden("action") && (
                            <TableCell data-label="Action" className="text-right">
                              {payment.status === "pending" ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busyId === payment.id || confirmGate.disabled}
                                  aria-busy={busyId === payment.id}
                                  title={confirmGate.reason ?? undefined}
                                  onClick={() => void confirmPayment(payment.id)}
                                >
                                  {busyId === payment.id ? (
                                    <>
                                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                                      Confirmation…
                                    </>
                                  ) : (
                                    "Confirmer"
                                  )}
                                </Button>
                              ) : payment.status === "verified" && refundPayments.allowed ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="text-destructive hover:text-destructive"
                                  disabled={busyId === payment.id}
                                  aria-busy={busyId === payment.id}
                                  onClick={() => void refundPayment(payment.id)}
                                >
                                  {busyId === payment.id ? "…" : "Rembourser"}
                                </Button>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          )}
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
                {table.filtered.length > 0 && (
                  <TablePagination
                    page={table.page}
                    pageCount={table.pageCount}
                    pageSize={table.pageSize}
                    pageSizeOptions={table.pageSizeOptions}
                    total={table.total}
                    filtered={table.filtered.length}
                    onPage={table.setPage}
                    onPageSize={table.setPageSize}
                  />
                )}
              </ResponsiveTable>
            )}
          </CardContent>
        </Card>
      </div>
    </BaseLayout>
  )
}
