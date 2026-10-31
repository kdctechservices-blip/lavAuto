import type { LucideIcon } from "lucide-react"
import {
  Banknote,
  Building2,
  CircleDollarSign,
  CreditCard,
  Droplets,
  Package,
  ScrollText,
  Settings2,
  Smartphone,
  Tags,
  TrendingUp,
} from "lucide-react"

/**
 * Nomenclature des dépenses, partagée entre le formulaire « Nouvelle dépense »
 * et la page qui liste les dépenses : une seule source de libellés, une seule
 * source de couleurs.
 */

export type ExpenseCategory =
  | "supply"
  | "salary"
  | "maintenance"
  | "utilities"
  | "rent"
  | "tax"
  | "marketing"
  | "other"

export type ExpensePaymentMethod =
  | "cash"
  | "orange_money"
  | "mtn_momo"
  | "moov_money"
  | "wave"
  | "other"

export interface ExpenseCategoryOption {
  value: ExpenseCategory
  label: string
  icon: LucideIcon
}

export interface ExpensePaymentMethodOption {
  value: ExpensePaymentMethod
  label: string
  icon: LucideIcon
  /** Pastille de la tuile : code couleur reconnu en caisse (orange, MoMo…). */
  chip: string
}

export const EXPENSE_CATEGORIES: ExpenseCategoryOption[] = [
  { value: "supply", label: "Approvisionnement", icon: Package },
  { value: "salary", label: "Salaire", icon: CircleDollarSign },
  { value: "maintenance", label: "Maintenance", icon: Settings2 },
  { value: "utilities", label: "Factures (électricité, eau)", icon: Droplets },
  { value: "rent", label: "Loyer", icon: Building2 },
  { value: "tax", label: "Impôts & taxes", icon: ScrollText },
  { value: "marketing", label: "Marketing & publicité", icon: TrendingUp },
  { value: "other", label: "Autre", icon: Tags },
]

export const EXPENSE_PAYMENT_METHODS: ExpensePaymentMethodOption[] = [
  {
    value: "cash",
    label: "Espèces",
    icon: Banknote,
    chip: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  {
    value: "orange_money",
    label: "Orange Money",
    icon: Smartphone,
    chip: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  },
  {
    value: "mtn_momo",
    label: "MTN MoMo",
    icon: Smartphone,
    chip: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  {
    value: "moov_money",
    label: "Moov Money",
    icon: Smartphone,
    chip: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  {
    value: "wave",
    label: "Wave",
    icon: Smartphone,
    chip: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  },
  {
    value: "other",
    label: "Autre",
    icon: CreditCard,
    chip: "bg-muted text-muted-foreground",
  },
]

/** Une dépense telle que la renvoie l'API (création comme liste). */
export interface ExpenseRecord {
  id: string
  category: string
  amount_cents: number
  expense_date: string
  payment_method: string
  status: string
  site_id: string | null
  cash_session_id: string | null
  description: string | null
  beneficiary: string | null
  reference: string | null
  /** Renseigné quand la dépense a été écrite par un achat, jamais à la main. */
  purchase_id: string | null
  /** Renseigné quand la dépense provient d'une facture CIE/SODECI. */
  utility_reading_id: string | null
}
