"use client"

import * as React from "react"
import { useNavigate } from "react-router-dom"

import { useSearch } from "@/components/command-search"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { useAccess } from "@/lib/permissions"
import {
  SHORTCUTS,
  isTypingTarget,
  resolveKey,
  shortcutGroups,
  type SequenceState,
} from "@/lib/shortcuts"

/**
 * Raccourcis clavier globaux.
 *
 * `G` puis une lettre pour la navigation, `N` pour un nouveau lavage, `/` ou
 * `⌘K` pour chercher, `?` pour l'aide. Aucune touche ne fait rien quand le
 * focus est dans un champ : saisir une plaque « GL 1234 » ne doit pas ouvrir
 * les rapports.
 */
export function GlobalShortcuts() {
  const navigate = useNavigate()
  const { openSearch } = useSearch()
  const wash = useAccess("wash:create", "washes.create")
  const [helpOpen, setHelpOpen] = React.useState(false)
  const sequence = React.useRef<SequenceState>({ pending: null, at: 0 })

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return

      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.key.toLowerCase() === "k") {
        event.preventDefault()
        openSearch()
        return
      }
      // Les raccourcis à un caractère n'ont de sens que sans modificateur.
      if (modifier || event.altKey) return

      if (event.key === "Escape") {
        sequence.current = { pending: null, at: 0 }
        return
      }

      if (isTypingTarget(event.target)) return

      // Une boîte de dialogue est ouverte (recherche, confirmation, détail) :
      // naviguer derrière elle masquerait l'écran sans que l'utilisateur ait
      // conscience d'avoir quitté sa tâche. Échap reste disponible.
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return

      // Le dialogue d'aide est ouvert : on ne navigue pas sous ses pieds.
      if (helpOpen) {
        if (event.key === "?") {
          event.preventDefault()
          setHelpOpen(false)
        }
        return
      }

      if (event.key === "?") {
        event.preventDefault()
        setHelpOpen(true)
        return
      }

      if (event.key === "/") {
        event.preventDefault()
        openSearch()
        return
      }

      if (event.key.toLowerCase() === "n") {
        if (!wash.allowed) return
        event.preventDefault()
        navigate("/washes?new=1")
        return
      }

      const result = resolveKey(event.key, sequence.current)
      sequence.current = result.state

      if (result.matchedId === "help") {
        event.preventDefault()
        setHelpOpen(true)
        return
      }
      if (result.href) {
        event.preventDefault()
        navigate(result.href)
      }
    }

    // La palette (⌘K) propose « Raccourcis clavier » : elle ne peut pas
    // atteindre l'état local de ce composant, d'où un événement explicite
    // plutôt qu'une simulation de frappe.
    const openHelp = () => setHelpOpen(true)

    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("washpilot:shortcuts", openHelp)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("washpilot:shortcuts", openHelp)
    }
  }, [navigate, openSearch, wash.allowed, helpOpen])

  return <ShortcutHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
}

export function ShortcutHelpDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Raccourcis clavier</DialogTitle>
          <DialogDescription>
            Gagnez du temps au comptoir. Les raccourcis sont inactifs pendant la
            saisie dans un champ — votre frappe reste toujours intacte.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {shortcutGroups().map(({ group, shortcuts }) => (
            <section key={group} aria-labelledby={`shortcuts-${group}`}>
              <h3
                id={`shortcuts-${group}`}
                className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
              >
                {group}
              </h3>
              <dl className="divide-y rounded-lg border">
                {shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.id}
                    className="flex items-start justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <dt className="text-sm font-medium">{shortcut.label}</dt>
                      <dd className="text-xs leading-relaxed text-muted-foreground">
                        {shortcut.description}
                      </dd>
                    </div>
                    <KbdGroup className="shrink-0 pt-0.5" aria-label={`Touches : ${shortcut.keys.join(" puis ")}`}>
                      {shortcut.keys.map((key, index) => (
                        <React.Fragment key={key}>
                          {index > 0 && (
                            <span className="text-[10px] text-muted-foreground" aria-hidden="true">
                              puis
                            </span>
                          )}
                          <Kbd>{key}</Kbd>
                        </React.Fragment>
                      ))}
                    </KbdGroup>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {SHORTCUTS.length} raccourcis disponibles. Appuyez sur{" "}
          <Kbd className="align-middle">?</Kbd> à tout moment pour rouvrir cette liste.
        </p>
      </DialogContent>
    </Dialog>
  )
}
