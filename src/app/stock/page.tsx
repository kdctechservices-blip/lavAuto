"use client"

import type * as React from "react"

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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useApi } from "@/lib/api"
import { useMutation } from "@/lib/use-mutation"
import { createIdempotencyKey } from "@/lib/idempotency"
import {
  formatQuantity,
  parseQuantity,
  quantityToInput,
  stockValueCents,
  UNIT_OPTIONS,
} from "@/lib/quantity"
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, ClipboardList, Plus, RefreshCw } from "lucide-react"

interface ProductCategory {
  id: string
  name: string
  is_active: boolean
}

interface Product {
  id: string
  name: string
  category_id: string | null
  category_name: string | null
  unit: string
  unit_cost_cents: number
  unit_cost_updated_at: string | null
  low_stock_threshold_milli: number
  stock_milli: number
  low_stock: boolean
  is_active: boolean
}

interface Movement {
  id: string
  product_id: string
  product_name: string
  unit: string
  kind: string
  quantity_milli: number
  reason: string | null
  created_at: string
  first_name: string | null
  last_name: string | null
  /** Renseigné seulement pour une consommation ou sa contrepassation. */
  wash_id: string | null
  wash_reference: string | null
  /** Renseigné seulement pour une entrée issue d'un achat, ou sa reprise. */
  purchase_id: string | null
  purchase_reference: string | null
}

const KIND_LABELS: Record<string, string> = {
  initial: "Stock initial",
  entry: "Entrée",
  exit: "Sortie",
  inventory: "Écart d’inventaire",
  reversal: "Contrepassation",
}

const PRODUCT_KEY = "produit"
const CATEGORY_KEY = "categorie"
const MOVEMENT_KEY = "mouvement"
const INVENTORY_KEY = "inventaire"

const formatXOF = (cents: number) =>
  `${(cents / 100).toLocaleString("fr-CI", { maximumFractionDigits: 2 })} XOF`

export default function StockPage() {
  const readStock = useAccess("stock:read")
  const manageStock = useAccess("stock:manage")
  const moveStock = useAccess("stock:move")
  // Le suivi du stock appartient au forfait Pro. « stock.read » n'est pas
  // coupé en lecture seule : un espace échu reste consultable.
  const planStock = useCapability("stock.manage")

  // Ouvrir un formulaire n'écrit rien : on laisse cliquer pendant que les
  // droits chargent. Enregistrer écrit tout de suite : on attend.
  const productForm = actionGate({
    loading: manageStock.loading,
    allowed: manageStock.allowed,
    reason: manageStock.reason,
  })
  const movementGate = actionGate({
    loading: moveStock.loading,
    allowed: moveStock.allowed,
    reason: moveStock.reason,
  })

  const [refreshKey, setRefreshKey] = useState(0)
  const { data, loading, error } = useApi<Product[]>(`/api/v1/products?refresh=${refreshKey}`)
  const { data: movementData } = useApi<Movement[]>(`/api/v1/stock-movements?refresh=${refreshKey}`)
  const { data: categoryData } = useApi<ProductCategory[]>(`/api/v1/product-categories?refresh=${refreshKey}`)
  const categories = useMemo(() => (categoryData ?? []).filter((c) => c.is_active), [categoryData])
  const products = useMemo(() => data ?? [], [data])
  const movements = useMemo(() => (movementData ?? []).slice(0, 15), [movementData])

  const lowStock = useMemo(() => products.filter((p) => p.low_stock && p.is_active), [products])
  // Un stock négatif n'est pas une alerte de seuil : c'est un écart entre le
  // papier et l'étagère. On a consommé plus que ce qui était déclaré. Seul un
  // inventaire le referme.
  const negatifs = useMemo(() => products.filter((p) => p.stock_milli < 0 && p.is_active), [products])
  const totalValue = useMemo(
    () => products.reduce((sum, p) => sum + stockValueCents(p.stock_milli, p.unit_cost_cents), 0),
    [products],
  )

  const mutation = useMutation()
  const savingProduct = mutation.busyKey === PRODUCT_KEY
  const savingCategory = mutation.busyKey === CATEGORY_KEY
  const savingMovement = mutation.busyKey === MOVEMENT_KEY
  const savingInventory = mutation.busyKey === INVENTORY_KEY

  // ------------------------------------------------------------- produit --
  const [productOpen, setProductOpen] = useState(false)
  const [editing, setEditing] = useState<Product | null>(null)
  const [name, setName] = useState("")
  const [unit, setUnit] = useState("unite")
  const [categoryId, setCategoryId] = useState("")
  const [newCategoryOpen, setNewCategoryOpen] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState("")
  const [unitCost, setUnitCost] = useState("")
  const [threshold, setThreshold] = useState("")
  const [initialQuantity, setInitialQuantity] = useState("")

  function openCreateProduct() {
    setEditing(null)
    setName("")
    setUnit("unite")
    setCategoryId("")
    setUnitCost("")
    setThreshold("")
    setInitialQuantity("")
    mutation.reset()
    setProductOpen(true)
  }

  function openEditProduct(product: Product) {
    setEditing(product)
    setName(product.name)
    setUnit(product.unit)
    setCategoryId(product.category_id ?? "")
    setUnitCost(String(product.unit_cost_cents / 100))
    setThreshold(quantityToInput(product.low_stock_threshold_milli))
    setInitialQuantity("")
    mutation.reset()
    setProductOpen(true)
  }

  async function saveCategory() {
    const cleanName = newCategoryName.trim()
    if (!cleanName) {
      mutation.fail("Donnez un nom à la catégorie.")
      return
    }
    const outcome = await mutation.run({
      url: "/api/v1/product-categories",
      method: "POST",
      body: { name: cleanName },
      success: "Catégorie créée.",
      failure: "Impossible de créer cette catégorie.",
      busyKey: CATEGORY_KEY,
    })
    if (!outcome.ok) return
    // Le serveur renvoie la catégorie créée : on la sélectionne aussitôt pour
    // éviter de la chercher dans une liste qui vient seulement d'être rechargée.
    const created = outcome.data as { id?: string } | null
    if (created?.id) setCategoryId(created.id)
    setNewCategoryName("")
    setNewCategoryOpen(false)
    setRefreshKey((key) => key + 1)
  }

  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanName = name.trim()
    if (!cleanName) {
      mutation.fail("Donnez un nom au produit.")
      return
    }
    const cost = Math.round(Number(unitCost.replace(",", ".") || "0") * 100)
    if (!Number.isFinite(cost) || cost < 0) {
      mutation.fail("Le coût unitaire doit être un montant positif.")
      return
    }
    const thresholdMilli = threshold.trim() === "" ? 0 : parseQuantity(threshold)
    if (thresholdMilli === null || thresholdMilli < 0) {
      mutation.fail("Le seuil d’alerte doit être une quantité positive.")
      return
    }
    const initialMilli = initialQuantity.trim() === "" ? 0 : parseQuantity(initialQuantity)
    if (initialMilli === null || initialMilli < 0) {
      mutation.fail("La quantité initiale doit être une quantité positive.")
      return
    }

    const outcome = await mutation.run({
      url: editing ? `/api/v1/products/${encodeURIComponent(editing.id)}` : "/api/v1/products",
      method: editing ? "PATCH" : "POST",
      body: editing
        ? {
            name: cleanName,
            category_id: categoryId || null,
            unit_cost_cents: cost,
            low_stock_threshold_milli: thresholdMilli,
          }
        : {
            name: cleanName,
            category_id: categoryId || null,
            unit,
            unit_cost_cents: cost,
            low_stock_threshold_milli: thresholdMilli,
            initial_quantity_milli: initialMilli,
          },
      success: editing ? "Produit mis à jour." : "Produit créé.",
      failure: "Impossible d’enregistrer le produit.",
      busyKey: PRODUCT_KEY,
    })
    if (!outcome.ok) return
    setProductOpen(false)
    setRefreshKey((key) => key + 1)
  }

  // ---------------------------------------------------------- mouvement --
  const [movementOpen, setMovementOpen] = useState(false)
  const [movementProduct, setMovementProduct] = useState<Product | null>(null)
  const [movementKind, setMovementKind] = useState<"entry" | "exit">("entry")
  const [movementQuantity, setMovementQuantity] = useState("")
  const [movementReason, setMovementReason] = useState("")

  function openMovement(product: Product, kind: "entry" | "exit") {
    setMovementProduct(product)
    setMovementKind(kind)
    setMovementQuantity("")
    setMovementReason("")
    mutation.reset()
    setMovementOpen(true)
  }

  async function saveMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!movementProduct) return
    const quantity = parseQuantity(movementQuantity)
    if (quantity === null || quantity <= 0) {
      mutation.fail("Saisissez une quantité supérieure à zéro.")
      return
    }
    const outcome = await mutation.run({
      url: "/api/v1/stock-movements",
      method: "POST",
      // Une double soumission ne doit pas sortir deux fois le produit.
      headers: { "Idempotency-Key": createIdempotencyKey() },
      body: {
        product_id: movementProduct.id,
        kind: movementKind,
        quantity_milli: quantity,
        reason: movementReason.trim() || null,
      },
      success: movementKind === "entry" ? "Entrée enregistrée." : "Sortie enregistrée.",
      failure: "Impossible d’enregistrer le mouvement.",
      busyKey: MOVEMENT_KEY,
    })
    if (!outcome.ok) return
    setMovementOpen(false)
    setRefreshKey((key) => key + 1)
  }

  // ---------------------------------------------------------- inventaire --
  const [inventoryOpen, setInventoryOpen] = useState(false)
  const [inventoryProduct, setInventoryProduct] = useState<Product | null>(null)
  const [counted, setCounted] = useState("")
  const [inventoryReason, setInventoryReason] = useState("")

  function openInventory(product: Product) {
    setInventoryProduct(product)
    setCounted("")
    setInventoryReason("")
    mutation.reset()
    setInventoryOpen(true)
  }

  // Écart prévisionnel affiché pendant la saisie. Volontairement sans
  // animation : on n'anime pas un nombre que quelqu'un est en train de
  // compter.
  const inventoryDelta = useMemo(() => {
    if (!inventoryProduct || counted.trim() === "") return null
    const value = parseQuantity(counted)
    if (value === null) return null
    return value - inventoryProduct.stock_milli
  }, [counted, inventoryProduct])

  async function saveInventory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!inventoryProduct) return
    const value = parseQuantity(counted)
    if (value === null || value < 0) {
      mutation.fail("Saisissez la quantité comptée.")
      return
    }
    const outcome = await mutation.run({
      url: `/api/v1/products/${encodeURIComponent(inventoryProduct.id)}/inventory`,
      method: "POST",
      body: { counted_milli: value, reason: inventoryReason.trim() || null },
      success: "Inventaire enregistré.",
      failure: "Impossible d’enregistrer l’inventaire.",
      busyKey: INVENTORY_KEY,
    })
    if (!outcome.ok) return
    setInventoryOpen(false)
    setRefreshKey((key) => key + 1)
  }

  // Le rôle est évalué avant le forfait : un caissier reçoit un refus de
  // droit, jamais une invitation à payer pour une page qui ne le concerne pas.
  if (readStock.loading === false && readStock.allowed === false) {
    return (
      <BaseLayout title="Stock" description="Produits, mouvements et seuils d’alerte.">
        <div className="p-4">
          <BlockedReason reason={readStock.reason ?? "Vous n’avez pas accès au stock."} />
        </div>
      </BaseLayout>
    )
  }

  if (planStock.loading === false && planStock.allowed === false) {
    return (
      <BaseLayout title="Stock" description="Produits, mouvements et seuils d’alerte.">
        <div className="p-4">
          <PlanGate
            permission="stock:read"
            capability="stock.manage"
            title="Suivi du stock"
            pitch="Comptez vos sachets d’Omo, vos bidons et vos chiffons, voyez ce qu’un lavage consomme réellement, et sachez quoi racheter avant la rupture."
          >
            <span />
          </PlanGate>
        </div>
      </BaseLayout>
    )
  }

  return (
    <BaseLayout title="Stock" description="Produits, mouvements et seuils d’alerte.">
      <div className="space-y-6 p-4">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Le stock n’est jamais saisi directement : il est toujours la somme des mouvements enregistrés.
            Pour corriger un écart, enregistrez un inventaire — la différence constatée reste visible dans l’historique.
          </p>
          <div className="flex flex-col items-start gap-1.5">
            <Button onClick={openCreateProduct} disabled={productForm.disabled} aria-busy={productForm.busy} title={productForm.reason ?? undefined}>
              <Plus className="mr-2 size-4" />
              Nouveau produit
            </Button>
            <BlockedReason reason={productForm.reason} className="max-w-72" />
          </div>
        </div>

        {mutation.success && (
          <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
            {mutation.success}
          </p>
        )}
        {mutation.error && !productOpen && !movementOpen && !inventoryOpen && (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {mutation.error}
          </p>
        )}

        {negatifs.length > 0 && (
          <div role="status" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {negatifs.length === 1
                ? `Le stock de ${negatifs[0].name} est négatif : il a été consommé plus que ce qui était déclaré. Comptez-le et enregistrez un inventaire.`
                : `${negatifs.length} produits ont un stock négatif : ${negatifs.map((p) => p.name).join(", ")}. Comptez-les et enregistrez un inventaire.`}
            </span>
          </div>
        )}

        {lowStock.length > 0 && (
          <div role="status" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              {lowStock.length === 1
                ? `1 produit est à réapprovisionner : ${lowStock[0].name}.`
                : `${lowStock.length} produits sont à réapprovisionner : ${lowStock.map((p) => p.name).join(", ")}.`}
            </span>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Produits</CardTitle>
            <CardDescription>
              {products.length} produit{products.length === 1 ? "" : "s"} · valeur totale estimée {formatXOF(totalValue)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
            <BlockedReason reason={movementGate.reason} />
            {loading && <div className="mb-3"><TableSkeleton rows={4} cols={5} label="Synchronisation du stock" /></div>}
            {!loading && !error && (
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Produit</TableHead>
                      <TableHead>Stock</TableHead>
                      <TableHead>Coût unitaire</TableHead>
                      <TableHead>Valeur</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {products.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                          Aucun produit enregistré. Commencez par déclarer vos consommables.
                        </TableCell>
                      </TableRow>
                    )}
                    {products.map((product, index) => (
                      <TableRow key={product.id} className="row-in" style={{ "--row": Math.min(index, 10) } as React.CSSProperties}>
                        <TableCell>
                          <div className="font-medium">{product.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {product.category_name ?? "Sans catégorie"}
                            {!product.is_active && " · archivé"}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className={product.stock_milli < 0 ? "font-medium text-destructive" : "font-medium"}>{formatQuantity(product.stock_milli, product.unit)}</span>
                            {product.stock_milli < 0
                              ? <Badge variant="outline" className="border-destructive text-destructive">À inventorier</Badge>
                              : product.low_stock && <Badge variant="outline" className="border-amber-400 text-amber-700 dark:text-amber-300">Seuil atteint</Badge>}
                          </div>
                          {product.low_stock_threshold_milli > 0 && (
                            <div className="text-xs text-muted-foreground">
                              Seuil : {formatQuantity(product.low_stock_threshold_milli, product.unit)}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {formatXOF(product.unit_cost_cents)}
                          <div className="text-xs text-muted-foreground">
                            {product.unit_cost_updated_at
                              ? `Prix payé le ${new Date(product.unit_cost_updated_at).toLocaleDateString("fr-CI")}`
                              : "Saisi à la main"}
                          </div>
                        </TableCell>
                        <TableCell>{formatXOF(stockValueCents(product.stock_milli, product.unit_cost_cents))}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap justify-end gap-1">
                            <Button variant="ghost" size="icon" disabled={movementGate.disabled || !product.is_active} title={movementGate.reason ?? "Entrée"} aria-label={`Enregistrer une entrée pour ${product.name}`} onClick={() => openMovement(product, "entry")}>
                              <ArrowDownLeft className="size-4" />
                            </Button>
                            <Button variant="ghost" size="icon" disabled={movementGate.disabled || !product.is_active} title={movementGate.reason ?? "Sortie"} aria-label={`Enregistrer une sortie pour ${product.name}`} onClick={() => openMovement(product, "exit")}>
                              <ArrowUpRight className="size-4" />
                            </Button>
                            <Button variant="ghost" size="icon" disabled={movementGate.disabled} title={movementGate.reason ?? "Inventaire"} aria-label={`Inventorier ${product.name}`} onClick={() => openInventory(product)}>
                              <ClipboardList className="size-4" />
                            </Button>
                            <Button variant="ghost" size="sm" disabled={productForm.disabled} title={productForm.reason ?? undefined} onClick={() => openEditProduct(product)}>
                              Modifier
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Derniers mouvements</CardTitle>
            <CardDescription>Chaque ligne est définitive : un mouvement se contrepasse, il ne s’efface pas.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Produit</TableHead>
                    <TableHead>Nature</TableHead>
                    <TableHead>Quantité</TableHead>
                    <TableHead>Motif</TableHead>
                    <TableHead>Par</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movements.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                        Aucun mouvement enregistré pour l’instant.
                      </TableCell>
                    </TableRow>
                  )}
                  {movements.map((movement) => (
                    <TableRow key={movement.id}>
                      <TableCell className="whitespace-nowrap text-sm">
                        {new Date(movement.created_at).toLocaleDateString("fr-CI")}
                      </TableCell>
                      <TableCell className="text-sm">{movement.product_name}</TableCell>
                      <TableCell><Badge variant="secondary">{KIND_LABELS[movement.kind] ?? movement.kind}</Badge></TableCell>
                      <TableCell className={movement.quantity_milli < 0 ? "text-destructive" : "text-emerald-700 dark:text-emerald-400"}>
                        {movement.quantity_milli > 0 ? "+" : "−"}
                        {formatQuantity(Math.abs(movement.quantity_milli), movement.unit)}
                      </TableCell>
                      <TableCell className="max-w-64 truncate text-sm text-muted-foreground">
                        {movement.purchase_id && movement.purchase_reference ? (
                          <Link
                            to="/achats"
                            className="underline underline-offset-2 hover:text-foreground"
                          >
                            {movement.kind === "reversal" ? "Achat annulé" : "Achat"} {movement.purchase_reference}
                          </Link>
                        ) : movement.wash_id && movement.wash_reference ? (
                          <Link
                            to={`/washes/${movement.wash_id}`}
                            className="underline underline-offset-2 hover:text-foreground"
                          >
                            {movement.kind === "reversal" ? "Lavage annulé" : "Lavage"} {movement.wash_reference}
                          </Link>
                        ) : (
                          (movement.reason ?? "—")
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {movement.wash_id || movement.purchase_id ? (
                          // Déduction automatique : la personne reste dans la
                          // donnée — c'est elle la cause, la traçabilité en
                          // dépend — mais l'écran ne doit pas présenter un
                          // mouvement déclenché par le système comme un geste
                          // délibéré de sa part.
                          <span
                            title={
                              movement.first_name
                                ? `Déclenché en enregistrant ${movement.purchase_id ? "l’achat" : "le lavage"} par ${`${movement.first_name} ${movement.last_name ?? ""}`.trim()}`
                                : `Déclenché par l’enregistrement ${movement.purchase_id ? "de l’achat" : "du lavage"}`
                            }
                          >
                            Système
                          </span>
                        ) : movement.first_name ? (
                          `${movement.first_name} ${movement.last_name ?? ""}`.trim()
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ------------------------------------------------------- produit -- */}
      <Dialog open={productOpen} onOpenChange={(open) => { if (open) setProductOpen(true); else if (!savingProduct) { setProductOpen(false); mutation.reset() } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? "Modifier le produit" : "Nouveau produit"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "L’unité ne se modifie pas : elle engagerait tous les mouvements déjà enregistrés."
                : "La quantité initiale sera enregistrée comme un mouvement daté, pas comme une valeur sortie de nulle part."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveProduct} className="space-y-4">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Nom du produit
              <Input required autoFocus maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. Shampooing carrosserie" />
            </label>
            <div className="flex flex-col gap-1.5 text-sm font-medium">
              Catégorie
              {newCategoryOpen ? (
                <div className="flex gap-2">
                  <Input
                    autoFocus
                    maxLength={120}
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                    placeholder="Ex. Produits de lavage"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        void saveCategory()
                      }
                    }}
                  />
                  <Button type="button" variant="secondary" onClick={() => void saveCategory()} disabled={savingCategory} aria-busy={savingCategory}>
                    {savingCategory ? "…" : "Créer"}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => { setNewCategoryOpen(false); setNewCategoryName("") }} disabled={savingCategory}>
                    Annuler
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <select
                    className="h-9 flex-1 rounded-md border border-input bg-transparent px-3 text-sm"
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                  >
                    <option value="">Sans catégorie</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>{category.name}</option>
                    ))}
                  </select>
                  <Button type="button" variant="outline" onClick={() => setNewCategoryOpen(true)}>
                    Nouvelle
                  </Button>
                </div>
              )}
              <span className="text-xs font-normal text-muted-foreground">
                Sert à regrouper le stock dans les listes. Sans effet sur les quantités ni sur les prix.
              </span>
            </div>
            {!editing && (
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Unité de mesure
                <select className="h-9 rounded-md border border-input bg-transparent px-3 text-sm" value={unit} onChange={(e) => setUnit(e.target.value)}>
                  {UNIT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Coût unitaire (XOF)
              <Input inputMode="decimal" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder="Ex. 1200" />
              <span className="text-xs font-normal text-muted-foreground">
                Le coût est figé sur chaque mouvement : le modifier ne réécrit pas les sorties passées.
              </span>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Seuil d’alerte
              <Input inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="Laisser vide pour aucune alerte" />
            </label>
            {!editing && (
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                Quantité en stock aujourd’hui
                <Input inputMode="decimal" value={initialQuantity} onChange={(e) => setInitialQuantity(e.target.value)} placeholder="Ex. 20" />
              </label>
            )}
            {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setProductOpen(false); mutation.reset() }} disabled={savingProduct}>Annuler</Button>
              <Button type="submit" disabled={savingProduct || !name.trim()}>
                {savingProduct && <RefreshCw className="mr-2 size-4 animate-spin" />}
                {editing ? "Enregistrer" : "Créer le produit"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ----------------------------------------------------- mouvement -- */}
      <Dialog open={movementOpen} onOpenChange={(open) => { if (open) setMovementOpen(true); else if (!savingMovement) { setMovementOpen(false); mutation.reset() } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{movementKind === "entry" ? "Entrée de stock" : "Sortie de stock"}</DialogTitle>
            <DialogDescription>
              {movementProduct && `${movementProduct.name} · stock actuel ${formatQuantity(movementProduct.stock_milli, movementProduct.unit)}`}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveMovement} className="space-y-4">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Quantité
              <Input required autoFocus inputMode="decimal" value={movementQuantity} onChange={(e) => setMovementQuantity(e.target.value)} placeholder="Ex. 2,5" />
              <span className="text-xs font-normal text-muted-foreground">
                Saisissez une quantité positive — c’est la nature du mouvement qui décide du sens.
              </span>
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Motif
              <Input maxLength={500} value={movementReason} onChange={(e) => setMovementReason(e.target.value)} placeholder={movementKind === "entry" ? "Ex. Réception fournisseur" : "Ex. Casse, perte, consommation"} />
            </label>
            {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setMovementOpen(false); mutation.reset() }} disabled={savingMovement}>Annuler</Button>
              <Button type="submit" disabled={savingMovement || !movementQuantity.trim()}>
                {savingMovement && <RefreshCw className="mr-2 size-4 animate-spin" />}
                Enregistrer
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------------------------------------------------- inventaire -- */}
      <Dialog open={inventoryOpen} onOpenChange={(open) => { if (open) setInventoryOpen(true); else if (!savingInventory) { setInventoryOpen(false); mutation.reset() } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Inventaire physique</DialogTitle>
            <DialogDescription>
              {inventoryProduct && `${inventoryProduct.name} · stock théorique ${formatQuantity(inventoryProduct.stock_milli, inventoryProduct.unit)}`}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveInventory} className="space-y-4">
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Quantité réellement comptée
              <Input required autoFocus inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} placeholder="Ex. 18" />
            </label>
            {inventoryDelta !== null && inventoryProduct && (
              <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                {inventoryDelta === 0
                  ? "Le comptage confirme le stock théorique : aucun mouvement ne sera enregistré."
                  : `Écart constaté : ${inventoryDelta > 0 ? "+" : "−"}${formatQuantity(Math.abs(inventoryDelta), inventoryProduct.unit)}.`}
              </p>
            )}
            <label className="flex flex-col gap-1.5 text-sm font-medium">
              Motif
              <Input maxLength={500} value={inventoryReason} onChange={(e) => setInventoryReason(e.target.value)} placeholder="Ex. Comptage mensuel" />
            </label>
            {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setInventoryOpen(false); mutation.reset() }} disabled={savingInventory}>Annuler</Button>
              <Button type="submit" disabled={savingInventory || !counted.trim()}>
                {savingInventory && <RefreshCw className="mr-2 size-4 animate-spin" />}
                Enregistrer l’inventaire
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </BaseLayout>
  )
}
