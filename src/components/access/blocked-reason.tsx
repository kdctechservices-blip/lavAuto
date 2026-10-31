import { Info } from "lucide-react"

/**
 * Pourquoi une action est indisponible, **visible à l'écran**.
 *
 * Le motif d'un refus était jusqu'ici passé en `title` sur un bouton
 * `disabled`. C'est un cul-de-sac : les navigateurs suppriment les
 * évènements pointeur sur un élément désactivé, donc l'infobulle n'apparaît
 * le plus souvent jamais. L'utilisateur voit un bouton gris et aucune
 * explication — exactement la question « nouveau lavage grisé, pourquoi ? ».
 *
 * Une action refusée doit dire pourquoi sans qu'on ait à la survoler. Le
 * `title` reste en place par-dessus, pour qui le verrait.
 *
 * `role="status"` plutôt que `role="alert"` : ce n'est pas une erreur que
 * l'utilisateur vient de commettre, c'est un état. Un lecteur d'écran
 * l'annonce sans interrompre la saisie en cours.
 */
export function BlockedReason({
  reason,
  className = "",
}: {
  reason: string | null | undefined
  className?: string
}) {
  if (!reason) return null
  return (
    <p
      role="status"
      className={`flex items-start gap-1.5 text-xs text-muted-foreground ${className}`}
    >
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{reason}</span>
    </p>
  )
}

export default BlockedReason
