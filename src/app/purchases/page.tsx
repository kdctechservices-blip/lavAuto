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
import { createIdempotencyKey } from "@/lib/idempotency"
import { parseQuantity } from "@/lib/quantity"
import { Plus, Trash2, Truck, X } from "lucide-react"

interface Product {
  id: string
  name: string
  unit: string
  unit_cost_cents: number
  is_active: boolean
}

interface Supplier {
  id: string
  name: string
  phone: string | null
  contact_name: string | null
  is_active: boolean
}

interface Purchase {
  id: string
  reference: string
  invoice_reference: string | null
  purchase_date: string
  total_cents: number
  payment_method: string
  status: string
  cancellation_reason: string | null
  supplier_name: string | null
  line_count: number
  first_name: string | null
  last_name: string | null
}

interface CurrentCashSession {
  id: string
  status: string
}

const PAYMENT_LABELS: Record<string, string> = {
  cash: "Espèces",
  orange_money: "Orange Money",
  mtn_momo: "MTN MoMo",
  moov_money: "Moov Money",
  wave: "Wave",
  other: "Autre",
}

const PURCHASE_KEY = "purchase"
const SUPPLIER_KEY = "supplier"
const CANCEL_KEY = "cancel"

function formatXof(cents: number): string {
  return `${(cents / 100).toLocaleString("fr-CI", { maximumFractionDigits: 2 })} XOF`
}

/**
 * Montant d'une ligne, en centimes.
 *
 * Même arithmétique que le serveur, à la division près qu'il faut faire ici
 * aussi : les quantités sont en millièmes, les coûts en centimes par unité.
 * Ce total n'est qu'un aperçu — c'est le serveur qui fait foi.
 */
function ligneTotalCents(recuMilli: number, prixCents: number): number {
  return Math.round((recuMilli * prixCents) / 1000)
}

interface LigneSaisie {
  cle: number
  product_id: string
  recu: string
  prix: string
}

let compteurLigne = 0
function nouvelleLigne(): LigneSaisie {
  compteurLigne += 1
  return { cle: compteurLigne, product_id: "", recu: "", prix: "" }
}

export default function PurchasesPage() {
  const managePurchase = useAccess("purchase:manage")
  const manageSupplier = useAccess("supplier:manage")
  // Les achats alimentent le stock : ils relèvent de la même promesse
  // commerciale, et donc de la même capacité. Une clé de plus ne vendrait
  // rien de neuf et doublerait les chemins à garder cohérents.
  const planStock = useCapability("stock.manage")

  const achatGate = actionGate({
    loading: managePurchase.loading,
    allowed: managePurchase.allowed,
    reason: managePurchase.reason,
  })
  const fournisseurGate = actionGate({
    loading: manageSupplier.loading,
    allowed: manageSupplier.allowed,
    reason: manageSupplier.reason,
  })

  const [refreshKey, setRefreshKey] = useState(0)
  const { data, loading, error } = useApi<Purchase[]>(`/api/v1/purchases?refresh=${refreshKey}`)
  const { data: supplierData } = useApi<Supplier[]>(`/api/v1/suppliers?refresh=${refreshKey}`)
  const { data: productData } = useApi<Product[]>(`/api/v1/products?refresh=${refreshKey}`)
  const { data: cashSession } = useApi<CurrentCashSession | null>(`/api/v1/cash-sessions/current?refresh=${refreshKey}`)

  const purchases = useMemo(() => data ?? [], [data])
  const suppliers = useMemo(() => supplierData ?? [], [supplierData])
  const products = useMemo(() => (productData ?? []).filter((p) => p.is_active), [productData])

  const moisEnCours = useMemo(() => {
    const debut = new Date()
    debut.setDate(1)
    const cle = debut.toISOString().slice(0, 7)
    return purchases
      .filter((p) => p.status !== "cancelled" && p.purchase_date.slice(0, 7) === cle)
      .reduce((sum, p) => sum + p.total_cents, 0)
  }, [purchases])

  const mutation = useMutation()
  const savingPurchase = mutation.busyKey === PURCHASE_KEY
  const savingSupplier = mutation.busyKey === SUPPLIER_KEY
  const savingCancel = mutation.busyKey === CANCEL_KEY

  // ------------------------------------------------------------- achat --
  const [achatOpen, setAchatOpen] = useState(false)
  const [supplierId, setSupplierId] = useState("")
  const [paiement, setPaiement] = useState("cash")
  const [facture, setFacture] = useState("")
  const [lignes, setLignes] = useState<LigneSaisie[]>([nouvelleLigne()])

  function ouvrirAchat() {
    setSupplierId("")
    setPaiement("cash")
    setFacture("")
    setLignes([nouvelleLigne()])
    setAchatOpen(true)
  }

  function majLigne(cle: number, champ: keyof LigneSaisie, valeur: string) {
    setLignes((actuelles) =>
      actuelles.map((ligne) => {
        if (ligne.cle !== cle) return ligne
        const suivante = { ...ligne, [champ]: valeur }
        // Choisir un produit pré-remplit son dernier coût connu : on ne
        // retape pas un prix qui n'a pas bougé. Il reste modifiable, parce
        // que c'est le prix payé ce jour-là qui compte, pas le prix de fiche.
        if (champ === "product_id" && ligne.prix.trim() === "") {
          const produit = products.find((p) => p.id === valeur)
          if (produit) suivante.prix = String(produit.unit_cost_cents / 100)
        }
        return suivante
      }),
    )
  }

  const totalSaisi = useMemo(
    () =>
      lignes.reduce((sum, ligne) => {
        const recu = parseQuantity(ligne.recu)
        const prix = Math.round(Number(ligne.prix.replace(",", ".") || "0") * 100)
        if (recu === null || recu <= 0 || !Number.isFinite(prix) || prix < 0) return sum
        return sum + ligneTotalCents(recu, prix)
      }, 0),
    [lignes],
  )

  async function saveAchat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const items: { product_id: string; received_milli: number; unit_cost_cents: number }[] = []
    for (const ligne of lignes) {
      if (!ligne.product_id && ligne.recu.trim() === "" && ligne.prix.trim() === "") continue
      if (!ligne.product_id) {
        mutation.fail("Choisissez un produit sur chaque ligne.")
        return
      }
      const recu = parseQuantity(ligne.recu)
      if (recu === null || recu <= 0) {
        mutation.fail("Indiquez, pour chaque ligne, la quantité réellement reçue.")
        return
      }
      const prix = Math.round(Number(ligne.prix.replace(",", ".") || "0") * 100)
      if (!Number.isFinite(prix) || prix < 0) {
        mutation.fail("Le prix unitaire doit être un montant positif.")
        return
      }
      items.push({ product_id: ligne.product_id, received_milli: recu, unit_cost_cents: prix })
    }

    if (items.length === 0) {
      mutation.fail("Ajoutez au moins un produit à cet achat.")
      return
    }
    if (paiement === "cash" && !cashSession?.id) {
      mutation.fail("Ouvrez la caisse avant d’enregistrer un achat réglé en espèces.")
      return
    }

    const outcome = await mutation.run({
      url: "/api/v1/purchases",
      method: "POST",
      // Un double clic ne doit pas faire entrer la marchandise deux fois,
      // ni sortir l'argent deux fois.
      headers: { "Idempotency-Key": createIdempotencyKey() },
      body: {
        supplier_id: supplierId || null,
        payment_method: paiement,
        ...(paiement === "cash" && cashSession?.id ? { cash_session_id: cashSession.id } : {}),
        ...(facture.trim() ? { invoice_reference: facture.trim() } : {}),
        items,
      },
      success: "Achat enregistré. Le stock et la dépense sont à jour.",
      failure: "Impossible d’enregistrer cet achat.",
      busyKey: PURCHASE_KEY,
    })
    if (!outcome.ok) return
    setAchatOpen(false)
    setRefreshKey((key) => key + 1)
  }

  // ------------------------------------------------------- fournisseur --
  const [fournisseurOpen, setFournisseurOpen] = useState(false)
  const [nomFournisseur, setNomFournisseur] = useState("")
  const [telFournisseur, setTelFournisseur] = useState("")
  const [contactFournisseur, setContactFournisseur] = useState("")

  function ouvrirFournisseur() {
    setNomFournisseur("")
    setTelFournisseur("")
    setContactFournisseur("")
    setFournisseurOpen(true)
  }

  async function saveFournisseur(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nom = nomFournisseur.trim()
    if (nom.length < 2) {
      mutation.fail("Donnez un nom au fournisseur.")
      return
    }
    const outcome = await mutation.run({
      url: "/api/v1/suppliers",
      method: "POST",
      body: {
        name: nom,
        ...(telFournisseur.trim() ? { phone: telFournisseur.trim() } : {}),
        ...(contactFournisseur.trim() ? { contact_name: contactFournisseur.trim() } : {}),
      },
      success: "Fournisseur enregistré.",
      failure: "Impossible d’enregistrer ce fournisseur.",
      busyKey: SUPPLIER_KEY,
    })
    if (!outcome.ok) return
    setFournisseurOpen(false)
    setRefreshKey((key) => key + 1)
  }

  // ---------------------------------------------------------- annuler --
  const [annulOpen, setAnnulOpen] = useState(false)
  const [aAnnuler, setAAnnuler] = useState<Purchase | null>(null)
  const [motif, setMotif] = useState("")

  function ouvrirAnnulation(purchase: Purchase) {
    setAAnnuler(purchase)
    setMotif("")
    setAnnulOpen(true)
  }

  async function saveAnnulation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!aAnnuler) return
    if (motif.trim().length < 3) {
      mutation.fail("Dites pourquoi cet achat est annulé.")
      return
    }
    const outcome = await mutation.run({
      url: `/api/v1/purchases/${encodeURIComponent(aAnnuler.id)}/cancel`,
      method: "POST",
      body: { reason: motif.trim() },
      success: "Achat annulé. La marchandise est reprise et la dépense ne compte plus.",
      failure: "Impossible d’annuler cet achat.",
      busyKey: CANCEL_KEY,
    })
    if (!outcome.ok) return
    setAnnulOpen(false)
    setRefreshKey((key) => key + 1)
  }

  // Le rôle est évalué avant le forfait : un caissier reçoit un refus de
  // droit, jamais une invitation à payer pour une page qui ne le concerne pas.
  if (managePurchase.loading === false && managePurchase.allowed === false) {
    return (
      <BaseLayout title="Achats" description="Ce que vous achetez, ce qui entre en stock.">
        <div className="p-4">
          <BlockedReason reason={managePurchase.reason ?? "Vous n’avez pas accès aux achats."} />
        </div>
      </BaseLayout>
    )
  }

  if (planStock.loading === false && planStock.allowed === false) {
    return (
      <BaseLayout title="Achats" description="Ce que vous achetez, ce qui entre en stock.">
        <div className="p-4">
          <PlanGate
            permission="purchase:manage"
            capability="stock.manage"
            title="Fournisseurs et achats"
            pitch="Enregistrez ce que vous ramenez du marché : la marchandise entre en stock et la dépense est écrite une seule fois, sans double saisie."
          >
            <span />
          </PlanGate>
        </div>
      </BaseLayout>
    )
  }

  return (
    <BaseLayout title="Achats" description="Ce que vous achetez, ce qui entre en stock.">
      <div className="space-y-6 p-4">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <p className="max-w-2xl text-sm text-muted-foreground">
            Enregistrez ce que vous avez <strong>réellement rapporté</strong>. La marchandise entre en stock et la
            dépense est écrite automatiquement : ne la ressaisissez pas dans l’écran Dépenses, elle y figure déjà.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={ouvrirFournisseur}
              disabled={fournisseurGate.disabled}
              title={fournisseurGate.reason ?? undefined}
            >
              <Truck className="mr-2 size-4" /> Nouveau fournisseur
            </Button>
            <Button onClick={ouvrirAchat} disabled={achatGate.disabled} title={achatGate.reason ?? undefined}>
              <Plus className="mr-2 size-4" /> Nouvel achat
            </Button>
          </div>
        </div>

        {achatGate.denied && achatGate.reason && <BlockedReason reason={achatGate.reason} />}

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Achats du mois</CardDescription>
              <CardTitle className="text-2xl">{formatXof(moisEnCours)}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">Achats annulés exclus.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Fournisseurs</CardDescription>
              <CardTitle className="text-2xl">{suppliers.filter((s) => s.is_active).length}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {suppliers.length === 0 ? "Aucun fournisseur enregistré — ce n’est pas obligatoire." : "Enregistrés et actifs."}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Caisse</CardDescription>
              <CardTitle className="text-2xl">{cashSession?.id ? "Ouverte" : "Fermée"}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                {cashSession?.id
                  ? "Un achat en espèces sortira du tiroir."
                  : "Ouvrez la caisse pour payer un achat en espèces."}
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Derniers achats</CardTitle>
            <CardDescription>
              Un achat ne se modifie pas et ne s’efface pas. En cas d’erreur, il s’annule : la marchandise est reprise
              et la dépense cesse de compter, sans que rien ne disparaisse de l’historique.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <TableSkeleton rows={5} cols={7} label="Chargement des achats" />
            ) : error ? (
              <BlockedReason reason="Les achats n’ont pas pu être chargés." />
            ) : purchases.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Aucun achat enregistré. Le premier approvisionnement fera monter votre stock.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Référence</TableHead>
                      <TableHead>Fournisseur</TableHead>
                      <TableHead className="text-right">Lignes</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead>Réglé par</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {purchases.map((purchase) => (
                      <TableRow key={purchase.id} className={purchase.status === "cancelled" ? "opacity-60" : undefined}>
                        <TableCell className="text-sm">
                          {new Date(purchase.purchase_date).toLocaleDateString("fr-CI")}
                        </TableCell>
                        <TableCell className="font-medium">
                          {purchase.reference}
                          {purchase.invoice_reference && (
                            <span className="block text-xs text-muted-foreground">
                              Facture {purchase.invoice_reference}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {purchase.supplier_name ?? "Non précisé"}
                        </TableCell>
                        <TableCell className="text-right text-sm">{purchase.line_count}</TableCell>
                        <TableCell className="text-right font-medium">{formatXof(purchase.total_cents)}</TableCell>
                        <TableCell className="text-sm">
                          {PAYMENT_LABELS[purchase.payment_method] ?? purchase.payment_method}
                        </TableCell>
                        <TableCell className="text-right">
                          {purchase.status === "cancelled" ? (
                            <Badge variant="outline" title={purchase.cancellation_reason ?? undefined}>
                              Annulé
                            </Badge>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => ouvrirAnnulation(purchase)}
                              disabled={achatGate.disabled}
                              title={achatGate.reason ?? "Annuler cet achat"}
                            >
                              <X className="size-4" />
                              <span className="sr-only">Annuler l’achat {purchase.reference}</span>
                            </Button>
                          )}
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
            <CardTitle>Fournisseurs</CardTitle>
            <CardDescription>
              Facultatif. On peut acheter trois sachets à la boutique du coin sans créer de fiche.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {suppliers.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Aucun fournisseur enregistré.</p>
            ) : (
              <ul className="divide-y">
                {suppliers.map((supplier) => (
                  <li key={supplier.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="font-medium">
                      {supplier.name}
                      {!supplier.is_active && <span className="ml-2 text-xs text-muted-foreground">(archivé)</span>}
                    </span>
                    <span className="text-muted-foreground">
                      {[supplier.contact_name, supplier.phone].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <p className="text-sm text-muted-foreground">
          Les entrées correspondantes sont visibles dans{" "}
          <Link to="/stock" className="underline underline-offset-2">
            le stock
          </Link>
          , rattachées à leur achat.
        </p>
      </div>

      {/* ------------------------------------------------------- achat -- */}
      <Dialog open={achatOpen} onOpenChange={setAchatOpen}>
        <DialogContent className="sm:max-w-3xl">
          <form onSubmit={saveAchat}>
            <DialogHeader>
              <DialogTitle>Nouvel achat</DialogTitle>
              <DialogDescription>
                Comptez ce qu’il y a dans le sac, pas ce qui est écrit sur le bon. Seule la quantité reçue entre en
                stock.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 py-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="grid gap-1.5 text-sm">
                  <span>Fournisseur</span>
                  <select
                    className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                  >
                    <option value="">Non précisé</option>
                    {suppliers
                      .filter((s) => s.is_active)
                      .map((supplier) => (
                        <option key={supplier.id} value={supplier.id}>
                          {supplier.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span>Réglé par</span>
                  <select
                    className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                    value={paiement}
                    onChange={(e) => setPaiement(e.target.value)}
                  >
                    {Object.entries(PAYMENT_LABELS).map(([valeur, libelle]) => (
                      <option key={valeur} value={valeur}>
                        {libelle}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span>Numéro de facture</span>
                  <Input value={facture} onChange={(e) => setFacture(e.target.value)} placeholder="Facultatif" />
                </label>
              </div>

              {paiement === "cash" && !cashSession?.id && (
                <BlockedReason reason="La caisse est fermée. Ouvrez-la pour enregistrer un achat réglé en espèces, ou choisissez un autre moyen de paiement." />
              )}

              <div className="space-y-2">
                {lignes.map((ligne) => {
                  const produit = products.find((p) => p.id === ligne.product_id)
                  const recu = parseQuantity(ligne.recu)
                  const prix = Math.round(Number(ligne.prix.replace(",", ".") || "0") * 100)
                  const sousTotal =
                    recu !== null && recu > 0 && Number.isFinite(prix) && prix >= 0 ? ligneTotalCents(recu, prix) : 0
                  return (
                    <div key={ligne.cle} className="grid items-end gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
                      <label className="grid gap-1.5 text-sm">
                        <span className="sm:sr-only">Produit</span>
                        <select
                          className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                          value={ligne.product_id}
                          onChange={(e) => majLigne(ligne.cle, "product_id", e.target.value)}
                        >
                          <option value="">Choisir un produit…</option>
                          {products.map((product) => (
                            <option key={product.id} value={product.id}>
                              {product.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="grid gap-1.5 text-sm">
                        <span className="sm:sr-only">Quantité reçue</span>
                        <Input
                          value={ligne.recu}
                          onChange={(e) => majLigne(ligne.cle, "recu", e.target.value)}
                          placeholder={produit ? `Reçu (${produit.unit})` : "Quantité reçue"}
                          inputMode="decimal"
                        />
                      </label>
                      <label className="grid gap-1.5 text-sm">
                        <span className="sm:sr-only">Prix unitaire</span>
                        <Input
                          value={ligne.prix}
                          onChange={(e) => majLigne(ligne.cle, "prix", e.target.value)}
                          placeholder="Prix unitaire"
                          inputMode="decimal"
                        />
                      </label>
                      <div className="flex items-center gap-2">
                        <span className="min-w-24 text-right text-sm tabular-nums text-muted-foreground">
                          {sousTotal > 0 ? formatXof(sousTotal) : "—"}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => setLignes((l) => (l.length === 1 ? [nouvelleLigne()] : l.filter((x) => x.cle !== ligne.cle)))}
                        >
                          <Trash2 className="size-4" />
                          <span className="sr-only">Retirer cette ligne</span>
                        </Button>
                      </div>
                    </div>
                  )
                })}
                <Button type="button" variant="outline" size="sm" onClick={() => setLignes((l) => [...l, nouvelleLigne()])}>
                  <Plus className="mr-2 size-4" /> Ajouter une ligne
                </Button>
              </div>

              <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2">
                <span className="text-sm text-muted-foreground">Total de l’achat</span>
                {/* Pas d'animation sur ce montant : on compte de l'argent. */}
                <span className="text-lg font-bold tabular-nums">{formatXof(totalSaisi)}</span>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAchatOpen(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={savingPurchase || achatGate.disabled} aria-busy={savingPurchase}>
                {savingPurchase ? "Enregistrement…" : "Enregistrer l’achat"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------- fournisseur -- */}
      <Dialog open={fournisseurOpen} onOpenChange={setFournisseurOpen}>
        <DialogContent>
          <form onSubmit={saveFournisseur}>
            <DialogHeader>
              <DialogTitle>Nouveau fournisseur</DialogTitle>
              <DialogDescription>Le nom suffit. Le reste aide à le rappeler quand il faut recommander.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <label className="grid gap-1.5 text-sm">
                <span>Nom</span>
                <Input value={nomFournisseur} onChange={(e) => setNomFournisseur(e.target.value)} placeholder="Grossiste Adjamé" />
              </label>
              <label className="grid gap-1.5 text-sm">
                <span>Téléphone</span>
                <Input value={telFournisseur} onChange={(e) => setTelFournisseur(e.target.value)} placeholder="Facultatif" />
              </label>
              <label className="grid gap-1.5 text-sm">
                <span>Personne à contacter</span>
                <Input value={contactFournisseur} onChange={(e) => setContactFournisseur(e.target.value)} placeholder="Facultatif" />
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFournisseurOpen(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={savingSupplier || fournisseurGate.disabled} aria-busy={savingSupplier}>
                {savingSupplier ? "Enregistrement…" : "Enregistrer"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ----------------------------------------------------- annuler -- */}
      <Dialog open={annulOpen} onOpenChange={setAnnulOpen}>
        <DialogContent>
          <form onSubmit={saveAnnulation}>
            <DialogHeader>
              <DialogTitle>Annuler l’achat {aAnnuler?.reference}</DialogTitle>
              <DialogDescription>
                La marchandise sera reprise du stock et la dépense cessera de compter. Rien n’est effacé : l’achat
                restera visible, marqué annulé.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <label className="grid gap-1.5 text-sm">
                <span>Motif</span>
                <Input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Saisi deux fois par erreur" />
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAnnulOpen(false)}>
                Revenir
              </Button>
              <Button type="submit" variant="destructive" disabled={savingCancel} aria-busy={savingCancel}>
                {savingCancel ? "Annulation…" : "Annuler l’achat"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </BaseLayout>
  )
}
