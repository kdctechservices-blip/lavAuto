import test from "node:test"
import assert from "node:assert/strict"
import { createElement as h } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Card, CardContent, CardHeader, CardTitle } from "../src/components/ui/card.tsx"
import { Input } from "../src/components/ui/input.tsx"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../src/components/ui/table.tsx"
import { Textarea } from "../src/components/ui/textarea.tsx"

test("les primitives partagées rendent du HTML natif avec leurs styles shadcn", () => {
  const card = renderToStaticMarkup(
    h(Card, { interactive: true },
      h(CardHeader, null, h(CardTitle, null, "Résumé")),
      h(CardContent, null, "Contenu"),
    ),
  )
  assert.match(card, /<div data-slot="card"[^>]*class="[^"]*rounded-xl/)
  assert.match(card, /<div data-slot="card-header"[^>]*border-b/)
  assert.match(card, /<div data-slot="card-content"[^>]*p-4/)
  assert.doesNotMatch(card, /class="[^"]*card card-/)

  const input = renderToStaticMarkup(h(Input, { type: "email", required: true, "aria-invalid": true }))
  assert.match(input, /^<input type="email" data-slot="input"/)
  assert.match(input, /border-input/)
  assert.match(input, /aria-invalid="true"/)

  const textarea = renderToStaticMarkup(h(Textarea, { rows: 4, placeholder: "Notes" }))
  assert.match(textarea, /^<textarea data-slot="textarea"/)
  assert.match(textarea, /min-h-16/)

  const table = renderToStaticMarkup(
    h(Table, null,
      h(TableHeader, null, h(TableRow, null, h(TableHead, null, "Nom"))),
      h(TableBody, null, h(TableRow, null, h(TableCell, null, "Station"))),
    ),
  )
  assert.match(table, /<div data-slot="table-container"[^>]*><table data-slot="table"/)
  assert.match(table, /<thead data-slot="table-header"/)
  assert.match(table, /<th data-slot="table-head" scope="col"/)
  assert.match(table, /<tbody data-slot="table-body"/)
  assert.match(table, /<td data-slot="table-cell"/)
})
