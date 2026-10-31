/**
 * Les référentiels du produit : une seule vérité, même si elle est écrite
 * deux fois.
 *
 * Certaines listes doivent exister des deux côtés — l'interface pour proposer
 * un choix, le serveur pour le valider — et d'autres dans la base, parce que
 * c'est elle qui les rend modifiables. La duplication n'est pas le problème ;
 * la **dérive silencieuse** l'est : un serveur qui refuse une catégorie que
 * l'écran propose, c'est un formulaire qui répond 400 sans que rien n'explique
 * pourquoi. Un tarif semé en base qui ne correspond plus au repli affiché,
 * c'est un prix annoncé que le client ne paiera pas.
 *
 * Ces vérifications comparent les fichiers et la base, pas des copies : elles
 * échouent dès que l'un des deux côtés bouge seul.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { PRICING_PLANS } from "../src/config/pricing.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8")

/** Codes d'un `z.enum([...])` du serveur, pour comparer avec l'interface. */
function serverEnum(source: string, anchor: string): string[] {
  const start = source.indexOf(anchor)
  assert.ok(start >= 0, `ancre « ${anchor} » introuvable`)
  const end = source.indexOf("])", start)
  const block = source.slice(start, end)
  return [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort()
}

/** Valeurs d'un tableau de chaînes `const NOM = ["a", "b"]`. */
function arrayValues(source: string, anchor: string): string[] {
  const start = source.indexOf(anchor)
  assert.ok(start >= 0, `ancre « ${anchor} » introuvable`)
  const end = source.indexOf("]", start)
  return [...source.slice(start, end).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort()
}

/** Valeurs d'une liste `{ value: "…", label: "…" }` de l'interface. */
function uiValues(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name}`)
  assert.ok(start >= 0, `liste « ${name} » introuvable`)
  // Tolère une annotation de type entre le nom et le tableau
  // (`const NOM: Option[] = [`), sans confondre les crochets du type.
  const open = source.indexOf("[", source.indexOf("=", start))
  const end = source.indexOf("]", open)
  const block = source.slice(open, end)
  return [...block.matchAll(/value:\s*"([a-z_]+)"/g)].map((m) => m[1]).sort()
}

test("les catégories de dépense proposées sont celles que le serveur accepte", () => {
  const ui = uiValues(read("src/lib/expenses.ts"), "EXPENSE_CATEGORIES")
  const server = serverEnum(read("server/operations.ts"), "category: z.enum([")
  assert.deepEqual(ui, server, "l'écran propose une catégorie que l'API refuserait (ou l'inverse)")
})

test("les moyens de paiement de l'interface sont ceux du serveur", () => {
  const ui = uiValues(read("src/app/washes/page.tsx"), "paymentMethods")
  // Le tableau, pas un `z.enum` : `payments.ts` en contient d'autres plus loin
  // (statuts de paiement), qu'une extraction naïve mélangerait.
  const server = arrayValues(read("server/payments.ts"), "export const PAYMENT_METHODS = [")
  assert.deepEqual(ui, server, "un moyen de paiement proposé n'est pas accepté par l'API")
})

test("les tarifs semés en base sont ceux que l'interface affiche en repli", () => {
  const schema = read("server/db.ts")
  // Chaque ligne du jeu de départ : ('starter', …, 1000000,'monthly', …)
  const seeded = [...schema.matchAll(/\('(starter|pro|business)','[^']*','(?:[^']|'')*',(\d+),'monthly'/g)].map(
    (m) => ({ code: m[1], priceXof: Number(m[2]) / 100 }),
  )
  assert.equal(seeded.length, 3, "les trois forfaits sont semés en base")

  for (const plan of PRICING_PLANS) {
    const row = seeded.find((item) => item.code === plan.code)
    assert.ok(row, `le forfait ${plan.code} est absent du jeu de départ`)
    assert.equal(
      row.priceXof,
      plan.priceXof,
      `le forfait ${plan.code} vaut ${row.priceXof} F en base et ${plan.priceXof} F dans le repli affiché`,
    )
  }
})

test("la grille tarifaire publique ne publie que des forfaits existants", () => {
  // `server/public-pricing.ts` filtre sur ces codes : en oublier un laisserait
  // un forfait achetable invisible sur la page de tarifs.
  const source = read("server/public-pricing.ts")
  const published = [...source.matchAll(/'(starter|pro|business)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(published, PRICING_PLANS.map((plan) => plan.code).sort())
})
