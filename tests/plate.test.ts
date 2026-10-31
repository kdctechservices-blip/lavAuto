/**
 * Plaques d'immatriculation.
 *
 * Le produit ne tient pas de fichier client : la plaque est le seul moyen de
 * reconnaître un véhicule qui revient. Si la normalisation diverge entre le
 * serveur (qui range) et le navigateur (qui cherche), le caissier tapera une
 * plaque et ne retrouvera pas les passages précédents — la fonctionnalité
 * aurait l'air cassée sans qu'aucun test ne tombe.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { plateKey as serverKey, plateDisplay as serverDisplay, MAX_PLATE_LENGTH as serverMax } from "../server/plate.ts"
import { plateKey as clientKey, plateDisplay as clientDisplay, MAX_PLATE_LENGTH as clientMax } from "../src/lib/plate.ts"

/** Saisies réalistes d'un caissier pressé, plus quelques cas tordus. */
const CORPUS = [
  "1234 AB 01",
  "1234ab01",
  " 1234-AB-01 ",
  "1234  ab  01",
  "AB-1234-CI",
  "0001 ZZ 99",
  "tt 00 11",
  "  ",
  "",
  "---",
  "é",
  "VÉHICULE12",
  "WW 123 CI",
  "2W-4567-01",
  "A1",
  "012345678901234567890",
  "plaque inconnue",
  "1234\tAB\n01",
]

test("le serveur et le navigateur normalisent exactement de la même façon", () => {
  for (const raw of CORPUS) {
    assert.equal(clientKey(raw), serverKey(raw), `clé divergente pour ${JSON.stringify(raw)}`)
    assert.equal(clientDisplay(raw), serverDisplay(raw), `affichage divergent pour ${JSON.stringify(raw)}`)
  }
  assert.equal(clientMax, serverMax)
})

test("le miroir client reprend le corps des fonctions du serveur", () => {
  // Une copie peut diverger sans que le corpus ci-dessus ne le révèle : on
  // compare aussi le code lui-même, commentaires d'en-tête mis à part.
  const corps = (chemin: string) => {
    const source = readFileSync(new URL(chemin, import.meta.url), "utf8")
    const debut = source.indexOf("export const MAX_PLATE_LENGTH")
    assert.ok(debut > 0, `point de départ introuvable dans ${chemin}`)
    return source
      .slice(debut)
      .split("\n")
      .filter((ligne) => !ligne.trim().startsWith("*") && !ligne.trim().startsWith("/*"))
      .join("\n")
      .trim()
  }
  assert.equal(corps("../src/lib/plate.ts"), corps("../server/plate.ts"))
})

test("une même plaque écrite de plusieurs façons donne une seule clé", () => {
  const attendu = "1234AB01"
  for (const variante of ["1234 AB 01", "1234ab01", " 1234-AB-01 ", "1234  ab  01", "1234\tAB\n01"]) {
    assert.equal(serverKey(variante), attendu, `échec sur ${JSON.stringify(variante)}`)
  }
})

test("une saisie vide veut dire « lavage sans plaque », pas une plaque vide", () => {
  assert.equal(serverKey(""), null)
  assert.equal(serverKey("   "), null)
  assert.equal(serverKey("---"), null)
  assert.equal(serverKey(null), null)
  assert.equal(serverKey(undefined), null)
  assert.equal(serverDisplay("   "), null)
  assert.equal(serverDisplay("- -"), null)
})

test("la forme affichée garde la ponctuation du conducteur, en majuscules", () => {
  assert.equal(serverDisplay(" 1234-ab-01 "), "1234-AB-01")
  assert.equal(serverDisplay("1234  ab  01"), "1234 AB 01")
})

test("les accents sont retirés plutôt que de créer un second véhicule", () => {
  assert.equal(serverKey("VÉHICULE12"), serverKey("VEHICULE12"))
})

test("une plaque trop longue est tronquée au lieu d'être refusée", () => {
  // Refuser bloquerait un encaissement : sur une caisse, c'est le mauvais
  // arbitrage. On garde ce qui est exploitable.
  const key = serverKey("012345678901234567890")
  assert.ok(key)
  assert.equal(key.length, MAX_LENGTH_ATTENDUE)
})

const MAX_LENGTH_ATTENDUE = 16

test("aucun format n'est imposé : plaques étrangères et deux-roues passent", () => {
  assert.equal(serverKey("WW 123 CI"), "WW123CI")
  assert.equal(serverKey("2W-4567-01"), "2W456701")
  assert.equal(serverKey("A1"), "A1")
})

test("la normalisation est stable : la repasser ne change plus rien", () => {
  for (const raw of CORPUS) {
    const once = serverKey(raw)
    if (once === null) continue
    assert.equal(serverKey(once), once, `instable pour ${JSON.stringify(raw)}`)
  }
})

test("la plaque est bien déclarée facultative côté serveur", () => {
  const api = readFileSync(new URL("../server/api.ts", import.meta.url), "utf8")
  assert.match(
    api,
    /plate:\s*z\.string\(\)\.trim\(\)\.max\(\d+\)\.nullable\(\)\.optional\(\)/,
    "le validateur de création doit accepter l'absence de plaque",
  )
})

test("le schéma range la plaque affichée ET la clé de regroupement", () => {
  const db = readFileSync(new URL("../server/db.ts", import.meta.url), "utf8")
  assert.match(db, /ALTER TABLE washes ADD COLUMN IF NOT EXISTS plate text;/)
  assert.match(db, /ALTER TABLE washes ADD COLUMN IF NOT EXISTS plate_key text;/)
  assert.match(
    db,
    /CREATE INDEX IF NOT EXISTS idx_washes_org_plate ON washes\(organization_id,plate_key,created_at DESC\);/,
    "sans index, l'historique d'un véhicule parcourrait toute la table",
  )
})
