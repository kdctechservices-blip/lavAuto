/**
 * Le reçu de lavage, format 80 mm.
 *
 * ## Ce que ce document est, et ce qu'il n'est pas
 *
 * C'est un **reçu de caisse commercial** : la preuve, remise au client, de ce
 * qu'il a commandé et de ce qu'il a payé. Il sert à lever une contestation au
 * comptoir et à justifier une entrée de caisse en interne.
 *
 * Ce n'est **pas** un Reçu Normalisé Électronique (RNE) au sens de la DGI
 * ivoirienne. Depuis décembre 2025 la facturation normalisée électronique
 * s'impose à toutes les entreprises quel que soit leur régime, et un RNE
 * valide porte trois marques que seule la plateforme de la DGI peut délivrer :
 * un QR code de certification, le visuel officiel FNE et un numéro fiscal
 * unique attribué en temps réel. Aucune de ces trois marques ne peut être
 * fabriquée ici.
 *
 * Conséquence directe sur le code : **rien dans ce reçu n'imite une mention
 * fiscale.** Pas de QR code, pas de « TVA », pas de numéro présenté comme
 * normalisé. Un document qui ressemblerait à un RNE sans en être un exposerait
 * la station à l'amende qu'elle croit éviter. Voir RECU-LAVAGE.md.
 *
 * ## Portée : le lavage, pas le versement
 *
 * Un lavage peut être réglé en plusieurs fois. Le reçu couvre le **lavage
 * entier** : toutes les prestations, tous les versements déjà reçus, et le
 * solde restant s'il y en a un. Il y a donc un reçu par lavage, et non un par
 * encaissement.
 *
 * ## Les copies
 *
 * Chaque émission est enregistrée. La première est l'original ; les suivantes
 * portent la mention DUPLICATA et leur numéro de copie. Deux papiers
 * indiscernables pour un seul versement permettraient de justifier deux fois
 * la même somme.
 */

import type { Pool } from "pg"
import { HttpError } from "./auth.ts"

/** Largeur utile d'un rouleau 80 mm en police A : 48 caractères. */
export const RECEIPT_WIDTH = 48

export interface ReceiptLineItem {
  service_name: string
  quantity: number
  unit_price_cents: number
  line_total_cents: number
}

export interface ReceiptPayment {
  method: string
  amount_cents: number
  status: string
  created_at: string
}

export interface Receipt {
  number: string
  issued_at: string
  copy_number: number
  duplicate: boolean
  station: { name: string; site: string; city: string; address: string | null; phone: string | null }
  wash: {
    reference: string
    created_at: string
    vehicle: string | null
    /** Plaque relevée au comptoir : c'est elle qui identifie le véhicule. */
    plate: string | null
    customer: string | null
  }
  cashier: string | null
  workers: string[]
  items: ReceiptLineItem[]
  total_cents: number
  payments: ReceiptPayment[]
  paid_cents: number
  remaining_cents: number
}

// ---------------------------------------------------------------------------
// Mise en forme (pure, donc testable au caractère près)
// ---------------------------------------------------------------------------

const METHOD_LABELS: Record<string, string> = {
  cash: "Espèces",
  orange_money: "Orange Money",
  mtn_momo: "MTN MoMo",
  moov_money: "Moov Money",
  wave: "Wave",
  card: "Carte",
  bank_transfer: "Virement",
  other: "Autre",
}

export function methodLabel(method: string): string {
  return METHOD_LABELS[method] ?? method
}

/**
 * Montant en francs, sans décimale.
 *
 * Le franc CFA n'a pas de subdivision en circulation : afficher « 2 500,00 »
 * sur un reçu de lavage ferait douter du montant plutôt que le préciser.
 * L'espace insécable fine évite qu'un retour à la ligne coupe « 2 500 » en
 * deux sur un rouleau étroit.
 */
export function formatAmount(cents: number): string {
  const francs = Math.round(cents / 100)
  return francs.toLocaleString("fr-FR").replace(/\u202f|\u00a0/g, " ")
}

/** Une ligne « libellé … montant » occupant exactement la largeur du rouleau. */
export function padLine(left: string, right: string, width = RECEIPT_WIDTH): string {
  const space = width - right.length
  if (space <= 1) return `${left} ${right}`.trim()
  const trimmed = left.length > space - 1 ? `${left.slice(0, space - 2)}…` : left
  return trimmed.padEnd(space, " ") + right
}

/** Texte centré sur la largeur du rouleau. */
export function centerLine(text: string, width = RECEIPT_WIDTH): string {
  if (text.length >= width) return text.slice(0, width)
  const left = Math.floor((width - text.length) / 2)
  return " ".repeat(left) + text
}

/** Coupe un libellé trop long en plusieurs lignes plutôt que de le tronquer. */
export function wrapText(text: string, width = RECEIPT_WIDTH): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return [""]
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    if (!current) {
      current = word.length > width ? word.slice(0, width) : word
      continue
    }
    if (current.length + 1 + word.length <= width) current += ` ${word}`
    else {
      lines.push(current)
      current = word.length > width ? word.slice(0, width) : word
    }
  }
  lines.push(current)
  return lines
}

function rule(char = "-", width = RECEIPT_WIDTH): string {
  return char.repeat(width)
}

function shortDateTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/**
 * Rendu texte du reçu, aligné sur 48 colonnes.
 *
 * Renvoyé par l'API en plus des données structurées : une station dont le
 * pilote d'imprimante n'accepte que du texte brut peut l'envoyer tel quel,
 * sans passer par le navigateur. C'est aussi ce rendu que les tests
 * vérifient, parce qu'un décalage de colonne se voit ici et se cache dans du
 * HTML.
 */
export function renderReceiptText(receipt: Receipt, width = RECEIPT_WIDTH): string {
  const lines: string[] = []

  lines.push(centerLine(receipt.station.name.toUpperCase(), width))
  lines.push(centerLine(receipt.station.site, width))
  if (receipt.station.address) {
    for (const l of wrapText(receipt.station.address, width)) lines.push(centerLine(l, width))
  }
  lines.push(centerLine(receipt.station.city, width))
  if (receipt.station.phone) lines.push(centerLine(`Tel ${receipt.station.phone}`, width))
  lines.push("")
  lines.push(rule("=", width))
  lines.push(centerLine(`RECU ${receipt.number}`, width))
  lines.push(rule("=", width))
  lines.push(padLine("Date", shortDateTime(receipt.wash.created_at), width))
  if (receipt.cashier) lines.push(padLine("Caissier", receipt.cashier, width))
  if (receipt.wash.vehicle) lines.push(padLine("Vehicule", receipt.wash.vehicle, width))
  // La plaque, et rien d'autre : c'est à elle que le client reconnaît sa
  // voiture sur le papier, et à elle que la station la reconnaîtra au retour.
  if (receipt.wash.plate) lines.push(padLine("Plaque", receipt.wash.plate, width))
  if (receipt.wash.customer) lines.push(padLine("Client", receipt.wash.customer, width))
  lines.push(rule("-", width))

  for (const item of receipt.items) {
    for (const l of wrapText(item.service_name, width)) lines.push(l)
    lines.push(
      padLine(`  ${item.quantity} x ${formatAmount(item.unit_price_cents)}`, formatAmount(item.line_total_cents), width),
    )
  }

  lines.push(rule("-", width))
  lines.push(padLine("TOTAL", `${formatAmount(receipt.total_cents)} FCFA`, width))
  lines.push(rule("-", width))

  if (receipt.payments.length > 0) {
    lines.push("REGLEMENTS")
    for (const payment of receipt.payments) {
      const suffix = payment.status === "pending" ? " (a verifier)" : ""
      lines.push(padLine(`  ${methodLabel(payment.method)}${suffix}`, formatAmount(payment.amount_cents), width))
    }
    lines.push(rule("-", width))
  }

  lines.push(padLine("PAYE", `${formatAmount(receipt.paid_cents)} FCFA`, width))
  if (receipt.remaining_cents > 0) {
    lines.push(padLine("RESTE A PAYER", `${formatAmount(receipt.remaining_cents)} FCFA`, width))
  }
  lines.push(rule("-", width))

  if (receipt.workers.length > 0) {
    for (const l of wrapText(`Laveurs : ${receipt.workers.join(", ")}`, width)) lines.push(l)
    lines.push(rule("-", width))
  }

  if (receipt.duplicate) {
    lines.push(centerLine("*** DUPLICATA ***", width))
    lines.push(centerLine(`Copie n${receipt.copy_number} du ${shortDateTime(receipt.issued_at)}`, width))
    lines.push(rule("-", width))
  }

  lines.push(centerLine("Merci de votre visite", width))
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Émission
// ---------------------------------------------------------------------------

/**
 * Enregistre une émission et renvoie le reçu.
 *
 * L'attribution du numéro de copie et l'écriture se font dans la même
 * transaction, avec un verrou sur le lavage : deux caissiers qui impriment en
 * même temps obtiennent les copies 1 et 2, jamais deux fois la copie 1.
 */
export async function issueReceipt(
  pool: Pool,
  params: { organizationId: string; washId: string; userId: string },
): Promise<Receipt> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")

    const washQ = await client.query(
      `SELECT w.id, w.reference, w.created_at, w.status, w.total_cents, w.plate,
              s.name AS site_name, s.city, s.address, s.phone,
              o.name AS organization_name,
              vc.name AS vehicle_name,
              coalesce(c.full_name, w.customer_name) AS customer_name,
              nullif(trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')), '') AS cashier
         FROM washes w
         JOIN sites s ON s.id = w.site_id
         JOIN organizations o ON o.id = w.organization_id
         LEFT JOIN vehicle_categories vc ON vc.id = w.vehicle_category_id
         LEFT JOIN customers c ON c.id = w.customer_id
         LEFT JOIN users u ON u.id = w.created_by
        WHERE w.id = $1::uuid AND w.organization_id = $2::uuid
        FOR UPDATE OF w`,
      [params.washId, params.organizationId],
    )
    if (!washQ.rowCount) throw new HttpError(404, "wash_not_found", "Lavage introuvable.")
    const wash = washQ.rows[0]

    // Un lavage annule n'a pas de recu : le document prouverait un paiement
    // pour une prestation qui n'a pas eu lieu.
    if (wash.status === "cancelled") {
      throw new HttpError(409, "wash_cancelled", "Ce lavage est annulé : aucun reçu ne peut être émis.")
    }

    const itemsQ = await client.query(
      `SELECT service_name, quantity, unit_price_cents, line_total_cents
         FROM wash_items WHERE wash_id = $1::uuid ORDER BY service_name`,
      [params.washId],
    )

    const paymentsQ = await client.query(
      `SELECT method, amount_cents, status, created_at
         FROM payments WHERE wash_id = $1::uuid AND status <> 'refunded'
        ORDER BY created_at ASC`,
      [params.washId],
    )

    const workersQ = await client.query(
      `SELECT trim(wk.first_name || ' ' || wk.last_name) AS full_name
         FROM wash_assignments wa
         JOIN workers wk ON wk.id = wa.worker_id
        WHERE wa.wash_id = $1::uuid ORDER BY wk.first_name, wk.last_name`,
      [params.washId],
    )

    const copyQ = await client.query(
      "SELECT COALESCE(MAX(copy_number),0) + 1 AS next FROM receipt_issues WHERE wash_id = $1::uuid",
      [params.washId],
    )
    const copyNumber = Number(copyQ.rows[0].next)

    const issueQ = await client.query(
      `INSERT INTO receipt_issues(organization_id, wash_id, copy_number, issued_by)
       VALUES($1::uuid,$2::uuid,$3,$4::uuid) RETURNING issued_at`,
      [params.organizationId, params.washId, copyNumber, params.userId],
    )

    // Une reimpression est tracee comme un geste, pas comme une lecture : le
    // journal doit pouvoir repondre a « combien de papiers circulent pour ce
    // lavage ».
    await client.query(
      `INSERT INTO audit_logs(organization_id, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES($1,$2,$3,'wash',$4,$5)`,
      [
        params.organizationId,
        params.userId,
        copyNumber === 1 ? "receipt.issued" : "receipt.reprinted",
        params.washId,
        JSON.stringify({ copy_number: copyNumber, reference: wash.reference }),
      ],
    )

    await client.query("COMMIT")

    const paid = paymentsQ.rows.reduce((sum, p) => sum + Number(p.amount_cents), 0)
    const total = Number(wash.total_cents)

    return {
      number: wash.reference ?? params.washId.slice(0, 8).toUpperCase(),
      issued_at: new Date(issueQ.rows[0].issued_at).toISOString(),
      copy_number: copyNumber,
      duplicate: copyNumber > 1,
      station: {
        name: wash.organization_name,
        site: wash.site_name,
        city: wash.city,
        address: wash.address,
        phone: wash.phone,
      },
      wash: {
        reference: wash.reference,
        created_at: new Date(wash.created_at).toISOString(),
        vehicle: wash.vehicle_name,
        plate: wash.plate,
        customer: wash.customer_name,
      },
      cashier: wash.cashier,
      workers: workersQ.rows.map((r) => r.full_name as string),
      items: itemsQ.rows.map((r) => ({
        service_name: r.service_name,
        quantity: Number(r.quantity),
        unit_price_cents: Number(r.unit_price_cents),
        line_total_cents: Number(r.line_total_cents),
      })),
      total_cents: total,
      payments: paymentsQ.rows.map((r) => ({
        method: r.method,
        amount_cents: Number(r.amount_cents),
        status: r.status,
        created_at: new Date(r.created_at).toISOString(),
      })),
      paid_cents: paid,
      remaining_cents: Math.max(total - paid, 0),
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

/** Send the receipt text via WhatsApp and return the wa.me URL. */
export async function sendReceiptViaWhatsApp(
  _pool: Pool,
  _organizationId: string,
  _washId: string,
  receiptText: string
) {
  const { normalizeWhatsAppNumber, buildWhatsAppUrl } = await import("./support.ts")

  // Récupérer la configuration WhatsApp depuis les variables d'environnement
  const { env } = await import("./env.ts")
  const whatsappNumber = env.SUPPORT_WHATSAPP?.trim() || "+225 07 00 00 00 00"
  const normalizedNumber = normalizeWhatsAppNumber(whatsappNumber)
  const whatsappUrl = buildWhatsAppUrl(normalizedNumber, receiptText)

  // Note: L'envoi proprement dit est déclenché côté client via le lien URL.
  // Ici on retourne simplement l'URL à utiliser.

  return { whatsappUrl, normalizedNumber }
}

/** Historique des émissions, pour savoir combien de papiers circulent. */
export async function receiptHistory(pool: Pool, organizationId: string, washId: string) {
  const q = await pool.query(
    `SELECT r.copy_number, r.issued_at,
            nullif(trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')), '') AS issued_by
       FROM receipt_issues r
       LEFT JOIN users u ON u.id = r.issued_by
      WHERE r.wash_id = $1::uuid AND r.organization_id = $2::uuid
      ORDER BY r.copy_number ASC`,
    [washId, organizationId],
  )
  return q.rows
}
