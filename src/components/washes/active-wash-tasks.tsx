"use client"

import { useState } from "react"
import { motion, AnimatePresence } from "framer-motion"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ActiveWashTaskCard, type ActiveWashTask } from "@/components/washes/active-wash-task"
import { selectVisibleTasks } from "@/lib/wash-tasks"

export interface ActiveWashTasksProps {
  /** Les lavages encore en attente ou en cours. */
  washes: ActiveWashTask[]
  /** L'utilisateur a-t-il le droit de faire avancer une tache ? */
  canAdvance?: boolean
  /** Un lavage est-il en cours de changement ? */
  busyWashIds?: string[]
  /** Lance le decompte. */
  onStart?: (washId: string) => void
  /** Termine la tache, une fois la confirmation donnee. */
  onFinish?: (washId: string) => void
  /** Termine la tache sans confirmation : le temps est ecoule. */
  onAutoFinish?: (washId: string) => void
}

/**
 * Le panneau des taches en cours.
 *
 * Il tient deux choses : les cartes, et la confirmation. La confirmation
 * vit ici parce qu'elle est la contrepartie d'un clic sur une carte : c'est
 * le meme geste, avec une porte entre les deux. Terminer une tache sans
 * confirmation, ce serait declarer un travail fait qui ne l'est peut-etre
 * pas — et personne ne rattrape une declaration prematuree.
 */
export function ActiveWashTasks({
  washes,
  canAdvance = false,
  busyWashIds = [],
  onStart,
  onFinish,
  onAutoFinish: _onAutoFinish,
}: ActiveWashTasksProps) {
  const [aConfirmer, setAConfirmer] = useState<ActiveWashTask | null>(null)

  if (washes.length === 0) return null

  const { visibles, masquees } = selectVisibleTasks(washes)

  function demanderFin(washId: string) {
    const wash = washes.find((item) => item.id === washId)
    if (!wash) return
    setAConfirmer(wash)
  }

  function confirmerFin() {
    const wash = aConfirmer
    setAConfirmer(null)
    if (wash) onFinish?.(wash.id)
  }

  return (
    <section aria-label="Tâches en cours" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">À la station</h2>
        <p className="text-sm text-muted-foreground">
          {washes.length === 1 ? "1 tâche en cours" : `${washes.length} tâches en cours`}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <AnimatePresence mode="popLayout">
          {visibles.map((wash) => (
            <motion.div
              key={wash.id}
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: -20 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
              layout
            >
              <ActiveWashTaskCard
                wash={wash}
                canAdvance={canAdvance}
                busy={busyWashIds.includes(wash.id)}
                onStart={onStart}
                onFinish={demanderFin}
                onAutoFinish={_onAutoFinish}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {masquees > 0 && (
        <p className="text-xs text-muted-foreground">
          {masquees === 1
            ? "1 autre tâche n’est pas affichée : l’écran en montre cinq à la fois."
            : `${masquees} autres tâches ne sont pas affichées : l’écran en montre cinq à la fois.`}
        </p>
      )}

      <Dialog open={aConfirmer !== null} onOpenChange={(open) => !open && setAConfirmer(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Terminer cette tâche ?</DialogTitle>
            <DialogDescription>
              Le lavage « {aConfirmer?.customer_name?.trim() || aConfirmer?.plate || aConfirmer?.reference} »
              sera marqué comme terminé. Cette action est définitive.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAConfirmer(null)}>
              Annuler
            </Button>
            <Button type="button" onClick={confirmerFin}>
              Confirmer la fin
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
