"use client"

import { useMemo, useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import { BaseLayout } from "@/components/layouts/base-layout"
import { useAccess } from "@/lib/permissions"
import { useCapability } from "@/lib/subscription"
import { PlanGate } from "@/components/subscription/plan-gate"
import { actionGate } from "@/lib/action-blocking"
import { BlockedReason } from "@/components/access/blocked-reason"
import { Badge } from "@/components/ui/badge"
import { TableSkeleton } from "@/components/ui/table-skeleton"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useApi } from "@/lib/api"
import { useMutation } from "@/lib/use-mutation"
import { LogIn, LogOut, PencilLine, UserX } from "lucide-react"

interface Ligne {
  worker_id: string
  first_name: string
  last_name: string
  role: string
  record_id: string | null
  check_in_at: string | null
  check_out_at: string | null
  break_minutes: number | null
  absence_reason: string | null
  corrected_at: string | null
  correction_reason: string | null
  corrected_by: string | null
  state: string
  late_minutes: number | null
  scheduled_start_minute: number | null
  worked_minutes: number | null
}

interface Journee {
  date: string
  workers: Ligne[]
  summary: {
    expected: number
    present: number
    late: number
    absent_declared: number
    absent_justified: number
    absent_unjustified: number
    leave: number
    not_recorded: number
    incomplete: number
    no_schedule: boolean
  }
}

/**
 * Libellés des états du jour.
 *
 * « Non pointé » et « Absence signalée » sont volontairement éloignés l'un de
 * l'autre : le premier dit qu'on ne sait pas, le second dit quelque chose de
 * la personne. Les confondre à l'écran reviendrait à accuser sur un silence.
 */
const ETATS: Record<string, { label: string; ton: "ok" | "alerte" | "absent" | "inconnu" }> = {
  not_recorded: { label: "Non pointé", ton: "inconnu" },
  present: { label: "Présent", ton: "ok" },
  late: { label: "En retard", ton: "alerte" },
  left: { label: "Parti", ton: "ok" },
  incomplete: { label: "Pointage incomplet", ton: "alerte" },
  absent_declared: { label: "Absence signalée", ton: "absent" },
  absent_justified: { label: "Absence autorisée", ton: "absent" },
  absent_unjustified: { label: "Absence non justifiée", ton: "absent" },
  leave: { label: "Congé", ton: "absent" },
}

const TONS: Record<string, string> = {
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  alerte: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  absent: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  inconnu: "bg-muted text-muted-foreground",
}

const CHECKIN_KEY = "checkin"
const ABSENCE_KEY = "absence"
const CORRECTION_KEY = "correction"

function heure(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`
}

function duree(minutes: number | null): string {
  // Une donnée absente ne s'affiche pas « 0 h » : elle s'affiche comme
  // manquante, pour appeler une correction plutôt qu'un reproche.
  if (minutes === null) return "—"
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`
}

function aujourdhui(): string {
  return new Date().toISOString().slice(0, 10)
}

export default function TeamAttendancePage() {
  const lire = useAccess("attendance:read")
  const pointer = useAccess("attendance:manage")
  const corriger = useAccess("attendance:correct")
  const planEquipe = useCapability("team.tracking")

  const pointageGate = actionGate({ loading: pointer.loading, allowed: pointer.allowed, reason: pointer.reason })
  const correctionGate = actionGate({ loading: corriger.loading, allowed: corriger.allowed, reason: corriger.reason })

  const [date, setDate] = useState(aujourdhui())
  const [refreshKey, setRefreshKey] = useState(0)
  const { data, loading, error } = useApi<Journee>(`/api/v1/attendance?date=${date}&refresh=${refreshKey}`)
  const lignes = useMemo(() => data?.workers ?? [], [data])
  const resume = data?.summary

  const mutation = useMutation()
  const busyPointage = mutation.busyKey === CHECKIN_KEY
  const busyAbsence = mutation.busyKey === ABSENCE_KEY
  const busyCorrection = mutation.busyKey === CORRECTION_KEY

  async function pointerArrivee(ligne: Ligne) {
    const outcome = await mutation.run({
      url: "/api/v1/attendance/check-in",
      method: "POST",
      body: { worker_id: ligne.worker_id, work_date: date },
      success: `Arrivée de ${ligne.first_name} enregistrée.`,
      failure: "Impossible d’enregistrer l’arrivée.",
      busyKey: CHECKIN_KEY,
    })
    if (outcome.ok) setRefreshKey((k) => k + 1)
  }

  async function pointerDepart(ligne: Ligne) {
    const outcome = await mutation.run({
      url: "/api/v1/attendance/check-out",
      method: "POST",
      body: { worker_id: ligne.worker_id, work_date: date },
      success: `Départ de ${ligne.first_name} enregistré.`,
      failure: "Impossible d’enregistrer le départ.",
      busyKey: CHECKIN_KEY,
    })
    if (outcome.ok) setRefreshKey((k) => k + 1)
  }

  // ------------------------------------------------------------ absence --
  const [absenceOpen, setAbsenceOpen] = useState(false)
  const [cible, setCible] = useState<Ligne | null>(null)
  const [typeAbsence, setTypeAbsence] = useState("absent_declared")
  const [motifAbsence, setMotifAbsence] = useState("")

  function ouvrirAbsence(ligne: Ligne) {
    setCible(ligne)
    setTypeAbsence("absent_declared")
    setMotifAbsence("")
    setAbsenceOpen(true)
  }

  async function enregistrerAbsence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!cible) return
    const outcome = await mutation.run({
      url: "/api/v1/attendance/absence",
      method: "POST",
      body: {
        worker_id: cible.worker_id,
        work_date: date,
        status: typeAbsence,
        ...(motifAbsence.trim() ? { reason: motifAbsence.trim() } : {}),
      },
      success: "Absence enregistrée.",
      failure: "Impossible d’enregistrer cette absence.",
      busyKey: ABSENCE_KEY,
    })
    if (!outcome.ok) return
    setAbsenceOpen(false)
    setRefreshKey((k) => k + 1)
  }

  // --------------------------------------------------------- correction --
  const [correctionOpen, setCorrectionOpen] = useState(false)
  const [aCorriger, setACorriger] = useState<Ligne | null>(null)
  const [arrivee, setArrivee] = useState("")
  const [depart, setDepart] = useState("")
  const [pause, setPause] = useState("")
  const [statutCorrige, setStatutCorrige] = useState("")
  const [motifCorrection, setMotifCorrection] = useState("")

  function ouvrirCorrection(ligne: Ligne) {
    setACorriger(ligne)
    setArrivee(ligne.check_in_at ? heure(ligne.check_in_at) : "")
    setDepart(ligne.check_out_at ? heure(ligne.check_out_at) : "")
    setPause(ligne.break_minutes === null ? "" : String(ligne.break_minutes))
    setStatutCorrige("")
    setMotifCorrection("")
    setCorrectionOpen(true)
  }

  async function enregistrerCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!aCorriger?.record_id) return
    if (motifCorrection.trim().length < 3) {
      mutation.fail("Dites pourquoi ce relevé est corrigé : la trace en dépend.")
      return
    }
    const horodate = (valeur: string) => (valeur.trim() ? `${date}T${valeur.trim()}:00.000Z` : null)
    const outcome = await mutation.run({
      url: `/api/v1/attendance/${encodeURIComponent(aCorriger.record_id)}`,
      method: "PATCH",
      body: {
        ...(statutCorrige ? { status: statutCorrige } : {}),
        check_in_at: horodate(arrivee),
        check_out_at: horodate(depart),
        break_minutes: pause.trim() === "" ? null : Number(pause),
        reason: motifCorrection.trim(),
      },
      success: "Relevé corrigé. La modification est tracée.",
      failure: "Impossible de corriger ce relevé.",
      busyKey: CORRECTION_KEY,
    })
    if (!outcome.ok) return
    setCorrectionOpen(false)
    setRefreshKey((k) => k + 1)
  }

  if (lire.loading === false && lire.allowed === false) {
    return (
      <BaseLayout title="Équipe du jour" description="Qui est là, qui manque, et ce qui a été fait.">
        <div className="p-4">
          <BlockedReason reason={lire.reason ?? "Vous n’avez pas accès aux présences."} />
        </div>
      </BaseLayout>
    )
  }

  if (planEquipe.loading === false && planEquipe.allowed === false) {
    return (
      <BaseLayout title="Équipe du jour" description="Qui est là, qui manque, et ce qui a été fait.">
        <div className="p-4">
          <PlanGate
            permission="attendance:read"
            capability="team.tracking"
            title="Présences et rendement"
            pitch="Pointez les arrivées, suivez les absences et voyez qui fait quoi, sans cahier ni discussion de fin de mois."
          >
            <span />
          </PlanGate>
        </div>
      </BaseLayout>
    )
  }

  return (
    <BaseLayout title="Équipe du jour" description="Qui est là, qui manque, et ce qui a été fait.">
      <div className="space-y-6 p-4">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Un laveur « non pointé » n’est pas un absent : c’est une saisie qui manque. Les deux sont comptés
            séparément, et aucune absence n’est déduite d’un silence.
          </p>
          <label className="grid gap-1.5 text-sm">
            <span>Journée</span>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value || aujourdhui())} className="w-44" />
          </label>
        </div>

        {pointageGate.denied && pointageGate.reason && <BlockedReason reason={pointageGate.reason} />}

        {resume?.no_schedule && (
          <Card className="border-dashed">
            <CardContent className="py-4 text-sm text-muted-foreground">
              Aucun horaire n’est configuré pour cette station. Les arrivées sont enregistrées telles quelles et{" "}
              <strong>personne n’est déclaré en retard</strong> — il n’existe pas d’heure de référence à laquelle se
              comparer. Définissez un horaire pour que les retards soient calculés.
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {[
            { titre: "Effectif", valeur: resume?.expected ?? 0, note: "Laveurs en service" },
            { titre: "Présents", valeur: resume?.present ?? 0, note: "Arrivée pointée" },
            { titre: "Retards", valeur: resume?.late ?? 0, note: resume?.no_schedule ? "Sans objet" : "Au-delà de la tolérance" },
            {
              titre: "Absences",
              valeur: (resume?.absent_declared ?? 0) + (resume?.absent_justified ?? 0) + (resume?.absent_unjustified ?? 0) + (resume?.leave ?? 0),
              note: "Déclarées ou validées",
            },
            { titre: "Non pointés", valeur: resume?.not_recorded ?? 0, note: "Saisie manquante" },
          ].map((carte) => (
            <Card key={carte.titre}>
              <CardHeader className="pb-2">
                <CardDescription>{carte.titre}</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{carte.valeur}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">{carte.note}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Pointage du {new Date(`${date}T00:00:00Z`).toLocaleDateString("fr-CI")}</CardTitle>
            <CardDescription>
              Corriger un pointage réécrit ce qui pourra servir à juger quelqu’un : l’opération est réservée au
              propriétaire, exige un motif et reste dans l’historique.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <TableSkeleton rows={5} cols={6} label="Chargement de l’équipe" />
            ) : error ? (
              <BlockedReason reason="L’équipe du jour n’a pas pu être chargée." />
            ) : lignes.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Aucun laveur en service. Ajoutez votre équipe depuis{" "}
                <Link to="/team" className="underline underline-offset-2">
                  la page Équipe
                </Link>
                .
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Laveur</TableHead>
                      <TableHead>État</TableHead>
                      <TableHead>Arrivée</TableHead>
                      <TableHead>Départ</TableHead>
                      <TableHead className="text-right">Temps pointé</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lignes.map((ligne) => {
                      const etat = ETATS[ligne.state] ?? { label: ligne.state, ton: "inconnu" as const }
                      return (
                        <TableRow key={ligne.worker_id}>
                          <TableCell className="font-medium">
                            {ligne.first_name} {ligne.last_name}
                            <span className="block text-xs text-muted-foreground">{ligne.role}</span>
                          </TableCell>
                          <TableCell>
                            <Badge className={TONS[etat.ton]} variant="secondary">
                              {etat.label}
                            </Badge>
                            {ligne.late_minutes !== null && ligne.late_minutes > 0 && (
                              <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">
                                +{ligne.late_minutes} min
                              </span>
                            )}
                            {ligne.absence_reason && (
                              <span className="block text-xs text-muted-foreground">{ligne.absence_reason}</span>
                            )}
                            {ligne.corrected_at && (
                              <span
                                className="block text-xs italic text-muted-foreground"
                                title={`${ligne.correction_reason ?? ""}${ligne.corrected_by ? ` — ${ligne.corrected_by}` : ""}`}
                              >
                                Corrigé
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="tabular-nums">{heure(ligne.check_in_at)}</TableCell>
                          <TableCell className="tabular-nums">{heure(ligne.check_out_at)}</TableCell>
                          <TableCell className="text-right tabular-nums">{duree(ligne.worked_minutes)}</TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              {ligne.state === "not_recorded" && (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={pointageGate.disabled || busyPointage}
                                    aria-busy={busyPointage}
                                    title={pointageGate.reason ?? "Pointer l’arrivée"}
                                    onClick={() => pointerArrivee(ligne)}
                                  >
                                    <LogIn className="size-4" />
                                    <span className="sr-only">Pointer l’arrivée de {ligne.first_name}</span>
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={pointageGate.disabled}
                                    title={pointageGate.reason ?? "Signaler une absence"}
                                    onClick={() => ouvrirAbsence(ligne)}
                                  >
                                    <UserX className="size-4" />
                                    <span className="sr-only">Signaler l’absence de {ligne.first_name}</span>
                                  </Button>
                                </>
                              )}
                              {ligne.state === "present" || ligne.state === "late" ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={pointageGate.disabled || busyPointage}
                                  aria-busy={busyPointage}
                                  title={pointageGate.reason ?? "Pointer le départ"}
                                  onClick={() => pointerDepart(ligne)}
                                >
                                  <LogOut className="size-4" />
                                  <span className="sr-only">Pointer le départ de {ligne.first_name}</span>
                                </Button>
                              ) : null}
                              {ligne.record_id && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={correctionGate.disabled}
                                  title={correctionGate.reason ?? "Corriger ce relevé"}
                                  onClick={() => ouvrirCorrection(ligne)}
                                >
                                  <PencilLine className="size-4" />
                                  <span className="sr-only">Corriger le relevé de {ligne.first_name}</span>
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="text-sm text-muted-foreground">
          Le rendement de l’équipe se lit sur{" "}
          <Link to="/rendement" className="underline underline-offset-2">
            la page Rendement
          </Link>
          .
        </p>
      </div>

      {/* ----------------------------------------------------- absence -- */}
      <Dialog open={absenceOpen} onOpenChange={setAbsenceOpen}>
        <DialogContent>
          <form onSubmit={enregistrerAbsence}>
            <DialogHeader>
              <DialogTitle>
                Signaler l’absence de {cible?.first_name} {cible?.last_name}
              </DialogTitle>
              <DialogDescription>
                On enregistre ce qu’on sait aujourd’hui. Qualifier une absence de non justifiée est une décision
                distincte, qui se prend ensuite, par une correction tracée.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <label className="grid gap-1.5 text-sm">
                <span>Nature</span>
                <select
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  value={typeAbsence}
                  onChange={(e) => setTypeAbsence(e.target.value)}
                >
                  <option value="absent_declared">Absence signalée</option>
                  <option value="leave">Congé</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm">
                <span>Motif</span>
                <Input
                  value={motifAbsence}
                  onChange={(e) => setMotifAbsence(e.target.value)}
                  placeholder="Facultatif — a prévenu par téléphone"
                />
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAbsenceOpen(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={busyAbsence} aria-busy={busyAbsence}>
                {busyAbsence ? "Enregistrement…" : "Enregistrer"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* -------------------------------------------------- correction -- */}
      <Dialog open={correctionOpen} onOpenChange={setCorrectionOpen}>
        <DialogContent>
          <form onSubmit={enregistrerCorrection}>
            <DialogHeader>
              <DialogTitle>
                Corriger le relevé de {aCorriger?.first_name} {aCorriger?.last_name}
              </DialogTitle>
              <DialogDescription>
                L’ancienne valeur et la nouvelle seront conservées avec votre nom et votre motif. Rien n’est effacé.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="grid gap-1.5 text-sm">
                  <span>Arrivée</span>
                  <Input type="time" value={arrivee} onChange={(e) => setArrivee(e.target.value)} />
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span>Départ</span>
                  <Input type="time" value={depart} onChange={(e) => setDepart(e.target.value)} />
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span>Pause (min)</span>
                  <Input value={pause} onChange={(e) => setPause(e.target.value)} inputMode="numeric" placeholder="—" />
                </label>
              </div>
              <label className="grid gap-1.5 text-sm">
                <span>Requalifier</span>
                <select
                  className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  value={statutCorrige}
                  onChange={(e) => setStatutCorrige(e.target.value)}
                >
                  <option value="">Ne pas changer</option>
                  <option value="present">Présent</option>
                  <option value="absent_declared">Absence signalée</option>
                  <option value="absent_justified">Absence autorisée</option>
                  <option value="absent_unjustified">Absence non justifiée</option>
                  <option value="leave">Congé</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm">
                <span>Motif de la correction</span>
                <Input
                  value={motifCorrection}
                  onChange={(e) => setMotifCorrection(e.target.value)}
                  placeholder="Oubli de pointage, arrivée constatée à 7 h"
                />
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCorrectionOpen(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={busyCorrection} aria-busy={busyCorrection}>
                {busyCorrection ? "Correction…" : "Corriger"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </BaseLayout>
  )
}
