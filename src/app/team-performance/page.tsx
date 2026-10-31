"use client"

import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { BaseLayout } from "@/components/layouts/base-layout"
import { useAccess } from "@/lib/permissions"
import { useCapability } from "@/lib/subscription"
import { PlanGate } from "@/components/subscription/plan-gate"
import { BlockedReason } from "@/components/access/blocked-reason"
import { TableSkeleton } from "@/components/ui/table-skeleton"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { useApi } from "@/lib/api"

interface LigneRendement {
  worker_id: string
  first_name: string
  last_name: string
  role: string
  status: string
  participations: number
  as_principal: number
  share_milli: number
  present_days: number
  late_days: number
  absences: number
  leaves: number
  worked_minutes: number
  incomplete_records: number
  per_present_day_milli: number | null
  per_worked_hour_milli: number | null
}

interface Rendement {
  from: string
  to: string
  station: {
    completed_washes: number
    unassigned_washes: number
    no_attendance: boolean
    no_schedule: boolean
  }
  workers: LigneRendement[]
  daily: { day: string; washes: number }[]
}

const chartConfig = {
  washes: { label: "Lavages", color: "#0f766e" },
  part: { label: "Part de travail", color: "#2563eb" },
} satisfies ChartConfig

const PERIODES = [
  { jours: 7, label: "7 jours" },
  { jours: 30, label: "30 jours" },
  { jours: 90, label: "90 jours" },
]

/** Millièmes de parts/heure → « 0,38 ». */
function partsHeure(milli: number | null): string {
  return milli === null ? "—" : (milli / 1000).toLocaleString("fr-CI", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Millièmes de lavage → « 4,33 ». Jamais un entier trompeur. */
function parts(milli: number): string {
  return (milli / 1000).toLocaleString("fr-CI", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function dureeHeures(minutes: number): string {
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`
}

function ProductiviteLigne({ l, noSchedule }: { l: LigneRendement; noSchedule: boolean }) {
  return (
    <TableRow className={l.status !== "active" ? "opacity-60" : undefined}>
      <TableCell className="font-medium">
        {l.first_name} {l.last_name}
        <span className="block text-xs text-muted-foreground">
          {l.role}
          {noSchedule ? " · horaire non configuré" : ""}
        </span>
      </TableCell>
      <TableCell className="text-right tabular-nums">{l.participations}</TableCell>
      <TableCell className="text-right font-medium tabular-nums">{parts(l.share_milli)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {partsHeure(l.per_worked_hour_milli)}
        {l.incomplete_records > 0 && (
          <span
            className="block text-xs text-amber-700 dark:text-amber-400"
            title="Un départ n’a pas été pointé : le total est incomplet, le rendement est suspendu."
          >
            rendement suspendu
          </span>
        )}
      </TableCell>
    </TableRow>
  )
}

function ilYa(jours: number): string {
  return new Date(Date.now() - (jours - 1) * 86_400_000).toISOString().slice(0, 10)
}

export default function TeamPerformancePage() {
  const lire = useAccess("attendance:read")
  const planEquipe = useCapability("team.tracking")

  const [jours, setJours] = useState(30)
  const from = useMemo(() => ilYa(jours), [jours])
  const to = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const { data, loading, error } = useApi<Rendement>(`/api/v1/team-performance?from=${from}&to=${to}`)

  const lignes = useMemo(
    () => [...(data?.workers ?? [])].sort((a, b) => b.share_milli - a.share_milli),
    [data],
  )
  const actifs = useMemo(() => lignes.filter((l) => l.participations > 0), [lignes])

  // Les laveurs d’abord ; les autres rôles (caissier…) participent à la station
  // mais ne se jugent pas sur des lavages. Le rôle est un libellé libre.
  const estLaveur = (r: string) => r.toLowerCase().includes("lav")
  const laveurs = useMemo(() => lignes.filter((l) => estLaveur(l.role)), [lignes])
  const autres = useMemo(() => lignes.filter((l) => !estLaveur(l.role)), [lignes])

  const totalParticipations = useMemo(() => lignes.reduce((s, l) => s + l.participations, 0), [lignes])
  const totalParts = useMemo(() => lignes.reduce((s, l) => s + l.share_milli, 0), [lignes])
  const totalRetards = useMemo(() => lignes.reduce((s, l) => s + l.late_days, 0), [lignes])
  const totalMinutes = useMemo(() => lignes.reduce((s, l) => s + l.worked_minutes, 0), [lignes])
  const quelquePointageIncomplet = useMemo(
    () => lignes.some((l) => l.incomplete_records > 0),
    [lignes],
  )

  const repartition = useMemo(
    () =>
      actifs.slice(0, 10).map((l) => ({
        nom: `${l.first_name} ${(l.last_name ?? "").slice(0, 1)}.`.trim(),
        part: Number((l.share_milli / 1000).toFixed(2)),
      })),
    [actifs],
  )

  if (lire.loading === false && lire.allowed === false) {
    return (
      <BaseLayout title="Rendement" description="Ce que chacun a fait, sur une base comparable.">
        <div className="p-4">
          <BlockedReason reason={lire.reason ?? "Vous n’avez pas accès au rendement de l’équipe."} />
        </div>
      </BaseLayout>
    )
  }

  if (planEquipe.loading === false && planEquipe.allowed === false) {
    return (
      <BaseLayout title="Rendement" description="Ce que chacun a fait, sur une base comparable.">
        <div className="p-4">
          <PlanGate
            permission="attendance:read"
            capability="team.tracking"
            title="Présences et rendement"
            pitch="Voyez qui travaille, combien de lavages reviennent à chacun et comment la charge se répartit, sans compter à la main."
          >
            <span />
          </PlanGate>
        </div>
      </BaseLayout>
    )
  }

  return (
    <BaseLayout title="Rendement" description="Ce que chacun a fait, sur une base comparable.">
      <div className="space-y-6 p-4">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Un lavage fait à trois reste <strong>un</strong> lavage pour la station. Chacun en reçoit une part, pas un
            lavage entier : c’est ce qui permet de comparer sans gonfler personne.
          </p>
          <div className="flex gap-2">
            {PERIODES.map((p) => (
              <Button
                key={p.jours}
                variant={jours === p.jours ? "default" : "outline"}
                size="sm"
                onClick={() => setJours(p.jours)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>

        {data?.station.no_attendance && (
          <Card className="border-dashed">
            <CardContent className="py-4 text-sm text-muted-foreground">
              Personne n’a encore pointé sur cette période. Les colonnes de temps et le rendement horaire restent
              donc vides — ils ne valent pas zéro, ils sont inconnus. Commencez par{" "}
              <Link to="/equipe" className="underline underline-offset-2">
                pointer les arrivées
              </Link>
              .
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Lavages terminés</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{data?.station.completed_washes ?? 0}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">Annulés exclus. Compté sur les lavages, pas sur les parts.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Sans laveur affecté</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{data?.station.unassigned_washes ?? 0}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {(data?.station.unassigned_washes ?? 0) > 0
                  ? "Ce travail n’est attribué à personne."
                  : "Tout le travail est attribué."}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Laveurs actifs</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{actifs.length}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">Ont participé à au moins un lavage.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Retards</CardDescription>
              <CardTitle className="text-2xl tabular-nums">
                {data?.station.no_schedule ? "—" : lignes.reduce((s, l) => s + l.late_days, 0)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {data?.station.no_schedule ? "Aucun horaire configuré." : "Sur la période."}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Participations aux lavages</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{totalParticipations}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">Présences comptées, même à plusieurs sur un véhicule.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Parts de travail cumulées</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{parts(totalParts)}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">Réparties selon la règle de la station.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Retards enregistrés</CardDescription>
              <CardTitle className="text-2xl tabular-nums">
                {data?.station.no_schedule ? "—" : totalRetards}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {data?.station.no_schedule ? "Aucun horaire configuré." : "Sur la période."}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Temps pointé par employé</CardDescription>
              <CardTitle className="text-2xl tabular-nums">
                {totalMinutes > 0 ? dureeHeures(totalMinutes) : "—"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {quelquePointageIncomplet
                  ? "Un pointage est incomplet : total amputé, pas faux."
                  : "Somme des pointages complets de la période."}
              </p>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Lavages par jour</CardTitle>
              <CardDescription>Volume de travail de la station, lavages annulés exclus.</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-[260px] w-full" />
              ) : (data?.daily ?? []).length === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">Aucun lavage sur la période.</p>
              ) : (
                <ChartContainer config={chartConfig} className="h-[260px] w-full">
                  <BarChart data={data?.daily ?? []} margin={{ left: 0, right: 12, top: 8 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="day"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      minTickGap={24}
                      tickFormatter={(v) => new Date(`${String(v)}T00:00:00Z`).toLocaleDateString("fr-CI", { day: "2-digit", month: "2-digit" })}
                    />
                    <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} />
                    <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                    <Bar
                      dataKey="washes"
                      name="Lavages"
                      fill="var(--color-washes)"
                      radius={[4, 4, 0, 0]}
                      animationDuration={600}
                      animationEasing="ease-out"
                    />
                  </BarChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Répartition du travail</CardTitle>
              <CardDescription>
                En parts de lavage. Un lavage fait à deux compte une demi-part pour chacun.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-[260px] w-full" />
              ) : repartition.length === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  Aucun lavage attribué sur la période.
                </p>
              ) : (
                <ChartContainer config={chartConfig} className="h-[260px] w-full">
                  <BarChart data={repartition} layout="vertical" margin={{ left: 8, right: 16, top: 8 }}>
                    <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                    <XAxis type="number" tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="nom" tickLine={false} axisLine={false} width={88} />
                    <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                    <Bar
                      dataKey="part"
                      name="Parts de lavage"
                      fill="var(--color-part)"
                      radius={[0, 4, 4, 0]}
                      animationDuration={600}
                      animationEasing="ease-out"
                    />
                  </BarChart>
                </ChartContainer>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Productivité de l’équipe</CardTitle>
            <CardDescription>
              Quatre questions simples : combien de lavages, quelle contribution, combien de temps travaillé et quel
              rendement. Un tiret signifie que la donnée manque, jamais qu’elle vaut zéro.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <TableSkeleton rows={5} cols={4} label="Chargement du rendement" />
            ) : error ? (
              <BlockedReason reason="Le rendement n’a pas pu être chargé." />
            ) : lignes.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Aucun employé enregistré.</p>
            ) : (
              <div className="space-y-6">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Employé</TableHead>
                        <TableHead className="text-right">Lavages</TableHead>
                        <TableHead className="text-right">Parts</TableHead>
                        <TableHead className="text-right">Parts / h</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...laveurs, ...autres].map((l) => (
                        <ProductiviteLigne key={l.worker_id} l={l} noSchedule={data?.station.no_schedule ?? false} />
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <p className="text-xs text-muted-foreground">
                  Parts/h = parts de travail ÷ heures pointées. « Lavages » compte les participations : un lavage fait
                  à trois revient à chacun, pas trois lavages entiers. Les autres rôles (caissier…) participent au
                  fonctionnement de la station sans être jugés sur des lavages effectués.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-dashed">
          <CardHeader>
            <CardTitle className="text-base">Ce que ces chiffres ne disent pas</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              <strong>Ni durée de lavage, ni tâche en cours.</strong> WashPilot enregistre un lavage une fois
              terminé, comme une caisse enregistreuse : il n’existe pas d’heure de début ni de fin par prestation.
              Plutôt que d’afficher une colonne vide, nous ne la montrons pas.
            </p>
            <p>
              <strong>Un classement n’est pas un jugement.</strong> Les parts dépendent du type de lavage confié et du
              temps de présence. Un laveur affecté aux véhicules les plus sales fera moins de parts sans travailler
              moins.
            </p>
          </CardContent>
        </Card>
      </div>
    </BaseLayout>
  )
}
