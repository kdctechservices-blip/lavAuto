"use client"

import * as React from "react"
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  RefreshCw,
  RotateCcw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EmptyState } from "@/components/ui/empty-state"
import { TableCell, TableHead, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

/**
 * Briques communes des tableaux : recherche instantanée, filtres persistants,
 * colonnes configurables, tri explicite, pagination lisible et états vides.
 *
 * Le choix de conception : rien n'est réinventé, tout est **partagé**. Sans
 * cela, chaque écran réimplémente sa pagination avec sa propre convention
 * (« Page 2 », « 2/7 », « suivant ») et le caissier doit réapprendre à lire un
 * tableau à chaque page.
 *
 * Les préférences survivent au rechargement — filtres, tri, colonnes, taille
 * de page — mais **pas la recherche** : revenir le lendemain sur une liste
 * filtrée par un texte oublié donnerait l'impression d'un écran vide.
 */

export type SortDirection = "asc" | "desc"
export interface SortState {
  column: string
  direction: SortDirection
}

export interface ColumnDefinition {
  id: string
  label: string
  /** Colonne indispensable : ne peut pas être masquée. */
  required?: boolean
}

export interface DataTableOptions<T> {
  /** Clé de persistance, stable : `washpilot:table:lavages`. */
  storageKey: string
  rows: T[]
  /** Texte indexé par la recherche instantanée. */
  searchText?: (row: T) => string
  sorters?: Record<string, (a: T, b: T) => number>
  initialSort?: SortState | null
  columns?: ColumnDefinition[]
  defaultPageSize?: number
  pageSizeOptions?: number[]
  filterPredicates?: Record<string, (row: T, value: string) => boolean>
  initialFilters?: Record<string, string>
}

const DEFAULT_PAGE_SIZES = [10, 25, 50, 100]

interface PersistedPreferences {
  sort?: SortState | null
  pageSize?: number
  hiddenColumns?: string[]
  filters?: Record<string, string>
}

function readPreferences(key: string): PersistedPreferences {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as PersistedPreferences
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writePreferences(key: string, value: PersistedPreferences) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Mode privé ou stockage plein : les préférences valent pour la session.
  }
}

/** Champ texte normalisé pour la recherche : casse et accents ignorés. */
export function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
}

export function useDataTable<T>(options: DataTableOptions<T>) {
  const {
    storageKey,
    rows,
    searchText,
    sorters = {},
    initialSort = null,
    columns = [],
    defaultPageSize = 25,
    pageSizeOptions = DEFAULT_PAGE_SIZES,
    filterPredicates = {},
    initialFilters = {},
  } = options

  const [preferences] = React.useState<PersistedPreferences>(() =>
    typeof window === "undefined" ? {} : readPreferences(storageKey),
  )

  const [search, setSearchState] = React.useState("")
  const [sort, setSort] = React.useState<SortState | null>(
    preferences.sort !== undefined ? preferences.sort : initialSort,
  )
  const [filters, setFilters] = React.useState<Record<string, string>>({
    ...initialFilters,
    ...(preferences.filters ?? {}),
  })
  const [pageSize, setPageSizeState] = React.useState(
    preferences.pageSize && preferences.pageSize > 0
      ? preferences.pageSize
      : defaultPageSize,
  )
  const [page, setPageState] = React.useState(0)
  const [hiddenColumns, setHiddenColumns] = React.useState<string[]>(
    preferences.hiddenColumns ?? [],
  )

  // Enregistrement des préférences : un seul effet, une seule clé.
  React.useEffect(() => {
    writePreferences(storageKey, { sort, pageSize, hiddenColumns, filters })
  }, [storageKey, sort, pageSize, hiddenColumns, filters])

  const filtered = React.useMemo(() => {
    const needle = normalizeSearch(search)
    let result = rows

    for (const [name, value] of Object.entries(filters)) {
      if (!value) continue
      const predicate = filterPredicates[name]
      if (predicate) result = result.filter((row) => predicate(row, value))
    }

    if (needle && searchText) {
      result = result.filter((row) => normalizeSearch(searchText(row)).includes(needle))
    }

    if (sort && sorters[sort.column]) {
      const compare = sorters[sort.column]
      result = [...result].sort((a, b) =>
        sort.direction === "asc" ? compare(a, b) : compare(b, a),
      )
    }

    return result
  }, [rows, filters, filterPredicates, search, searchText, sort, sorters])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)

  // Le filtrage peut rendre la page courante inexistante. On ne « corrige »
  // pas l'état après coup (cela déclencherait un rendu en cascade) : la page
  // affichée est *dérivée*, bornée à la dernière page valide. La prochaine
  // interaction, elle, repart d'un index cohérent.

  const pageRows = React.useMemo(
    () => filtered.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [filtered, safePage, pageSize],
  )

  const setSearch = React.useCallback((value: string) => {
    setSearchState(value)
    setPageState(0)
  }, [])

  const setFilter = React.useCallback((name: string, value: string) => {
    setFilters((current) => ({ ...current, [name]: value }))
    setPageState(0)
  }, [])

  const toggleSort = React.useCallback((column: string) => {
    setSort((current) => {
      if (current?.column !== column) return { column, direction: "asc" }
      if (current.direction === "asc") return { column, direction: "desc" }
      // Troisième clic : on revient à l'ordre naturel de la source.
      return initialSort && initialSort.column === column ? initialSort : null
    })
    setPageState(0)
  }, [initialSort])

  const setPageSize = React.useCallback((value: number) => {
    setPageSizeState(value)
    setPageState(0)
  }, [])

  const toggleColumn = React.useCallback((id: string) => {
    setHiddenColumns((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }, [])

  const visibleColumns = React.useMemo(
    () => columns.filter((column) => !hiddenColumns.includes(column.id)),
    [columns, hiddenColumns],
  )

  const activeFilterCount =
    Object.values(filters).filter(Boolean).length + (search.trim() ? 1 : 0)

  const reset = React.useCallback(() => {
    setSearchState("")
    setFilters(initialFilters)
    setSort(initialSort)
    setHiddenColumns([])
    setPageState(0)
  }, [initialFilters, initialSort])

  return {
    search,
    setSearch,
    sort,
    toggleSort,
    filters,
    setFilter,
    resetFilters: () => setFilters(initialFilters),
    activeFilterCount,
    page: safePage,
    setPage: setPageState,
    pageSize,
    setPageSize,
    pageCount,
    pageRows,
    filtered,
    total: rows.length,
    hiddenColumns,
    toggleColumn,
    visibleColumns,
    isColumnHidden: (id: string) => hiddenColumns.includes(id),
    reset,
    pageSizeOptions,
  }
}

export type DataTableController<T> = ReturnType<typeof useDataTable<T>>

interface TableToolbarProps {
  search: string
  onSearchChange: (value: string) => void
  searchLabel?: string
  placeholder?: string
  total: number
  filtered: number
  /** Filtres (Select, dates…) affichés à côté de la recherche. */
  children?: React.ReactNode
  columns?: ColumnDefinition[]
  hiddenColumns?: string[]
  onToggleColumn?: (id: string) => void
  onReset?: () => void
  /** Nombre de filtres actifs, pour n'afficher « Réinitialiser » qu'à propos. */
  activeFilterCount?: number
  className?: string
}

export function TableToolbar({
  search,
  onSearchChange,
  searchLabel = "Rechercher dans le tableau",
  placeholder = "Rechercher…",
  total,
  filtered,
  children,
  columns = [],
  hiddenColumns = [],
  onToggleColumn,
  onReset,
  activeFilterCount = 0,
  className,
}: TableToolbarProps) {
  const inputId = React.useId()
  const showReset = activeFilterCount > 0 || hiddenColumns.length > 0

  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-b p-3 sm:flex-row sm:flex-wrap sm:items-center",
        className,
      )}
    >
      <div className="relative min-w-0 flex-1 sm:max-w-xs">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <label htmlFor={inputId} className="sr-only">
          {searchLabel}
        </label>
        <input
          id={inputId}
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          className="h-10 w-full rounded-lg border border-input bg-background pr-8 pl-8 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 md:h-9 [&::-webkit-search-cancel-button]:hidden"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange("")}
            aria-label="Effacer la recherche"
            className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      {children}

      <div className="flex items-center gap-1.5 sm:ml-auto">
        <p
          className="mr-1 text-xs text-muted-foreground tabular-nums"
          aria-live="polite"
          aria-atomic="true"
        >
          {filtered === total
            ? `${total} ${total > 1 ? "lignes" : "ligne"}`
            : `${filtered} sur ${total}`}
        </p>

        {columns.length > 0 && onToggleColumn && (
          <ColumnSettings
            columns={columns}
            hiddenColumns={hiddenColumns}
            onToggle={onToggleColumn}
          />
        )}

        {showReset && onReset && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            className="h-9 gap-1.5 text-muted-foreground md:h-8"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            Réinitialiser
          </Button>
        )}
      </div>
    </div>
  )
}

export function ColumnSettings({
  columns,
  hiddenColumns,
  onToggle,
}: {
  columns: ColumnDefinition[]
  hiddenColumns: string[]
  onToggle: (id: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 md:h-8"
            aria-label="Configurer les colonnes affichées"
          />
        }
      >
        <Columns3 className="size-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">Colonnes</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Colonnes affichées</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {columns.map((column) => (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={!hiddenColumns.includes(column.id)}
              disabled={column.required}
              onCheckedChange={() => onToggle(column.id)}
            >
              {column.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface SortableHeadProps {
  label: string
  column: string
  sort: SortState | null
  onSort: (column: string) => void
  align?: "left" | "right"
  className?: string
  /** Description plus longue que le libellé, en infobulle. */
  title?: string
}

/**
 * En-tête de colonne triable. Le tri est **explicite** : `aria-sort` est posé
 * sur le `<th>`, la flèche indique le sens, et le troisième clic ramène à
 * l'ordre naturel — un tri qu'on ne peut pas annuler est un piège.
 */
export function SortableHead({
  label,
  column,
  sort,
  onSort,
  align = "left",
  className,
  title,
}: SortableHeadProps) {
  const active = sort?.column === column
  const ariaSort = active
    ? sort.direction === "asc"
      ? "ascending"
      : "descending"
    : "none"
  const Icon = active ? (sort.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown

  return (
    <TableHead
      aria-sort={ariaSort}
      className={cn(align === "right" && "text-right", className)}
      title={title}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "group/sort inline-flex min-h-9 items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          active && "text-foreground",
          align === "right" && "flex-row-reverse",
        )}
      >
        {label}
        <Icon
          className={cn(
            "size-3.5 shrink-0 transition-opacity",
            active ? "opacity-100" : "opacity-40 group-hover/sort:opacity-80",
          )}
          aria-hidden="true"
        />
        <span className="sr-only">
          {active
            ? sort.direction === "asc"
              ? " — trié croissant, cliquez pour décroissant"
              : " — trié décroissant, cliquez pour revenir à l'ordre initial"
            : " — cliquez pour trier"}
        </span>
      </button>
    </TableHead>
  )
}

interface TablePaginationProps {
  page: number
  pageCount: number
  pageSize: number
  pageSizeOptions?: number[]
  total: number
  filtered: number
  onPage: (page: number) => void
  onPageSize: (size: number) => void
}

export function TablePagination({
  page,
  pageCount,
  pageSize,
  pageSizeOptions = DEFAULT_PAGE_SIZES,
  total,
  filtered,
  onPage,
  onPageSize,
}: TablePaginationProps) {
  const from = filtered === 0 ? 0 : page * pageSize + 1
  const to = Math.min(filtered, (page + 1) * pageSize)

  return (
    <div className="flex flex-col gap-3 border-t p-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
        {filtered === 0
          ? "Aucun résultat à afficher"
          : `${from}–${to} sur ${filtered} ${filtered > 1 ? "résultats" : "résultat"}`}
        {filtered !== total && ` (${total} au total)`}
      </p>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="hidden sm:inline">Lignes</span>
          <select
            value={pageSize}
            onChange={(event) => onPageSize(Number(event.target.value))}
            className="h-9 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
            aria-label="Nombre de lignes par page"
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            className="size-9 md:size-7"
            onClick={() => onPage(Math.max(0, page - 1))}
            disabled={page <= 0}
            aria-label="Page précédente"
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <span className="min-w-16 text-center text-xs text-muted-foreground tabular-nums">
            {page + 1} / {pageCount}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            className="size-9 md:size-7"
            onClick={() => onPage(Math.min(pageCount - 1, page + 1))}
            disabled={page >= pageCount - 1}
            aria-label="Page suivante"
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Ligne d'état vide : le tableau garde sa structure, la consigne reste claire. */
export function TableEmptyRow({
  colSpan,
  ...empty
}: React.ComponentProps<typeof EmptyState> & { colSpan: number }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="p-0">
        <EmptyState {...empty} />
      </TableCell>
    </TableRow>
  )
}

/**
 * Échec de chargement orienté solution : ce qui s'est passé, quoi faire,
 * et un bouton pour réessayer — jamais un code HTTP seul.
 */
export function TableErrorRow({
  colSpan,
  message,
  onRetry,
}: {
  colSpan: number
  message: string
  onRetry?: () => void
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="p-0">
        <div
          role="alert"
          className="flex flex-col items-center gap-3 px-6 py-8 text-center"
        >
          <span className="flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
            <TriangleAlert className="size-5" aria-hidden="true" />
          </span>
          <div className="space-y-1">
            <p className="font-medium">Impossible de charger ces données</p>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              {message} Vérifiez votre connexion, puis réessayez. Si le problème
              persiste, signalez-le depuis Assistance.
            </p>
          </div>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Réessayer
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

/** Conteneur de tableau qui devient une liste de cartes sous 768 px. */
export function ResponsiveTable({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("table-cards", className)} data-responsive-table="">
      {children}
    </div>
  )
}
