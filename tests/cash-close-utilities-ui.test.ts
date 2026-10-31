import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const pageSource = readFileSync(new URL("../src/app/cash-drawer/page.tsx", import.meta.url), "utf8")
const closingSource = readFileSync(new URL("../src/components/closing-utility-readings.tsx", import.meta.url), "utf8")
const insightsSource = readFileSync(new URL("../src/components/utility-insights.tsx", import.meta.url), "utf8")

test("la clôture affiche les index, le justificatif facultatif et l'aperçu obligatoire", () => {
  assert.match(closingSource, /Relevés quotidiens des compteurs/)
  assert.match(closingSource, /meters\.map/)
  assert.match(closingSource, /index du jour \(\{meta\.unit\}\)/)
  assert.match(closingSource, /required=\{!existing\}/)
  assert.match(closingSource, /aucune facture ni dépense n'est créée à la clôture/i)
  assert.match(closingSource, /capture="environment"/)
  assert.match(closingSource, /Calculer la consommation/)
})

test("la clôture envoie les index et reste bloquée sans aperçu frais ni commentaire requis", () => {
  assert.match(closingSource, /parseUtilityIndex\(indexes\[meter\.id\]/)
  assert.match(closingSource, /\/utility-preview/)
  assert.match(closingSource, /preview\?\.fingerprint === fingerprint/)
  assert.match(closingSource, /commentsComplete/)
  assert.match(pageSource, /utility_readings: closingUtilitySubmission\.readings/)
  assert.match(pageSource, /!closingUtilitySubmission\.canClose/)
})

test("la synthèse expose ratios, moyennes, tendances, alertes et périodes multi-jours", () => {
  assert.match(insightsSource, /\/api\/v1\/utility-insights/)
  assert.match(insightsSource, /daily_average_milli/)
  assert.match(insightsSource, /ratio_trend_percent/)
  assert.match(insightsSource, /formatUtilityRatio/)
  assert.match(insightsSource, /period\.period_days/)
  assert.match(insightsSource, /anomaly_comment/)
  assert.match(insightsSource, /Jour sans lavage/)
  assert.match(insightsSource, /\/photo/)
})
