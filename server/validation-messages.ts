/**
 * Messages de validation en français.
 *
 * Jusqu'ici, une saisie refusée renvoyait le message brut de la bibliothèque
 * de validation : « Invalid option: expected one of "cash"|"orange_money" ».
 * Dans un produit vendu à des stations de lavage ivoiriennes, c'est
 * inutilisable — le caissier ne sait ni ce qu'est une « option », ni quoi
 * corriger.
 *
 * Basculer la bibliothèque en français ne suffit pas : elle produit alors
 * « Entrée invalide : chaîne de caractères attendu, indéfini reçu », ce qui
 * n'aide pas davantage. Deux choses manquent vraiment :
 *
 *   1. **quel champ** est en cause — c'est l'information la plus utile, et
 *      c'est précisément celle que le message brut n'a jamais ;
 *   2. **une phrase**, pas un diagnostic technique.
 *
 * Ce module fabrique donc « Le mode de paiement n'est pas reconnu. » à partir
 * de l'anomalie signalée. La traduction officielle reste branchée en filet :
 * si un cas n'est pas prévu ici, le message sera au moins en français.
 *
 * Les messages écrits à la main dans les validateurs sont toujours préférés :
 * « Sélectionnez au moins une prestation. » vaut mieux que toute règle
 * générique, et ce module se garde bien de l'écraser.
 */
import { z } from "zod"

/** Traduction officielle, utilisée comme filet et comme point de comparaison. */
const localeFr = z.locales.fr()

/**
 * Branche le français par défaut dans toute l'application.
 *
 * Sans cela, un message non prévu par ce module ressortirait en anglais —
 * mais surtout, `describeIssue` reconnaît un message écrit à la main en le
 * comparant à la traduction officielle. Si la bibliothèque parlait encore
 * anglais, tous les messages par défaut passeraient pour personnalisés et
 * seraient recopiés tels quels. La configuration n'est donc pas un confort :
 * elle conditionne la justesse du reste.
 */
export function configureFrenchValidation(): void {
  z.config(localeFr)
}

// Appliqué dès le chargement du module, et non au démarrage du serveur :
// `describeIssue` doit pouvoir être juste partout, y compris dans un test qui
// n'instancie pas l'application.
configureFrenchValidation()

/**
 * Nom des champs, en français et avec leur article.
 *
 * L'article est inclus parce qu'il dépend du mot : « le mode de paiement »
 * mais « la quantité ». Le stocker ici évite une règle de grammaire fragile.
 */
const FIELD_LABELS: Record<string, string> = {
  // Identité et comptes
  email: "l'adresse e-mail",
  password: "le mot de passe",
  first_name: "le prénom",
  last_name: "le nom",
  phone: "le numéro de téléphone",
  role: "le rôle",
  custom_role: "l'intitulé du poste",
  status: "le statut",
  is_active: "l'état actif",

  // Organisation et stations
  name: "le nom",
  description: "la description",
  city: "la ville",
  district: "la commune",
  address: "l'adresse",
  site_id: "la station",
  logo_url: "le logo",
  contact_name: "le nom du contact",

  // Lavages
  vehicle_category_id: "la catégorie de véhicule",
  service_id: "la prestation",
  items: "les prestations",
  quantity: "la quantité",
  worker_id: "le laveur",
  worker_ids: "les laveurs",
  principal_worker_id: "le responsable du lavage",
  plate: "la plaque",
  reference: "la référence",
  reason: "le motif",
  comment: "le commentaire",
  note: "la note",
  notes: "les notes",

  // Argent
  payment_method: "le mode de paiement",
  method: "le mode de paiement",
  paid_with: "le mode de paiement",
  channel: "le moyen d'encaissement",
  amount_cents: "le montant",
  amount: "le montant",
  amount_received_cents: "le montant reçu",
  price_cents: "le prix",
  price_xof: "le prix",
  price_by_vehicle_type: "les prix par catégorie de véhicule",
  unit_price_cents: "le prix unitaire",
  total_cents: "le total",
  opening_amount_cents: "le fond de caisse",
  counted_amount_cents: "le montant compté",
  discrepancy_reason: "le motif de l'écart",
  cash_session_id: "la session de caisse",
  transaction_reference: "la référence de la transaction",
  payment_reference: "la référence du paiement",
  invoice_reference: "la référence de la facture",
  beneficiary: "le bénéficiaire",
  category: "la catégorie",

  // Stock et achats
  product_id: "le produit",
  category_id: "la catégorie",
  unit: "l'unité de mesure",
  unit_cost_cents: "le coût unitaire",
  quantity_milli: "la quantité",
  received_milli: "la quantité reçue",
  counted_milli: "la quantité comptée",
  initial_quantity_milli: "la quantité initiale",
  low_stock_threshold_milli: "le seuil d'alerte",
  supplier_id: "le fournisseur",
  purchase_date: "la date de l'achat",
  kind: "le type de mouvement",

  // Présences et horaires
  work_date: "la date",
  check_in_at: "l'heure d'arrivée",
  check_out_at: "l'heure de départ",
  break_minutes: "la pause",
  break_duration_minutes: "la pause",
  absence_reason: "le motif de l'absence",
  day_of_week: "le jour de la semaine",
  specific_date: "la date",
  start_minute: "l'heure de début",
  end_minute: "l'heure de fin",
  late_tolerance_minutes: "la tolérance de retard",
  valid_from: "la date de début de validité",
  valid_to: "la date de fin de validité",
  duration_minutes: "la durée",
  joined_at: "la date d'arrivée",
  at: "l'heure",

  // Abonnement et assistance
  plan_code: "le forfait",
  months: "le nombre de mois",
  days: "le nombre de jours",
  grace_days: "le délai de grâce",
  trial_days: "la durée de l'essai",
  subject: "l'objet",
  body: "le message",
  message: "le message",
  text: "le message",
  template_id: "le modèle",
  internal: "la visibilité interne",
  stage: "l'étape",
  type: "le type",
  code: "le code",

  // Filtres et pagination
  from: "la date de début",
  to: "la date de fin",
  limit: "le nombre de résultats",
  offset: "la position de départ",
}

/** Le dernier segment textuel du chemin : le champ réellement en cause. */
function lastKey(path: readonly PropertyKey[]): string | null {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const segment = path[i]
    if (typeof segment === "string") return segment
  }
  return null
}

/** Le numéro de ligne, quand l'anomalie porte sur un élément d'une liste. */
function lineNumber(path: readonly PropertyKey[]): number | null {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const segment = path[i]
    if (typeof segment === "number") return segment + 1
  }
  return null
}

/**
 * Nom lisible d'un champ inconnu du dictionnaire.
 *
 * Mieux vaut « le fournisseur » tiré de `supplier_id` qu'un message sans
 * aucune indication. Les suffixes techniques sont retirés : ils ne veulent
 * rien dire pour celui qui lit.
 */
function humanise(key: string): string {
  const nettoye = key
    .replace(/_(id|cents|milli|minutes|at|url)$/u, "")
    .replace(/_/gu, " ")
    .trim()
  if (!nettoye) return "ce champ"
  return `« ${nettoye} »`
}

/** Nom du champ en cause, article compris, ou null si le chemin est vide. */
export function fieldLabel(path: readonly PropertyKey[]): string | null {
  const key = lastKey(path)
  if (!key) return null
  return FIELD_LABELS[key] ?? humanise(key)
}

/**
 * Valeur réellement envoyée à l'emplacement signalé.
 *
 * L'anomalie publique ne transporte pas ce qui a été reçu : sans cela, on ne
 * peut distinguer « le champ manque » de « le champ est mal rempli », et la
 * traduction officielle ne peut pas être reproduite à l'identique.
 */
function valueAtPath(input: unknown, path: readonly PropertyKey[]): unknown {
  let courant: unknown = input
  for (const segment of path) {
    if (courant === null || courant === undefined) return undefined
    if (typeof courant !== "object") return undefined
    courant = (courant as Record<PropertyKey, unknown>)[segment]
  }
  return courant
}

/** Le champ signalé est-il absent, par opposition à mal rempli ? */
function isMissing(input: unknown, path: readonly PropertyKey[]): boolean {
  return valueAtPath(input, path) === undefined
}

/** Met une majuscule au premier caractère, en respectant les accents. */
function capitalise(phrase: string): string {
  if (!phrase) return phrase
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

/** Remet une minuscule initiale, pour enchaîner après « Ligne 2 : ». */
function decapitalise(phrase: string): string {
  if (!phrase) return phrase
  // Un sigle reste intact : « RCCM » ne doit pas devenir « rCCM ».
  if (phrase.length > 1 && phrase[1] === phrase[1].toUpperCase() && /\p{L}/u.test(phrase[1])) return phrase
  return phrase.charAt(0).toLowerCase() + phrase.slice(1)
}

/** Un nombre long se lit mieux espacé : 1 000 000 plutôt que 1000000. */
function groupDigits(valeur: number): string {
  return new Intl.NumberFormat("fr-FR").format(valeur).replace(/\u202f|\u00a0/gu, " ")
}

/** Une quantité stockée en millièmes se relit en unités. */
function readableBound(key: string | null, valeur: number): string {
  if (key && key.endsWith("_cents")) return `${groupDigits(Math.round(valeur / 100))} F`
  if (key && key.endsWith("_milli")) return groupDigits(valeur / 1000)
  // Une heure de la journée est stockée en minutes depuis minuit. Annoncer
  // « 1 439 » n'apprend rien : le gérant raisonne en « 23:59 ».
  if (key === "start_minute" || key === "end_minute") {
    if (Number.isInteger(valeur) && valeur >= 0 && valeur <= 1439) {
      return `${String(Math.floor(valeur / 60)).padStart(2, "0")}:${String(valeur % 60).padStart(2, "0")}`
    }
  }
  return groupDigits(valeur)
}

/**
 * Transforme une anomalie en phrase française.
 *
 * Renvoie `null` quand le cas n'est pas prévu : l'appelant retombe alors sur
 * la traduction officielle plutôt que d'inventer une formulation approximative.
 */
function phraseFor(issue: z.core.$ZodIssue, input: unknown): string | null {
  const key = lastKey(issue.path)
  const label = fieldLabel(issue.path)
  if (!label) return null
  const sujet = capitalise(label)

  switch (issue.code) {
    case "invalid_type": {
      const manquant = isMissing(input, issue.path ?? [])
      if (manquant) return `${sujet} est obligatoire.`
      if (issue.expected === "int") return `${sujet} doit être un nombre entier.`
      if (issue.expected === "number") return `${sujet} doit être un nombre.`
      if (issue.expected === "boolean") return `${sujet} ne peut valoir que oui ou non.`
      if (issue.expected === "array") return `${sujet} doit former une liste.`
      return `${sujet} n'a pas le bon format.`
    }

    case "invalid_value":
      // Un champ à choix imposés qui manque est signalé comme une valeur hors
      // liste, pas comme une absence. Sans ce test, on répondrait « ne fait
      // pas partie des choix » à quelqu'un qui n'a rien choisi du tout.
      if (isMissing(input, issue.path ?? [])) return `${sujet} est obligatoire.`
      // « n'est pas reconnu » s'accorderait ; la tournure retenue vaut pour
      // « le mode de paiement » comme pour « la catégorie ».
      return `${sujet} ne fait pas partie des choix possibles.`

    case "invalid_format": {
      const format = (issue as { format?: string }).format
      if (format === "uuid") return `${sujet} n'est pas valide. Reprenez la sélection dans la liste.`
      if (format === "email") return `${sujet} n'est pas valide.`
      if (format === "date") return `${sujet} doit respecter le format AAAA-MM-JJ.`
      if (format === "datetime") return `${sujet} doit comporter une date et une heure.`
      if (format === "url") return `${sujet} doit être une adresse internet valide.`
      return `${sujet} n'a pas le bon format.`
    }

    case "too_small": {
      const minimum = Number((issue as { minimum?: unknown }).minimum ?? 0)
      const origin = (issue as { origin?: string }).origin
      if (origin === "string") {
        if (minimum <= 1) return `${sujet} est obligatoire.`
        return `${sujet} doit contenir au moins ${minimum} caractères.`
      }
      if (origin === "array") {
        // Formulation sans accord : « sélectionnez-en au moins un » tomberait
        // faux sur « les prestations », et le genre n'est pas devinable ici.
        return `${sujet} : il faut en indiquer au moins ${minimum}.`
      }
      // `.positive()` produit une borne EXCLUSIVE à zéro : répondre « au moins
      // 0 » serait faux, et laisserait croire que zéro est accepté.
      const inclusive = (issue as { inclusive?: boolean }).inclusive !== false
      if (!inclusive) return `${sujet} doit dépasser ${readableBound(key, minimum)}.`
      return `${sujet} doit être au moins ${readableBound(key, minimum)}.`
    }

    case "too_big": {
      const maximum = Number((issue as { maximum?: unknown }).maximum ?? 0)
      const origin = (issue as { origin?: string }).origin
      if (origin === "string") return `${sujet} ne doit pas dépasser ${maximum} caractères.`
      if (origin === "array") return `${sujet} : ${maximum} au maximum.`
      const inclusive = (issue as { inclusive?: boolean }).inclusive !== false
      if (!inclusive) return `${sujet} doit rester en dessous de ${readableBound(key, maximum)}.`
      return `${sujet} ne peut pas dépasser ${readableBound(key, maximum)}.`
    }

    case "not_multiple_of":
      return `${sujet} doit être un multiple de ${(issue as { divisor?: number }).divisor ?? ""}.`.replace(" .", ".")

    default:
      return null
  }
}

/**
 * Message final pour une anomalie.
 *
 * Un message écrit à la main dans le validateur l'emporte toujours : il est
 * plus précis que toute règle générique. On le reconnaît au fait qu'il diffère
 * de ce que produirait la traduction officielle.
 */
export function describeIssue(issue: z.core.$ZodIssue, input?: unknown): string {
  const path = issue.path ?? []
  // L'anomalie publique ne transporte pas la valeur reçue, alors que la
  // traduction officielle s'en sert pour écrire « nombre reçu ». On la
  // réinjecte, sans quoi la comparaison ci-dessous échouerait toujours et
  // chaque message par défaut passerait pour un message écrit à la main.
  const brut = { ...issue, input: valueAtPath(input, path) } as Parameters<
    NonNullable<typeof localeFr.localeError>
  >[0]
  const parDefaut = localeFr.localeError?.(brut)
  const estPersonnalise = typeof parDefaut === "string" && issue.message !== parDefaut
  const ligne = lineNumber(path)
  const prefixe = ligne === null ? "" : `Ligne ${ligne} : `
  const ajuste = (phrase: string) => `${prefixe}${ligne === null ? phrase : decapitalise(phrase)}`

  if (estPersonnalise) return ajuste(issue.message)

  const phrase = phraseFor(issue, input)
  if (phrase) return ajuste(phrase)
  return ajuste(issue.message)
}

/**
 * Message final pour un ensemble d'anomalies.
 *
 * Les doublons sont retirés : deux lignes d'un achat auxquelles il manque le
 * même champ ne méritent pas deux fois la même phrase.
 */
export function describeIssues(issues: readonly z.core.$ZodIssue[], input?: unknown): string {
  const phrases: string[] = []
  for (const issue of issues) {
    const phrase = describeIssue(issue, input)
    if (!phrases.includes(phrase)) phrases.push(phrase)
  }
  return phrases.join(" ")
}
