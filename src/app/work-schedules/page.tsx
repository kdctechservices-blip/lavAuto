/**
 * Horaires de travail et historique de présence.
 *
 * Cette page répond à une phrase affichée depuis longtemps sur « Équipe du
 * jour » : « Définissez un horaire pour que les retards soient calculés. »
 * Sans horaire de référence, le serveur ne déclare jamais personne en retard —
 * c'est volontaire, mais encore faut-il pouvoir saisir cet horaire.
 *
 * Deux parties, parce que ce sont deux usages distincts :
 *  - les RÈGLES (à quelle heure on commence), qu'on définit une fois ;
 *  - le PASSÉ (qui est venu, quand), qu'on consulte sur une période.
 * Le pointage du jour reste sur « Équipe du jour ».
 */
import { useMemo, useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import { BaseLayout } from "@/components/layouts/base-layout"
import { useAccess } from "@/lib/permissions"
import { useCapability } from "@/lib/subscription"
import { PlanGate } from "@/components/subscription/plan-gate"
import { actionGate } from "@/lib/action-blocking"
import { BlockedReason } from "@/components/access/blocked-reason"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TableSkeleton } from "@/components/ui/table-skeleton"
import { useApi } from "@/lib/api"
import { useMutation } from "@/lib/use-mutation"
import type { SiteRecord } from "@/lib/sites-api"
import type { WorkerRecord } from "@/lib/team-api"
import {
  DAYS_OF_WEEK,
  MAX_BREAK_MINUTES,
  MAX_LATE_TOLERANCE_MINUTES,
  describeScope,
  describeWhen,
  formatDuration,
  formatMinuteOfDay,
  isExpired,
  parseMinuteOfDay,
  type AttendanceHistoryRow,
  type WorkScheduleRecord,
} from "@/lib/schedule-api"
import { CalendarClock, Clock, Trash2 } from "lucide-react"

const CREATE_KEY = "schedule-create"
const DELETE_KEY = "schedule-delete"

function aujourdhui(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function ilYaUnMois(): string {
  const d = new Date()
  d.setMonth(d.getMonth() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function heure(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

const LIBELLES_STATUT: Record<string, { texte: string; ton: "ok" | "alerte" | "neutre" }> = {
  present: { texte: "Présent", ton: "ok" },
  late: { texte: "En retard", ton: "alerte" },
  absent_declared: { texte: "Absent (déclaré)", ton: "alerte" },
  absent_justified: { texte: "Absent (justifié)", ton: "neutre" },
  absent_unjustified: { texte: "Absent (non justifié)", ton: "alerte" },
  leave: { texte: "Congé", ton: "neutre" },
  not_recorded: { texte: "Non pointé", ton: "neutre" },
}

/** Portée d'un horaire, telle qu'on la choisit dans le formulaire. */
type Portee = "tous" | "station" | "employe"
/** Récurrence d'un horaire, telle qu'on la choisit dans le formulaire. */
type Quand = "chaque_jour" | "jour_semaine" | "date_precise"

export default function WorkSchedulesPage() {
  const lire = useAccess("attendance:read")
  const corriger = useAccess("attendance:correct")
  const planEquipe = useCapability("team.tracking")

  const editionGate = actionGate({ loading: corriger.loading, allowed: corriger.allowed, reason: corriger.reason })

  const [refreshKey, setRefreshKey] = useState(0)
  const autorise = lire.allowed && planEquipe.allowed

  const { data: horaires, loading: horairesLoading } = useApi<WorkScheduleRecord[]>(
    autorise ? `/api/v1/work-schedules?refresh=${refreshKey}` : "",
  )
  const { data: employes } = useApi<WorkerRecord[]>(autorise ? "/api/v1/workers" : "")
  const { data: stations } = useApi<SiteRecord[]>(autorise ? "/api/v1/sites" : "")

  const mutation = useMutation()
  const busyCreate = mutation.busyKey === CREATE_KEY
  const busyDelete = mutation.busyKey === DELETE_KEY

  const nomEmploye = useMemo(() => {
    const map = new Map<string, string>()
    for (const e of employes ?? []) map.set(e.id, `${e.first_name} ${e.last_name}`.trim())
    return map
  }, [employes])

  const nomStation = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of stations ?? []) map.set(s.id, s.name)
    return map
  }, [stations])

  // ------------------------------------------------------------ création --
  const [formOpen, setFormOpen] = useState(false)
  const [portee, setPortee] = useState<Portee>("tous")
  const [stationId, setStationId] = useState("")
  const [employeId, setEmployeId] = useState("")
  const [quand, setQuand] = useState<Quand>("chaque_jour")
  const [jourSemaine, setJourSemaine] = useState("1")
  const [datePrecise, setDatePrecise] = useState(aujourdhui())
  const [debut, setDebut] = useState("08:00")
  const [fin, setFin] = useState("18:00")
  const [pause, setPause] = useState("60")
  const [tolerance, setTolerance] = useState("15")
  const [valableDu, setValableDu] = useState(aujourdhui())
  const [valableAu, setValableAu] = useState("")
  const [erreur, setErreur] = useState<string | null>(null)

  function ouvrirFormulaire() {
    setPortee("tous")
    setStationId("")
    setEmployeId("")
    setQuand("chaque_jour")
    setJourSemaine("1")
    setDatePrecise(aujourdhui())
    setDebut("08:00")
    setFin("18:00")
    setPause("60")
    setTolerance("15")
    setValableDu(aujourdhui())
    setValableAu("")
    setErreur(null)
    setFormOpen(true)
  }

  const minuteDebut = parseMinuteOfDay(debut)
  const minuteFin = parseMinuteOfDay(fin)
  const dureeTravail =
    minuteDebut !== null && minuteFin !== null && minuteFin > minuteDebut
      ? minuteFin - minuteDebut - (Number(pause) || 0)
      : null

  async function enregistrer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setErreur(null)

    if (minuteDebut === null || minuteFin === null) {
      setErreur("Indiquez une heure de début et une heure de fin valides.")
      return
    }
    if (minuteFin <= minuteDebut) {
      setErreur("L’heure de fin doit suivre l’heure de début.")
      return
    }
    if (portee === "station" && !stationId) {
      setErreur("Choisissez la station concernée.")
      return
    }
    if (portee === "employe" && !employeId) {
      setErreur("Choisissez l’employé concerné.")
      return
    }
    const pauseMinutes = Number(pause)
    if (!Number.isInteger(pauseMinutes) || pauseMinutes < 0 || pauseMinutes > MAX_BREAK_MINUTES) {
      setErreur(`La pause doit être comprise entre 0 et ${MAX_BREAK_MINUTES} minutes.`)
      return
    }
    const toleranceMinutes = Number(tolerance)
    if (!Number.isInteger(toleranceMinutes) || toleranceMinutes < 0 || toleranceMinutes > MAX_LATE_TOLERANCE_MINUTES) {
      setErreur(`La tolérance doit être comprise entre 0 et ${MAX_LATE_TOLERANCE_MINUTES} minutes.`)
      return
    }
    if (pauseMinutes >= minuteFin - minuteDebut) {
      setErreur("La pause ne peut pas durer plus longtemps que la journée elle-même.")
      return
    }

    const outcome = await mutation.run({
      url: "/api/v1/work-schedules",
      method: "POST",
      body: {
        site_id: portee === "station" ? stationId : null,
        worker_id: portee === "employe" ? employeId : null,
        day_of_week: quand === "jour_semaine" ? Number(jourSemaine) : null,
        specific_date: quand === "date_precise" ? datePrecise : null,
        start_minute: minuteDebut,
        end_minute: minuteFin,
        break_duration_minutes: pauseMinutes,
        late_tolerance_minutes: toleranceMinutes,
        valid_from: valableDu || aujourdhui(),
        valid_to: valableAu || null,
      },
      success: "Horaire enregistré. Les retards seront désormais calculés.",
      failure: "Impossible d’enregistrer cet horaire.",
      busyKey: CREATE_KEY,
    })
    if (!outcome.ok) return
    setFormOpen(false)
    setRefreshKey((k) => k + 1)
  }

  async function supprimer(horaire: WorkScheduleRecord) {
    const outcome = await mutation.run({
      url: `/api/v1/work-schedules/${encodeURIComponent(horaire.id)}`,
      method: "DELETE",
      confirm:
        "Retirer cet horaire ? Les présences déjà enregistrées ne changent pas : seuls les prochains pointages cesseront d’être comparés à cette heure de référence.",
      success: "Horaire retiré.",
      failure: "Impossible de retirer cet horaire.",
      busyKey: DELETE_KEY,
    })
    if (outcome.ok) setRefreshKey((k) => k + 1)
  }

  // ----------------------------------------------------------- historique --
  const [du, setDu] = useState(ilYaUnMois())
  const [au, setAu] = useState(aujourdhui())
  const [filtreEmploye, setFiltreEmploye] = useState("tous")

  const requeteHistorique = useMemo(() => {
    if (!autorise) return ""
    const p = new URLSearchParams({ from: du, to: au })
    if (filtreEmploye !== "tous") p.set("worker_id", filtreEmploye)
    return `/api/v1/attendance/history?${p.toString()}`
  }, [autorise, du, au, filtreEmploye])

  const { data: historique, loading: historiqueLoading } = useApi<AttendanceHistoryRow[]>(requeteHistorique)
  const lignesHistorique = historique ?? []

  if (lire.loading || planEquipe.loading) {
    return (
      <BaseLayout title="Horaires" description="Heures de référence et historique de présence.">
        <div className="p-4">
          <TableSkeleton rows={5} />
        </div>
      </BaseLayout>
    )
  }

  if (!autorise) {
    return (
      <BaseLayout title="Horaires" description="Heures de référence et historique de présence.">
        <div className="p-4">
          <PlanGate
            permission="attendance:read"
            capability="team.tracking"
            title="Horaires et historique"
            pitch="Fixez l’heure à laquelle la journée commence, et retrouvez qui est venu, quand, sur n’importe quelle période."
          >
            <span />
          </PlanGate>
        </div>
      </BaseLayout>
    )
  }

  return (
    <BaseLayout title="Horaires" description="Heures de référence et historique de présence.">
      <div className="space-y-6 p-4">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Tant qu’aucun horaire n’existe, <strong>personne n’est jamais déclaré en retard</strong> : il n’y a pas
            d’heure à laquelle se comparer. Le pointage du jour se fait sur{" "}
            <Link to="/equipe" className="underline underline-offset-4">
              Équipe du jour
            </Link>
            .
          </p>
          <Button onClick={ouvrirFormulaire} disabled={editionGate.disabled || busyCreate}>
            <Clock className="mr-2 h-4 w-4" />
            Nouvel horaire
          </Button>
        </div>

        {editionGate.denied && editionGate.reason && <BlockedReason reason={editionGate.reason} />}

        <Card>
          <CardHeader>
            <CardTitle>Heures de référence</CardTitle>
            <CardDescription>
              Le plus précis l’emporte : un horaire posé sur un employé prime sur celui de sa station, qui prime sur
              l’horaire général.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {horairesLoading ? (
              <TableSkeleton rows={4} />
            ) : (horaires ?? []).length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Aucun horaire défini. Les arrivées sont enregistrées telles quelles, sans notion de retard.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Qui</TableHead>
                    <TableHead>Quand</TableHead>
                    <TableHead>Journée</TableHead>
                    <TableHead>Pause</TableHead>
                    <TableHead>Tolérance</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(horaires ?? []).map((h) => {
                    const perime = isExpired(h, aujourdhui())
                    return (
                      <TableRow key={h.id} className={perime ? "opacity-60" : undefined}>
                        <TableCell className="font-medium">
                          {describeScope(h, nomEmploye.get(h.worker_id ?? "") ?? null, nomStation.get(h.site_id ?? "") ?? null)}
                          {perime && (
                            <Badge variant="outline" className="ml-2">
                              Périmé
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>{describeWhen(h)}</TableCell>
                        <TableCell className="tabular-nums">
                          {formatMinuteOfDay(h.start_minute)} – {formatMinuteOfDay(h.end_minute)}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {h.break_duration_minutes > 0 ? formatDuration(h.break_duration_minutes) : "—"}
                        </TableCell>
                        <TableCell className="tabular-nums">{h.late_tolerance_minutes} min</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void supprimer(h)}
                            disabled={editionGate.disabled || busyDelete}
                            aria-label="Retirer cet horaire"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Historique de présence</CardTitle>
            <CardDescription>
              Ce qui a été pointé sur la période, correction comprise. Le statut est celui qui a été{" "}
              <em>enregistré</em> : le retard, lui, se calcule chaque jour par rapport à l’horaire en vigueur et
              s’affiche sur « Équipe du jour ». Ici, c’est l’heure d’arrivée qui fait foi.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-4">
              <label className="grid gap-1.5 text-sm">
                <span>Du</span>
                <Input type="date" value={du} onChange={(e) => setDu(e.target.value || ilYaUnMois())} className="w-44" />
              </label>
              <label className="grid gap-1.5 text-sm">
                <span>Au</span>
                <Input type="date" value={au} onChange={(e) => setAu(e.target.value || aujourdhui())} className="w-44" />
              </label>
              <div className="grid gap-1.5 text-sm">
                <span>Employé</span>
                <Select value={filtreEmploye} onValueChange={(v) => setFiltreEmploye(v ?? "tous")}>
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tous">Tout le monde</SelectItem>
                    {(employes ?? []).map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.first_name} {e.last_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {historiqueLoading ? (
              <TableSkeleton rows={5} />
            ) : lignesHistorique.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Aucune présence enregistrée sur cette période.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Employé</TableHead>
                    <TableHead>Arrivée</TableHead>
                    <TableHead>Départ</TableHead>
                    <TableHead>Pause</TableHead>
                    <TableHead>Statut</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lignesHistorique.map((ligne) => {
                    const statut = LIBELLES_STATUT[ligne.status] ?? { texte: ligne.status, ton: "neutre" as const }
                    return (
                      <TableRow key={ligne.id}>
                        <TableCell className="tabular-nums">{ligne.work_date}</TableCell>
                        <TableCell className="font-medium">
                          {ligne.first_name} {ligne.last_name}
                        </TableCell>
                        <TableCell className="tabular-nums">{heure(ligne.check_in_at)}</TableCell>
                        <TableCell className="tabular-nums">{heure(ligne.check_out_at)}</TableCell>
                        <TableCell className="tabular-nums">
                          {ligne.break_minutes ? formatDuration(ligne.break_minutes) : "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Badge variant={statut.ton === "alerte" ? "destructive" : statut.ton === "ok" ? "default" : "outline"}>
                              {statut.texte}
                            </Badge>
                            {ligne.corrected_at && (
                              <Badge variant="outline" title={ligne.correction_reason ?? undefined}>
                                Corrigé
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
            {lignesHistorique.length >= 500 && (
              <p className="text-xs text-muted-foreground">
                Seules les 500 journées les plus récentes sont affichées. Réduisez la période pour voir le reste.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={enregistrer}>
            <DialogHeader>
              <DialogTitle>Nouvel horaire</DialogTitle>
              <DialogDescription>
                L’heure de début sert de référence pour les retards. La tolérance évite de marquer en retard quelqu’un
                qui arrive à 08h03.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label>Qui est concerné</Label>
                <Select value={portee} onValueChange={(v) => setPortee((v as Portee | null) ?? "tous")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tous">Tout le monde</SelectItem>
                    <SelectItem value="station">Une station</SelectItem>
                    <SelectItem value="employe">Un employé</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {portee === "station" && (
                <div className="grid gap-2">
                  <Label>Station</Label>
                  <Select value={stationId} onValueChange={(v) => setStationId(v ?? "")}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choisir une station" />
                    </SelectTrigger>
                    <SelectContent>
                      {(stations ?? []).map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {portee === "employe" && (
                <div className="grid gap-2">
                  <Label>Employé</Label>
                  <Select value={employeId} onValueChange={(v) => setEmployeId(v ?? "")}>
                    <SelectTrigger>
                      <SelectValue placeholder="Choisir un employé" />
                    </SelectTrigger>
                    <SelectContent>
                      {(employes ?? []).map((e) => (
                        <SelectItem key={e.id} value={e.id}>
                          {e.first_name} {e.last_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="grid gap-2">
                <Label>Quand</Label>
                <Select value={quand} onValueChange={(v) => setQuand((v as Quand | null) ?? "chaque_jour")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="chaque_jour">Tous les jours</SelectItem>
                    <SelectItem value="jour_semaine">Un jour de la semaine</SelectItem>
                    <SelectItem value="date_precise">Une date précise</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {quand === "jour_semaine" && (
                <div className="grid gap-2">
                  <Label>Jour</Label>
                  <Select value={jourSemaine} onValueChange={(v) => setJourSemaine(v ?? "1")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DAYS_OF_WEEK.map((d) => (
                        <SelectItem key={d.value} value={String(d.value)}>
                          {d.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {quand === "date_precise" && (
                <div className="grid gap-2">
                  <Label htmlFor="date-precise">Date</Label>
                  <Input
                    id="date-precise"
                    type="date"
                    value={datePrecise}
                    onChange={(e) => setDatePrecise(e.target.value)}
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="debut">Début</Label>
                  <Input id="debut" type="time" value={debut} onChange={(e) => setDebut(e.target.value)} required />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="fin">Fin</Label>
                  <Input id="fin" type="time" value={fin} onChange={(e) => setFin(e.target.value)} required />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="pause">Pause (minutes)</Label>
                  <Input
                    id="pause"
                    type="number"
                    min={0}
                    max={MAX_BREAK_MINUTES}
                    value={pause}
                    onChange={(e) => setPause(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="tolerance">Tolérance (minutes)</Label>
                  <Input
                    id="tolerance"
                    type="number"
                    min={0}
                    max={MAX_LATE_TOLERANCE_MINUTES}
                    value={tolerance}
                    onChange={(e) => setTolerance(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="valable-du">Valable à partir du</Label>
                  <Input
                    id="valable-du"
                    type="date"
                    value={valableDu}
                    onChange={(e) => setValableDu(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="valable-au">Jusqu’au (facultatif)</Label>
                  <Input
                    id="valable-au"
                    type="date"
                    value={valableAu}
                    onChange={(e) => setValableAu(e.target.value)}
                  />
                </div>
              </div>

              {dureeTravail !== null && dureeTravail > 0 && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CalendarClock className="h-4 w-4" />
                  Journée effective : <strong>{formatDuration(dureeTravail)}</strong> de travail, pause déduite.
                </p>
              )}

              {erreur && (
                <p role="alert" className="text-sm text-destructive">
                  {erreur}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={busyCreate} aria-busy={busyCreate}>
                {busyCreate ? "Enregistrement…" : "Enregistrer"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </BaseLayout>
  )
}
