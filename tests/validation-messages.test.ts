/**
 * Messages de validation en français.
 *
 * Un caissier à qui l'on répond « Invalid option: expected one of
 * "cash"|"orange_money" » ne sait ni ce qui est refusé, ni quoi corriger. Ces
 * tests protègent trois promesses :
 *
 *   1. plus aucun message d'anglais ne sort de la validation ;
 *   2. le message dit **quel champ** est en cause, en termes métier ;
 *   3. un message écrit à la main dans un validateur n'est jamais écrasé.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { z } from "zod"
import { describeIssue, describeIssues, fieldLabel } from "../server/validation-messages.ts"

/** Raccourci : valide `value` contre `schema` et rend le message produit. */
function message(schema: z.ZodTypeAny, value: unknown): string {
  const result = schema.safeParse(value)
  assert.equal(result.success, false, "le cas de test doit produire une anomalie")
  return describeIssues((result as { error: z.ZodError }).error.issues, value)
}

test("un champ manquant est annoncé comme obligatoire, pas comme « indéfini »", () => {
  assert.equal(message(z.object({ site_id: z.string().uuid() }), {}), "La station est obligatoire.")
  assert.equal(message(z.object({ name: z.string() }), {}), "Le nom est obligatoire.")
})

test("une valeur hors liste ne parle plus d'« option »", () => {
  const schema = z.object({ payment_method: z.enum(["cash", "orange_money", "wave"]) })
  assert.equal(
    message(schema, { payment_method: "especes" }),
    "Le mode de paiement ne fait pas partie des choix possibles.",
  )
})

test("la tournure vaut au masculin comme au féminin", () => {
  // Le libellé décide du genre : aucune formulation ne doit s'accorder.
  const masculin = message(z.object({ payment_method: z.enum(["cash"]) }), { payment_method: "x" })
  const feminin = message(z.object({ category: z.enum(["a"]) }), { category: "x" })
  assert.match(masculin, /^Le mode de paiement ne fait pas partie/)
  assert.match(feminin, /^La catégorie ne fait pas partie/)
})

test("un identifiant invalide renvoie vers la liste plutôt que vers « UUID »", () => {
  const texte = message(z.object({ site_id: z.string().uuid() }), { site_id: "abc" })
  assert.equal(texte, "La station n'est pas valide. Reprenez la sélection dans la liste.")
  assert.doesNotMatch(texte, /uuid/i)
})

test("une date mal écrite indique le format attendu", () => {
  assert.equal(
    message(z.object({ work_date: z.iso.date() }), { work_date: "21/10/2026" }),
    "La date doit respecter le format AAAA-MM-JJ.",
  )
})

test("un montant décimal est refusé en français", () => {
  assert.equal(
    message(z.object({ amount_cents: z.number().int() }), { amount_cents: 12.5 }),
    "Le montant doit être un nombre entier.",
  )
})

test("une borne en centimes se relit en francs, chiffres espacés", () => {
  assert.equal(
    message(z.object({ amount_cents: z.number().max(100_000_000) }), { amount_cents: 200_000_000 }),
    "Le montant ne peut pas dépasser 1 000 000 F.",
  )
})

test("une liste vide dit combien il en faut, sans accord de genre", () => {
  assert.equal(
    message(z.object({ items: z.array(z.string()).min(1) }), { items: [] }),
    "Les prestations : il faut en indiquer au moins 1.",
  )
})

test("l'anomalie d'une ligne de liste donne le numéro de ligne", () => {
  const schema = z.object({ items: z.array(z.object({ quantity: z.number().int().min(1) })) })
  assert.equal(
    message(schema, { items: [{ quantity: 3 }, { quantity: 0 }] }),
    "Ligne 2 : la quantité doit être au moins 1.",
  )
})

test("un message écrit à la main dans le validateur n'est jamais écrasé", () => {
  const schema = z.object({
    items: z.array(z.string()).min(1, "Sélectionnez au moins une prestation."),
  })
  assert.equal(message(schema, { items: [] }), "Sélectionnez au moins une prestation.")
})

test("un message écrit à la main reste intact même préfixé d'un numéro de ligne", () => {
  const schema = z.object({
    items: z.array(z.object({ reason: z.string().min(3, "Indiquez le motif de l’annulation.") })),
  })
  assert.equal(
    message(schema, { items: [{ reason: "ok" }] }),
    "Ligne 1 : indiquez le motif de l’annulation.",
  )
})

test("une quantité strictement positive ne dit pas « au moins 0 »", () => {
  // `.positive()` pose une borne exclusive : répondre « au moins 0 » laisserait
  // croire que zéro passe.
  assert.equal(
    message(z.object({ received_milli: z.number().int().positive() }), { received_milli: 0 }),
    "La quantité reçue doit dépasser 0.",
  )
})

test("une heure de la journée se relit en heures, pas en minutes depuis minuit", () => {
  // La borne vaut 1439 en base ; annoncer « 1 439 » n'apprendrait rien.
  assert.equal(
    message(z.object({ start_minute: z.number().int().min(0).max(1439) }), { start_minute: 9999 }),
    "L'heure de début ne peut pas dépasser 23:59.",
  )
  assert.equal(
    message(z.object({ end_minute: z.number().int().min(0).max(1439) }), { end_minute: 1500 }),
    "L'heure de fin ne peut pas dépasser 23:59.",
  )
})

test("un champ absent du lexique reste compréhensible", () => {
  // Le suffixe technique est retiré : « widget » vaut mieux que « widget_id ».
  const texte = message(z.object({ widget_id: z.string().uuid() }), {})
  assert.equal(texte, "« widget » est obligatoire.")
})

test("deux anomalies identiques ne sont pas répétées", () => {
  const schema = z.object({ items: z.array(z.object({ name: z.string() })) })
  const texte = message(schema, { items: [{}, {}] })
  // Chaque ligne est nommée, donc les deux phrases diffèrent ; ce qui ne doit
  // pas arriver, c'est la même phrase deux fois.
  const phrases = texte.split(" Ligne ")
  assert.equal(new Set(phrases).size, phrases.length, `phrases répétées dans « ${texte} »`)
})

test("plusieurs anomalies distinctes sont toutes rapportées", () => {
  const schema = z.object({ site_id: z.string().uuid(), payment_method: z.enum(["cash"]) })
  const texte = message(schema, {})
  assert.match(texte, /La station est obligatoire\./)
  assert.match(texte, /Le mode de paiement est obligatoire\./)
})

test("le nom d'un champ se lit en termes métier", () => {
  assert.equal(fieldLabel(["payment_method"]), "le mode de paiement")
  assert.equal(fieldLabel(["vehicle_category_id"]), "la catégorie de véhicule")
  assert.equal(fieldLabel(["items", 0, "quantity"]), "la quantité")
  assert.equal(fieldLabel([]), null)
})

test("aucun message d'anglais ne sort des cas courants", () => {
  // Filet large : on passe en revue les formes d'anomalie que l'API peut
  // produire et on vérifie qu'aucun mot-clé anglais ne subsiste.
  const cas: [z.ZodTypeAny, unknown][] = [
    [z.object({ name: z.string() }), {}],
    [z.object({ name: z.string().min(2) }), { name: "a" }],
    [z.object({ name: z.string().max(3) }), { name: "abcdef" }],
    [z.object({ quantity: z.number().int() }), { quantity: 1.5 }],
    [z.object({ quantity: z.number().min(1) }), { quantity: 0 }],
    [z.object({ quantity: z.number().max(10) }), { quantity: 99 }],
    [z.object({ email: z.email() }), { email: "pas-un-email" }],
    [z.object({ site_id: z.string().uuid() }), { site_id: "x" }],
    [z.object({ work_date: z.iso.date() }), { work_date: "hier" }],
    [z.object({ at: z.iso.datetime() }), { at: "midi" }],
    [z.object({ is_active: z.boolean() }), { is_active: "oui" }],
    [z.object({ items: z.array(z.string()) }), { items: "une" }],
    [z.object({ items: z.array(z.string()).min(1) }), { items: [] }],
    [z.object({ status: z.enum(["active", "inactive"]) }), { status: "zzz" }],
    [z.object({ amount_cents: z.number().multipleOf(5) }), { amount_cents: 7 }],
  ]
  const anglais = /\b(expected|received|invalid|too small|too big|required|string|number|array|option)\b/i
  for (const [schema, value] of cas) {
    const texte = message(schema, value)
    assert.doesNotMatch(texte, anglais, `message encore en anglais : « ${texte} »`)
  }
})

test("le français est branché par défaut dès le chargement du module", () => {
  // Sans cela, la comparaison qui distingue un message écrit à la main d'un
  // message par défaut se tromperait systématiquement.
  const issue = (z.string().safeParse(42) as { error: z.ZodError }).error.issues[0]
  assert.doesNotMatch(describeIssue(issue, 42), /expected|received/i)
})

test("la validation des requêtes passe bien par ce traducteur", () => {
  const source = readFileSync(new URL("../server/http.ts", import.meta.url), "utf8")
  assert.match(
    source,
    /describeIssues\(result\.error\.issues, value\)/,
    "body() doit déléguer la mise en français, et transmettre la valeur reçue",
  )
})
