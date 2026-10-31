/**
 * Garde-fous du parcours opérateur de suppression d'une station.
 *
 * Les règles API sont couvertes par console-deletion.test.ts. Ici, on vérifie
 * le contrat d'interface qui évite les gestes accidentels et l'ancien écran
 * mort après une purge réussie.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const flow = readFileSync("src/console/components/organization-deletion.tsx", "utf8")
const detail = readFileSync("src/console/pages/station-detail.tsx", "utf8")
const stations = readFileSync("src/console/pages/stations.tsx", "utf8")

test("les confirmations de suppression utilisent le Dialogue applicatif", () => {
  assert.match(flow, /<Dialog/)
  assert.match(flow, /role="alert"/)
  assert.doesNotMatch(flow, /window\.(?:prompt|confirm)/)
  assert.match(detail, /<OrganizationDeletionFlow/)
  assert.doesNotMatch(detail, /function (?:DangerZone|PurgeButton)/)
})

test("la purge exige le nom de la station et une confirmation explicite", () => {
  assert.match(flow, /const canPurge = nameMatches && acknowledged/)
  assert.match(flow, /body: JSON\.stringify\(\{ confirm_name: confirmName \}\)/)
  assert.match(flow, /if \(!canPurge \|\| inFlight\.current\) return/)
  assert.match(flow, /Je comprends que l'effacement est immédiat/)
})

test("une purge réussie quitte la fiche au lieu de recharger une station absente", () => {
  const purge = flow.slice(flow.indexOf("async function purge()"), flow.indexOf("const title ="))

  assert.match(purge, /navigate\("\/console\/stations"/)
  assert.match(purge, /replace: true/)
  assert.doesNotMatch(purge, /onChanged\(/)
  assert.match(stations, /location\.state as \{ notice\?: string \}/)
  assert.match(stations, /role="status"/)
})
