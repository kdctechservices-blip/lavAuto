"use client"

import { useEffect, useRef, useState } from "react"
import { Clock, User } from "lucide-react"
import { motion } from "framer-motion"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress"
import { cn } from "cn"
import {
  countdownProgress,
  countdownState,
  estimatedSeconds,
  formatDuration,
  remainingSeconds,
} from "@/lib/wash-countdown"
import { taskLabel, type WashTaskSummary } from "@/lib/wash-tasks"

export interface ActiveWashTask extends WashTaskSummary {
  id: string
  reference: string
  plate: string | null
  customer_name: string | null
  /**
   * Les laveurs affectes : le responsable d'abord.
   *
   * Facultatif : un serveur plus ancien que l'ecran ne les envoie pas, et
   * une carte sans laveur est une carte qui montre moins, pas une carte qui
   * plante.
   */
  washers?: Array<{ id: string; name: string; role: string }>
  /** Duree estimee, en minutes. */
  estimated_minutes: number | null
  /** Instant du depart du decompte. `null` tant que personne n'a commence. */
  operation_started_at: string | null
  operation_status: string
}

export interface ActiveWashTaskProps {
  wash: ActiveWashTask
  /** L'utilisateur a-t-il le droit de faire avancer la tache ? */
  canAdvance?: boolean
  /** Une ecriture est-elle en cours sur cette tache ? */
  busy?: boolean
  /** Demande le debut du decompte. */
  onStart?: (washId: string) => void
  /** Fin demandee a la main : elle demande une confirmation. */
  onFinish?: (washId: string) => void
  /** Fin decider par le decompte : le temps est ecoule, personne ne demande. */
  onAutoFinish?: (washId: string) => void
}

/**
 * La tache en cours, telle qu'elle se voit a la station.
 *
 * Deux gestes, un seul point de contact :
 *
 *   - une tache qui n'a pas encore commence se **lance** en cliquant dessus ;
 *   - une tache qui tourne se **termine** en cliquant dessus, mais seulement
 *     apres une confirmation — un clic est trop facile a donner par megarde,
 *     et une tache terminee trop tot est une tache qui n'a pas ete faite.
 *
 * La barre suit le temps ecoule sur la duree estimee. Quand elle atteint
 * 100 %, la tache se termine d'elle-meme : la voiture est sortie depuis assez
 * longtemps, et le laveur n'a plus rien a faire dessus.
 */
export function ActiveWashTaskCard({
  wash,
  canAdvance = false,
  busy = false,
  onStart,
  onFinish,
  onAutoFinish,
}: ActiveWashTaskProps) {
  const totalSeconds = estimatedSeconds(wash.estimated_minutes)
  const [elapsed, setElapsed] = useState(0)
  // La fin automatique ne doit se produire qu'une fois : le compteur garde
  // trace du passage, pas l'etat de l'ecran.
  const termine = useRef(false)
  // Les rappels changent a chaque rendu du parent ; on les garde dans des
  // references pour ne pas reconstruire le minuteur sans arret.
  const onFinishRef = useRef(onFinish)
  const onAutoFinishRef = useRef(onAutoFinish)
  useEffect(() => {
    onFinishRef.current = onFinish
    onAutoFinishRef.current = onAutoFinish
  })

  useEffect(() => {
    if (!wash.operation_started_at) return
    const depart = Date.parse(wash.operation_started_at)
    if (Number.isNaN(depart)) return

    const mesurer = () => {
      const ecoule = Math.max(0, Math.floor((Date.now() - depart) / 1000))
      setElapsed(ecoule)
      // Le temps ecoule suffit a finir la tache : elle se termine d'elle-meme.
      // Personne ne demande, donc personne ne confirme : la voiture est
      // sortie depuis assez longtemps.
      if (totalSeconds > 0 && ecoule >= totalSeconds && !termine.current) {
        if (wash.operation_status === "in_progress") {
          termine.current = true
          onAutoFinishRef.current?.(wash.id)
        }
      }
    }
    const minuteur = setInterval(mesurer, 1000)
    return () => clearInterval(minuteur)
  }, [wash.operation_started_at, wash.id, totalSeconds, wash.operation_status])

  const secondeEcoulee = wash.operation_started_at ? elapsed : 0
  const etat = countdownState(wash.operation_started_at, secondeEcoulee, totalSeconds)
  const pourcentage = countdownProgress(secondeEcoulee, totalSeconds)
  const restant = remainingSeconds(secondeEcoulee, totalSeconds)

  const nom = taskLabel(wash)
  // Le serveur peut etre plus ancien que l'ecran : un champ absent ne doit
  // pas faire tomber la carte. Une station ne s'arrete pas parce qu'une
  // version a change de leger.
  const laveurs = wash.washers ?? []
  const laveur = laveurs.length > 0 ? laveurs.map((worker) => worker.name).join(", ") : null
  const declencheur = etat === "not_started" ? onStart : onFinish
  const cliquable = Boolean(declencheur) && canAdvance && !busy

  const badgeVariant = wash.operation_status === "pending" ? "destructive" : wash.operation_status === "overtime" ? "destructive" : "secondary"
  const badgeClass = wash.operation_status === "overtime" ? "border border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400" : etat === "not_started" && wash.operation_status === "pending" ? "border border-destructive/30" : undefined
  const badgeLabel = wash.operation_status === "overtime" ? "Temps dépassé" : etat === "not_started" ? "En attente" : "En cours"

  return (
    <motion.div
      initial={{ scale: 0.95, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      whileHover={cliquable ? { scale: 1.02, y: -2 } : undefined}
      whileTap={cliquable ? { scale: 0.98 } : undefined}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
      layout
    >
      <Card
        data-slot="active-wash-task"
        data-operation-status={wash.operation_status}
        className={cn(
          "gap-3 transition-shadow backdrop-blur-sm bg-card/95",
          cliquable && "cursor-pointer hover:shadow-lg hover:shadow-primary/5 focus-visible:ring-[3px] focus-visible:ring-ring/50",
          busy && "opacity-70",
        )}
      role={cliquable ? "button" : undefined}
      tabIndex={cliquable ? 0 : undefined}
      aria-label={
        cliquable
          ? etat === "not_started"
            ? `Démarrer la tâche de ${nom}`
            : `Terminer la tâche de ${nom}`
          : undefined
      }
      onClick={cliquable ? () => declencheur?.(wash.id) : undefined}
      onKeyDown={
        cliquable
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                declencheur?.(wash.id)
              }
            }
          : undefined
      }
    >
      <CardHeader className="gap-1.5 px-4 pb-0">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="truncate text-base">{nom}</CardTitle>
          <Badge
            variant={badgeVariant}
            className={cn(
              "shrink-0",
              badgeClass,
            )}
          >
            {badgeLabel}
          </Badge>
        </div>
        <p className="font-mono text-xs uppercase tabular-nums text-muted-foreground">
          {wash.plate || wash.reference}
        </p>
      </CardHeader>

      <CardContent className="space-y-3 px-4 pb-4">
        {laveur && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <User className="size-3.5" />
            {laveur}
          </p>
        )}

          <Progress value={pourcentage} className="gap-1.5">
            <ProgressLabel className="text-xs text-muted-foreground">
              {etat === "not_started" ? "Temps de lavage estimé" : wash.operation_status === "overtime" ? "Temps dépassé" : "Temps écoulé"}
            </ProgressLabel>
            <ProgressValue className="text-xs tabular-nums" />
          </Progress>

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3.5" />
          {etat === "not_started"
            ? totalSeconds > 0
              ? `Estimation : ${formatDuration(totalSeconds)}`
              : "Durée estimée inconnue"
            : etat === "finished"
              ? "Temps écoulé — la tâche se termine"
              : `Reste ${formatDuration(restant)}`}
        </p>
        </CardContent>
      </Card>
    </motion.div>
  )
}
