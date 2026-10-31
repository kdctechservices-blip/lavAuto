"use client"

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useApi } from "@/lib/api"
import { useMutation } from "@/lib/use-mutation"
import { formatQuantity, parseQuantity, quantityToInput } from "@/lib/quantity"
import { Plus, RefreshCw, Trash2 } from "lucide-react"

/**
 * Déclaration de ce qu'une prestation consomme.
 *
 * Volontairement sobre : une liste de produits et, en face, une quantité.
 * Déclarer qu'un lavage complet consomme deux sachets d'Omo **ne change rien
 * au prix facturé** — le prix reste celui saisi dans la fiche de prestation.
 * Cela n'agit que sur le niveau de stock, au moment où le lavage est
 * enregistré.
 */

interface Product {
  id: string
  name: string
  unit: string
  is_active: boolean
}

interface Consumable {
  product_id: string
  quantity_milli: number
  product_name: string
  unit: string
}

interface Ligne {
  productId: string
  quantite: string
}

const SAVE_KEY = "recette"

export function ConsumablesDialog({
  serviceId,
  serviceName,
  open,
  onOpenChange,
  onSaved,
}: {
  serviceId: string | null
  serviceName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: () => void
}) {
  const { data: productData } = useApi<Product[]>(open ? "/api/v1/products" : "")
  const { data: current } = useApi<Consumable[]>(
    open && serviceId ? `/api/v1/services/${encodeURIComponent(serviceId)}/consumables` : "",
  )

  const products = useMemo(() => (productData ?? []).filter((p) => p.is_active), [productData])
  const mutation = useMutation()
  const saving = mutation.busyKey === SAVE_KEY

  const [lignes, setLignes] = useState<Ligne[]>([])
  const [chargePour, setChargePour] = useState<string | null>(null)

  // La recette venue du serveur est la valeur de départ du formulaire. On
  // l'installe pendant le rendu, pas dans un effet : c'est le motif que React
  // prévoit pour réinitialiser un état quand une propriété change, et il
  // évite le rendu en cascade. Le repère `chargePour` garantit qu'on ne
  // réécrase pas la saisie en cours, et qu'on ne garde pas les lignes de la
  // prestation précédente.
  if (open && serviceId && current !== null && chargePour !== serviceId) {
    setChargePour(serviceId)
    setLignes(
      current.map((item) => ({
        productId: item.product_id,
        quantite: quantityToInput(item.quantity_milli),
      })),
    )
  }
  if (!open && chargePour !== null) setChargePour(null)

  const produitsDisponibles = useMemo(
    () => products.filter((p) => !lignes.some((l) => l.productId === p.id)),
    [products, lignes],
  )

  function ajouterLigne() {
    const premier = produitsDisponibles[0]
    if (!premier) return
    setLignes((actuelles) => [...actuelles, { productId: premier.id, quantite: "1" }])
  }

  function retirerLigne(index: number) {
    setLignes((actuelles) => actuelles.filter((_, i) => i !== index))
  }

  function modifierLigne(index: number, champ: keyof Ligne, valeur: string) {
    setLignes((actuelles) =>
      actuelles.map((ligne, i) => (i === index ? { ...ligne, [champ]: valeur } : ligne)),
    )
  }

  async function enregistrer() {
    if (!serviceId) return
    const items: { product_id: string; quantity_milli: number }[] = []
    for (const ligne of lignes) {
      const quantite = parseQuantity(ligne.quantite)
      if (quantite === null || quantite <= 0) {
        const produit = products.find((p) => p.id === ligne.productId)
        mutation.fail(`Indiquez une quantité supérieure à zéro pour « ${produit?.name ?? "ce produit"} ».`)
        return
      }
      items.push({ product_id: ligne.productId, quantity_milli: quantite })
    }

    const outcome = await mutation.run({
      url: `/api/v1/services/${encodeURIComponent(serviceId)}/consumables`,
      method: "PUT",
      body: { items },
      success: "Consommables enregistrés.",
      failure: "Impossible d’enregistrer les consommables.",
      busyKey: SAVE_KEY,
    })
    if (!outcome.ok) return
    onOpenChange(false)
    onSaved?.()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next) }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Consommables de « {serviceName} »</DialogTitle>
          <DialogDescription>
            Ce que cette prestation sort du stock à chaque lavage enregistré.
            Cela ne modifie pas son prix, qui reste celui de sa fiche.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {products.length === 0 && (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              Aucun produit en stock pour l’instant. Déclarez d’abord vos produits dans l’écran Stock.
            </p>
          )}

          {lignes.length === 0 && products.length > 0 && (
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              Cette prestation ne consomme rien pour l’instant. Son enregistrement ne touchera aucun stock.
            </p>
          )}

          {lignes.map((ligne, index) => {
            const produit = products.find((p) => p.id === ligne.productId)
            const quantite = parseQuantity(ligne.quantite)
            return (
              <div key={`${ligne.productId}-${index}`} className="flex items-end gap-2">
                <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium">
                  Produit
                  <select
                    className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                    value={ligne.productId}
                    onChange={(e) => modifierLigne(index, "productId", e.target.value)}
                  >
                    {produit && <option value={produit.id}>{produit.name}</option>}
                    {produitsDisponibles.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label className="flex w-32 flex-col gap-1.5 text-sm font-medium">
                  Quantité
                  <Input
                    inputMode="decimal"
                    value={ligne.quantite}
                    onChange={(e) => modifierLigne(index, "quantite", e.target.value)}
                    placeholder="Ex. 2"
                  />
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="mb-0.5"
                  aria-label={`Retirer ${produit?.name ?? "ce produit"} de la recette`}
                  onClick={() => retirerLigne(index)}
                >
                  <Trash2 className="size-4" />
                </Button>
                <span className="sr-only">
                  {produit && quantite !== null ? formatQuantity(quantite, produit.unit) : ""}
                </span>
              </div>
            )
          })}

          {produitsDisponibles.length > 0 && (
            <Button type="button" variant="outline" size="sm" onClick={ajouterLigne}>
              <Plus className="mr-2 size-4" />
              Ajouter un produit
            </Button>
          )}

          {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Annuler
          </Button>
          <Button type="button" onClick={() => void enregistrer()} disabled={saving}>
            {saving && <RefreshCw className="mr-2 size-4 animate-spin" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
