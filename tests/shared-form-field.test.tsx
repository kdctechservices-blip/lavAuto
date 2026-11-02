import test from "node:test"
import assert from "node:assert/strict"
import { createElement as h } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Dialog, FormField, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../packages/shared-ui/src/index.ts"
import { Input } from "../src/components/ui/input.tsx"

test("le pattern de champ partagé associe label, aide et erreur au contrôle", () => {
  const html = renderToStaticMarkup(
    h(FormField, {
      htmlFor: "operator-email",
      label: "Adresse e-mail",
      required: true,
      description: "Utilisée pour ouvrir une session.",
      error: "Adresse invalide.",
    }, h(Input, { type: "email" })),
  )

  assert.match(html, /<label[^>]*for="operator-email"[^>]*>Adresse e-mail/)
  assert.match(html, /<input type="email"[^>]*id="operator-email"/)
  assert.match(html, /aria-invalid="true"/)
  assert.match(html, /aria-required="true"/)
  assert.match(html, /aria-describedby="operator-email-description operator-email-error"/)
  assert.match(html, /id="operator-email-description"[^>]*>Utilisée pour ouvrir une session\./)
  assert.match(html, /id="operator-email-error"[^>]*role="alert"[^>]*>Adresse invalide\./)
})

test("les primitives de tableau et de dialogue sont exportées par le workspace partagé", () => {
  const table = renderToStaticMarkup(
    h(Table, null,
      h(TableHeader, null, h(TableRow, null, h(TableHead, null, "Opérateur"))),
      h(TableBody, null, h(TableRow, null, h(TableCell, null, "Station"))),
    ),
  )

  assert.equal(typeof Dialog, "function")
  assert.match(table, /data-slot="table-container"/)
  assert.match(table, /data-slot="table-header"/)
  assert.match(table, /data-slot="table-head"/)
  assert.match(table, /data-slot="table-cell"/)
})
