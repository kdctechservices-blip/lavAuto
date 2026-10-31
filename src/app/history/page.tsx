"use client"

import { Fragment, useMemo, useState } from "react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { PlanGate } from "@/components/subscription/plan-gate"
import { usePermission } from "@/lib/permissions"
import { useCapability } from "@/lib/subscription"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TableSkeleton } from "@/components/ui/table-skeleton"
import { ResponsiveTable, TablePagination } from "@/components/ui/data-table"
import { formatDateTime } from "@/lib/format"
import { EmptyState } from "@/components/ui/empty-state"
import { useApi } from "@/lib/api"
import {
  AUDIT_SEVERITY_LABELS,
  AUDIT_SEVERITY_STYLES,
  metadataLabel,
  metadataValue,
  type AuditEntry,
  type AuditFiltersResponse,
  type AuditListResponse,
} from "@/lib/audit-api"
import {
  ChevronDown,
  Download,
  History,
  RotateCcw,
  ScrollText,
} from "lucide-react"

const PAGE_SIZE = 25
const ALL = "__all__"

/** Date du jour dans le fuseau d'Abidjan, au format accepté par `<input type="date">`. */
function dateInAbidjan(date = new Date()) {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "Africa/Abidjan",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date)
}

function shiftDate(date: string, days: number) {
  const next = new Date(`${date}T12:00:00Z`)
  next.setUTCDate(next.getUTCDate() + days)
  return next.toISOString().slice(0, 10)
}

/** « 18 oct. 2026, 14:32 » — mise en forme partagée par toute l'application. */
function formatMoment(iso: string) {
  return formatDateTime(iso)
}

function csvCell(value: string | number) {
  const text = String(value ?? "")
  return /[",;\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Export CSV de la page affichée. Le séparateur est le point-virgule : c'est
 * ce qu'attend Excel en locale française, sans quoi tout atterrit en colonne A.
 */
function downloadHistory(entries: AuditEntry[], from: string, to: string) {
  const rows: (string | number)[][] = [
    ["Date", "Opération", "Objet", "Identifiant", "Auteur", "Niveau", "Détails"],
    ...entries.map((entry) => [
      formatMoment(entry.created_at),
      entry.action_label,
      entry.entity_label,
      entry.entity_id ?? "",
      entry.actor_name,
      AUDIT_SEVERITY_LABELS[entry.severity],
      entry.metadata
        ? Object.entries(entry.metadata)
            .map(([key, value]) => `${metadataLabel(key)} : ${metadataValue(key, value)}`)
            .join(" · ")
        : "",
    ]),
  ]
  const csv = rows.map((row) => row.map(csvCell).join(";")).join("\n")
  // Le BOM force Excel à lire l'UTF-8 : sans lui, « Dépense » devient « DÃ©pense ».
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = `washpilot-historique-${from}-${to}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

export default function HistoryPage() {
  // Deux verrous distincts : le rôle (définitif) et le forfait (achetable).
  // On n'interroge l'API que si les deux passent, sinon chaque chargement de
  // page produirait un 402 inutile dans les journaux.
  const role = usePermission("audit:read")
  const plan = useCapability("audit.read")
  const access = { allowed: role.allowed && plan.allowed }
  const today = dateInAbidjan()

  const [from, setFrom] = useState(() => shiftDate(today, -29))
  const [to, setTo] = useState(today)
  const [action, setAction] = useState(ALL)
  const [entityType, setEntityType] = useState(ALL)
  const [actor, setActor] = useState(ALL)
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)

  const query = useMemo(() => {
    const params = new URLSearchParams({
      from,
      to,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    })
    if (action !== ALL) params.set("action", action)
    if (entityType !== ALL) params.set("entity_type", entityType)
    if (actor !== ALL) params.set("actor_user_id", actor)
    return params.toString()
  }, [from, to, action, entityType, actor, page])

  const { data, loading, error } = useApi<AuditListResponse>(
    access.allowed ? `/api/v1/audit-logs?${query}` : "",
  )
  const { data: filters } = useApi<AuditFiltersResponse>(
    access.allowed ? "/api/v1/audit-logs/filters" : "",
  )

  const entries = data?.entries ?? []
  const total = data?.total ?? 0
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)
  const filtered = action !== ALL || entityType !== ALL || actor !== ALL

  /** Tout changement de filtre renvoie en page 1 : rester en page 4 d'un
   *  résultat qui n'en compte plus que 2 donne un écran vide trompeur. */
  function updateFilter(setter: (value: string) => void) {
    // Base UI peut renvoyer `null` quand la sélection est effacée : on retombe
    // alors sur « tout », jamais sur une chaîne vide qui filtrerait à blanc.
    return (value: string | null) => {
      setter(value ?? ALL)
      setPage(0)
    }
  }

  function resetFilters() {
    setAction(ALL)
    setEntityType(ALL)
    setActor(ALL)
    setFrom(shiftDate(today, -29))
    setTo(today)
    setPage(0)
  }

  if (!access.allowed) {
    return (
      <BaseLayout
        title="Historique des opérations"
        description="Qui a fait quoi, quand, sur quel élément."
      >
        <div className="p-4">
          <PlanGate
            permission="audit:read"
            capability="audit.read"
            title="Historique des opérations"
            pitch="Retrouvez qui a annulé un lavage, remboursé un encaissement ou modifié les droits d’un collaborateur, avec la date et le motif."
          >
            <span />
          </PlanGate>
        </div>
      </BaseLayout>
    )
  }

  return (
    <BaseLayout
      title="Historique des opérations"
      description="Qui a fait quoi, quand, sur quel élément."
    >
      <div className="space-y-6 p-4">
        <p className="text-sm text-muted-foreground">
          L’historique est en lecture seule et ne peut être modifié, y compris par
          le propriétaire. Une erreur se corrige en enregistrant l’opération
          inverse, qui apparaîtra à son tour dans cette liste.
        </p>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScrollText className="size-4" /> Filtrer
            </CardTitle>
            <CardDescription>
              Les listes ne proposent que les valeurs réellement présentes dans
              votre historique.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <div className="space-y-2">
              <Label htmlFor="history-from">Du</Label>
              <Input
                id="history-from"
                type="date"
                value={from}
                max={to}
                onChange={(event) => {
                  setFrom(event.target.value)
                  setPage(0)
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="history-to">Au</Label>
              <Input
                id="history-to"
                type="date"
                value={to}
                min={from}
                max={today}
                onChange={(event) => {
                  setTo(event.target.value)
                  setPage(0)
                }}
              />
            </div>
            <div className="space-y-2">
              <Label>Opération</Label>
              <Select value={action} onValueChange={updateFilter(setAction)}>
                <SelectTrigger>
                  <SelectValue placeholder="Toutes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Toutes les opérations</SelectItem>
                  {(filters?.actions ?? []).map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                      {option.count ? ` (${option.count})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Objet</Label>
              <Select value={entityType} onValueChange={updateFilter(setEntityType)}>
                <SelectTrigger>
                  <SelectValue placeholder="Tous" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Tous les objets</SelectItem>
                  {(filters?.entity_types ?? []).map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Auteur</Label>
              <Select value={actor} onValueChange={updateFilter(setActor)}>
                <SelectTrigger>
                  <SelectValue placeholder="Tous" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Tous les auteurs</SelectItem>
                  {(filters?.actors ?? []).map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
            {loading
              ? "Chargement de l’historique…"
              : total === 0
                ? "Aucune opération sur cette période."
                : `${total} opération${total > 1 ? "s" : ""}${filtered ? " correspondant aux filtres" : ""}.`}
          </p>
          <div className="flex gap-2">
            {filtered && (
              <Button variant="outline" size="sm" onClick={resetFilters}>
                <RotateCcw className="mr-2 size-4" /> Réinitialiser
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={entries.length === 0}
              onClick={() => downloadHistory(entries, from, to)}
            >
              <Download className="mr-2 size-4" /> Exporter cette page
            </Button>
          </div>
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <Card>
          <CardContent className="p-0" aria-busy={loading}>
            {loading ? (
              <div className="p-4">
                <TableSkeleton rows={6} cols={5} label="Chargement de l’historique" />
              </div>
            ) : entries.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  icon={History}
                  title="Aucune opération enregistrée"
                  description={
                    filtered
                      ? "Aucune opération ne correspond à ces filtres. Élargissez la période ou réinitialisez."
                      : "Les encaissements, remboursements, clôtures de caisse et changements de droits apparaîtront ici au fil de l’activité."
                  }
                  action={
                    filtered ? (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
                        <RotateCcw className="mr-1.5 size-3.5" aria-hidden="true" />
                        Réinitialiser les filtres
                      </Button>
                    ) : undefined
                  }
                />
              </div>
            ) : (
              <ResponsiveTable>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Opération</TableHead>
                    <TableHead>Objet</TableHead>
                    <TableHead>Auteur</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => {
                    const details = entry.metadata ? Object.entries(entry.metadata) : []
                    const isOpen = expanded === entry.id
                    return (
                      <Fragment key={entry.id}>
                        <TableRow>
                          <TableCell data-label="Date" className="whitespace-nowrap text-sm text-muted-foreground">
                            <time dateTime={entry.created_at}>{formatMoment(entry.created_at)}</time>
                          </TableCell>
                          <TableCell data-label="Opération">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{entry.action_label}</span>
                              {entry.severity !== "info" && (
                                <Badge
                                  variant="outline"
                                  className={AUDIT_SEVERITY_STYLES[entry.severity]}
                                >
                                  {AUDIT_SEVERITY_LABELS[entry.severity]}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell data-label="Objet" className="text-sm">{entry.entity_label}</TableCell>
                          <TableCell data-label="Auteur" className="text-sm">{entry.actor_name}</TableCell>
                          <TableCell data-label="">
                            {details.length > 0 && (
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-expanded={isOpen}
                                aria-label={isOpen ? "Masquer les détails" : "Afficher les détails"}
                                onClick={() => setExpanded(isOpen ? null : entry.id)}
                              >
                                <ChevronDown
                                  className={`size-4 transition-transform duration-150 ${isOpen ? "rotate-180" : ""}`}
                                />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                        {isOpen && details.length > 0 && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell data-label="" colSpan={5} className="text-sm">
                              <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                                {details.map(([key, value]) => (
                                  <div key={key} className="flex gap-2">
                                    <dt className="text-muted-foreground">{metadataLabel(key)} :</dt>
                                    <dd className="font-medium">{metadataValue(key, value)}</dd>
                                  </div>
                                ))}
                                {entry.entity_id && (
                                  <div className="flex gap-2">
                                    <dt className="text-muted-foreground">Référence :</dt>
                                    <dd className="font-mono text-xs">{entry.entity_id}</dd>
                                  </div>
                                )}
                              </dl>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
              </ResponsiveTable>
            )}
          </CardContent>
        </Card>

        {total > 0 && (
          <TablePagination
            page={page}
            pageCount={lastPage + 1}
            pageSize={PAGE_SIZE}
            pageSizeOptions={[PAGE_SIZE]}
            total={total}
            filtered={total}
            onPage={setPage}
            onPageSize={() => {}}
          />
        )}
      </div>
    </BaseLayout>
  )
}
