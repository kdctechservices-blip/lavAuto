"use client"

import { useState } from "react"
import { Link } from "react-router-dom"
import { BaseLayout } from "@/components/layouts/base-layout"
import { useAccess } from "@/lib/permissions"
import { actionGate } from "@/lib/action-blocking"
import { BlockedReason } from "@/components/access/blocked-reason"
import { useApi } from "@/lib/api"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { TableSkeleton } from "@/components/ui/table-skeleton"
import {
  ResponsiveTable,
  SortableHead,
  TableEmptyRow,
  TablePagination,
  TableToolbar,
  useDataTable,
  type ColumnDefinition,
} from "@/components/ui/data-table"
import { CreateExpenseModal } from "@/components/modals"
import {
  EXPENSE_CATEGORIES,
  EXPENSE_PAYMENT_METHODS,
  type ExpenseRecord,
} from "@/lib/expenses"
import { formatDate, formatXof } from "@/lib/format"
import { Lock, Plus, Receipt } from "lucide-react"

function expenseStatusLabel(status: string): string {
  if (status === "recorded") return "Enregistrée"
  if (status === "cancelled") return "Annulée"
  return status
}

export default function ExpensesPage() {
  const manageExpenses = useAccess("expense:create", "expenses.manage")
  // Le formulaire s'ouvre dans une boîte de dialogue : rien n'est écrit tant
  // qu'on n'a pas validé, donc l'attente des droits ne grise pas le bouton.
  const expenseForm = actionGate({
    loading: manageExpenses.loading,
    allowed: manageExpenses.allowed,
    reason: manageExpenses.reason,
  })
  const [refreshKey, setRefreshKey] = useState(0)
  const { data, loading, error } = useApi<ExpenseRecord[]>(`/api/v1/expenses?refresh=${refreshKey}`)
  const expenses = data ?? []

  const columns: ColumnDefinition[] = [
    { id: "date", label: "Date", required: true },
    { id: "category", label: "Catégorie" },
    { id: "beneficiary", label: "Bénéficiaire" },
    { id: "amount", label: "Montant" },
    { id: "method", label: "Moyen de paiement" },
    { id: "status", label: "Statut" },
  ]

  const labelCategory = (value: string) =>
    EXPENSE_CATEGORIES.find((category) => category.value === value)?.label ?? value
  const labelMethod = (value: string) =>
    EXPENSE_PAYMENT_METHODS.find((method) => method.value === value)?.label ?? value

  const table = useDataTable<ExpenseRecord>({
    storageKey: "washpilot:table:depenses",
    rows: expenses,
    columns,
    initialSort: { column: "date", direction: "desc" },
    searchText: (expense) =>
      [
        expense.description ?? "",
        expense.beneficiary ?? "",
        labelCategory(expense.category),
        labelMethod(expense.payment_method),
        expenseStatusLabel(expense.status),
        formatDate(expense.expense_date, "numeric"),
      ].join(" "),
    sorters: {
      date: (a, b) => new Date(a.expense_date).getTime() - new Date(b.expense_date).getTime(),
      amount: (a, b) => a.amount_cents - b.amount_cents,
      category: (a, b) => labelCategory(a.category).localeCompare(labelCategory(b.category)),
      beneficiary: (a, b) => (a.beneficiary ?? "").localeCompare(b.beneficiary ?? ""),
      method: (a, b) => labelMethod(a.payment_method).localeCompare(labelMethod(b.payment_method)),
      status: (a, b) => expenseStatusLabel(a.status).localeCompare(expenseStatusLabel(b.status)),
    },
  })
  const [open, setOpen] = useState(false)
  // La dépense qui vient d'être créée est surlignée brièvement dans la liste,
  // au moment où le formulaire se referme et où la liste se rafraîchit.
  const [createdExpenseId, setCreatedExpenseId] = useState<string | null>(null)
  const [highlightedExpenseId, setHighlightedExpenseId] = useState<string | null>(null)

  function handleOpenChange(isOpen: boolean) {
    if (!isOpen && createdExpenseId) {
      setHighlightedExpenseId(createdExpenseId)
      setCreatedExpenseId(null)
      setRefreshKey((key) => key + 1)
    }
    setOpen(isOpen)
  }

  return (
    <BaseLayout title="Dépenses" description="Enregistrement et suivi des dépenses." hideHeading>
      <div className="p-4">
        <div className="flex md:flex-row flex-col md:items-center justify-between gap-4 mb-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-bold tracking-tight">Dépenses</h1>
            <p className="text-muted-foreground">
              Enregistrez et suivez les dépenses de votre station.
            </p>
          </div>
          <div className="flex flex-col items-start gap-1.5">
            <Button
              onClick={() => setOpen(true)}
              disabled={expenseForm.disabled}
              aria-busy={expenseForm.busy}
              title={expenseForm.reason ?? undefined}
            >
              {expenseForm.denied ? (
                <Lock className="mr-2 h-4 w-4" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}{" "}
              Nouvelle dépense
            </Button>
            <BlockedReason reason={expenseForm.reason} className="max-w-72" />
          </div>
          {/* Le formulaire possède le seul Dialog.Root : un second root contrôlé,
              sans popup, fermerait celui-ci à chaque clic dans ses champs. */}
          <CreateExpenseModal
            open={open}
            onOpenChange={handleOpenChange}
            onExpenseCreated={(expense) => setCreatedExpenseId(expense.id)}
          />
        </div>

        {loading && <TableSkeleton rows={6} cols={6} label="Chargement des dépenses" />}
        {error && <div className="text-destructive">{error}</div>}

        {!loading && !error && (
          <div className="overflow-hidden rounded-lg border bg-card">
            <TableToolbar
              search={table.search}
              onSearchChange={table.setSearch}
              searchLabel="Rechercher une dépense par catégorie, bénéficiaire ou description"
              placeholder="Catégorie, bénéficiaire, description…"
              total={table.total}
              filtered={table.filtered.length}
              columns={columns}
              hiddenColumns={table.hiddenColumns}
              onToggleColumn={table.toggleColumn}
              onReset={table.reset}
              activeFilterCount={table.activeFilterCount + table.hiddenColumns.length}
            />
            <ResponsiveTable>
              <Table>
                <TableHeader>
                  <TableRow>
                    {!table.isColumnHidden("date") && (
                      <SortableHead label="Date" column="date" sort={table.sort} onSort={table.toggleSort} />
                    )}
                    {!table.isColumnHidden("category") && (
                      <SortableHead label="Catégorie" column="category" sort={table.sort} onSort={table.toggleSort} />
                    )}
                    {!table.isColumnHidden("beneficiary") && (
                      <SortableHead label="Bénéficiaire" column="beneficiary" sort={table.sort} onSort={table.toggleSort} />
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
                    {!table.isColumnHidden("method") && (
                      <SortableHead label="Moyen de paiement" column="method" sort={table.sort} onSort={table.toggleSort} />
                    )}
                    {!table.isColumnHidden("status") && (
                      <TableHead>Statut</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {expenses.length === 0 && (
                    <TableEmptyRow
                      colSpan={6}
                      icon={Receipt}
                      title="Aucune dépense enregistrée"
                      description="Les sorties d’argent (carburant, produits, salaires…) apparaîtront ici dès la première saisie."
                      action={
                        <Button
                          size="sm"
                          onClick={() => setOpen(true)}
                          disabled={expenseForm.disabled}
                          title={expenseForm.reason ?? undefined}
                        >
                          <Plus className="size-4" aria-hidden="true" />
                          Enregistrer une dépense
                        </Button>
                      }
                    />
                  )}
                  {expenses.length > 0 && table.filtered.length === 0 && (
                    <TableEmptyRow
                      colSpan={6}
                      icon={Receipt}
                      title="Aucune dépense ne correspond à cette recherche"
                      description="Vos données n’ont pas été modifiées."
                      action={
                        <Button variant="outline" size="sm" onClick={table.reset}>
                          Réinitialiser la recherche
                        </Button>
                      }
                    />
                  )}
                  {table.pageRows.map((e, index) => (
                    <TableRow
                      key={e.id}
                      className={`row-in transition-colors ${e.id === highlightedExpenseId ? "row-flash" : ""}`}
                      style={{ "--row": Math.min(index, 10) } as React.CSSProperties}
                    >
                      {!table.isColumnHidden("date") && (
                        <TableCell data-label="Date" className="whitespace-nowrap">
                          <time dateTime={e.expense_date}>{formatDate(e.expense_date)}</time>
                        </TableCell>
                      )}
                      {!table.isColumnHidden("category") && (
                        <TableCell data-label="Catégorie">
                          {labelCategory(e.category)}
                          {/* Dire d'où vient la ligne est la moitié visible de la
                              garantie : sans cette mention, le gérant croirait
                              l'achat non enregistré et le ressaisirait ici. */}
                          {e.purchase_id && (
                            <Link
                              to="/achats"
                              className="mt-0.5 block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                            >
                              Issue d’un achat — déjà comptée
                            </Link>
                          )}
                          {e.utility_reading_id && (
                            <Link
                              to="/compteurs"
                              className="mt-0.5 block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                            >
                              Issue d’un relevé CIE/SODECI — déjà comptée
                            </Link>
                          )}
                        </TableCell>
                      )}
                      {!table.isColumnHidden("beneficiary") && (
                        <TableCell data-label="Bénéficiaire">{e.beneficiary || "—"}</TableCell>
                      )}
                      {!table.isColumnHidden("amount") && (
                        <TableCell data-label="Montant" className="text-right font-medium tabular-nums">
                          {formatXof(e.amount_cents)}
                        </TableCell>
                      )}
                      {!table.isColumnHidden("method") && (
                        <TableCell data-label="Moyen de paiement">
                          {labelMethod(e.payment_method)}
                        </TableCell>
                      )}
                      {!table.isColumnHidden("status") && (
                        <TableCell data-label="Statut">{expenseStatusLabel(e.status)}</TableCell>
                      )}
                    </TableRow>
                  ))}
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
          </div>
        )}
      </div>
    </BaseLayout>
  )
}