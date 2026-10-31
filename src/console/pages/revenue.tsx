import * as React from "react"
import { Link } from "react-router-dom"
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { AlertTriangle, Clock, Download, Undo2 } from "lucide-react"

import { LoadingSpinner } from "@/components/ui/loading-spinner"

import { consoleRequest, downloadConsoleFile, formatDate, formatFcfa } from "../api"
import { Panel, StatCard } from "../layout"
import { ConsoleWrite } from "../auth"
import type { RevenueEntry, RevenueResponse } from "../types"

/** `2026-03` → `mars 26`, pour un axe lisible sans le surcharger. */
function monthLabel(key: string): string {
  const [year, month] = key.split("-")
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1))
  return date
    .toLocaleDateString("fr-CI", { month: "short", year: "2-digit" })
    .replace(".", "")
}

/** Francs entiers : le FCFA n'a pas de subdivision en usage. */
const toFrancs = (cents: number) => Math.round(cents / 100)

export function ConsoleRevenue() {
  const [data, setData] = React.useState<RevenueResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [reload, setReload] = React.useState(0)

  // Fenêtre d'export, indépendante de la fenêtre du graphique : on exporte
  // souvent un mois clos pendant qu'on regarde l'année.
  const [from, setFrom] = React.useState("")
  const [to, setTo] = React.useState("")
  const [exporting, setExporting] = React.useState<string | null>(null)

  const [reversing, setReversing] = React.useState<RevenueEntry | null>(null)
  const [reason, setReason] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const payload = await consoleRequest<RevenueResponse>("/revenue?months=12")
        if (!cancelled) {
          setData(payload)
          setError(null)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Chargement impossible.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reload])

  async function runExport(format: "detail" | "journal") {
    setExporting(format)
    try {
      const params = new URLSearchParams({ format })
      if (from) params.set("from", from)
      if (to) params.set("to", to)
      await downloadConsoleFile(`/revenue/export?${params}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export impossible.")
    } finally {
      setExporting(null)
    }
  }

  async function confirmReversal() {
    if (!reversing) return
    setBusy(true)
    try {
      await consoleRequest(`/revenue/${reversing.id}/reverse`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      })
      setReversing(null)
      setReason("")
      setReload((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Contrepassation impossible.")
    } finally {
      setBusy(false)
    }
  }

  if (loading && !data) {
    return (
      <div className="flex justify-center py-16" aria-busy="true" role="status">
        <LoadingSpinner />
        <span className="sr-only">Chargement des revenus…</span>
      </div>
    )
  }

  if (error && !data) {
    return (
      <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
        {error}
      </p>
    )
  }
  if (!data) return null

  const chart = data.series.map((m) => ({
    month: monthLabel(m.month),
    encaisse: toFrancs(m.collected_cents),
    reconnu: toFrancs(m.recognized_cents),
  }))

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Encaissé ce mois"
          value={formatFcfa(data.totals.month_collected_cents)}
          hint="Argent réellement reçu"
        />
        <StatCard
          label="Revenu reconnu ce mois"
          value={formatFcfa(data.totals.month_recognized_cents)}
          hint="Part du service effectivement rendu"
        />
        <StatCard
          label="Encaissé d'avance"
          value={formatFcfa(data.totals.deferred_cents)}
          hint="Déjà reçu, pas encore gagné : à rendre en cas de départ"
        />
        <StatCard
          label="Revenu à risque"
          value={formatFcfa(data.totals.at_risk_cents)}
          hint={`${data.at_risk.length} station(s) à échéance dépassée`}
          tone={data.at_risk.length ? "warning" : "default"}
        />
      </div>

      <Panel
        title="Trésorerie et revenu, sur douze mois"
        description="Les barres sont l'argent reçu le mois où il arrive ; la ligne est le même argent étalé sur la période qu'il couvre. Un client qui règle six mois d'avance fait une barre haute suivie de cinq barres vides — la ligne, elle, ne bouge pas."
      >
        <div className="px-2 py-4">
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={70}
                tickFormatter={(v: number) => `${(v / 1000).toLocaleString("fr-FR")} k`}
              />
              <Tooltip
                cursor={{ fill: "rgba(255,255,255,0.04)" }}
                contentStyle={{
                  background: "#0f172a",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 8,
                  fontSize: 12,
                  color: "#e2e8f0",
                }}
                formatter={(value, name) => [
                  `${Number(value ?? 0).toLocaleString("fr-FR")} F`,
                  name === "encaisse" ? "Encaissé" : "Revenu reconnu",
                ]}
              />
              <Bar dataKey="encaisse" fill="#38bdf8" radius={[4, 4, 0, 0]} maxBarSize={28} />
              <Line
                type="monotone"
                dataKey="reconnu"
                stroke="#fbbf24"
                strokeWidth={2}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <Panel
        title="Export comptable"
        description="Le détaillé pour piloter, le journal pour le cabinet. Même registre, deux mises en forme. Sans dates, l'export couvre tout l'historique."
      >
        <div className="flex flex-wrap items-end gap-3 px-4 py-4">
          <label className="text-xs text-slate-400">
            Du
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 block rounded-md border border-white/15 bg-slate-900 px-2 py-1.5 text-sm text-white"
            />
          </label>
          <label className="text-xs text-slate-400">
            Au
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 block rounded-md border border-white/15 bg-slate-900 px-2 py-1.5 text-sm text-white"
            />
          </label>
          <button
            type="button"
            onClick={() => runExport("detail")}
            disabled={exporting !== null}
            className="inline-flex items-center gap-2 rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
          >
            <Download className="size-4" />
            {exporting === "detail" ? "Export…" : "Encaissements (CSV)"}
          </button>
          <button
            type="button"
            onClick={() => runExport("journal")}
            disabled={exporting !== null}
            className="inline-flex items-center gap-2 rounded-md border border-white/15 px-3 py-2 text-sm font-medium text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
          >
            <Download className="size-4" />
            {exporting === "journal" ? "Export…" : "Journal SYSCOHADA"}
          </button>
          <p className="w-full text-xs text-slate-500">
            Le journal est tenu sur la base de l'encaissement, en comptes 7065 / 571 / 521 / 552.
            Le mobile money part en monnaie électronique, jamais en caisse.
          </p>
        </div>
      </Panel>

      {data.at_risk.length > 0 && (
        <Panel
          title="Impayés"
          description="Échéance dépassée et aucun renouvellement. Ces stations travaillent toujours — rien n'est coupé automatiquement — mais ne paient plus."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Station</th>
                  <th className="px-4 py-2 font-medium">Forfait</th>
                  <th className="px-4 py-2 font-medium">Échéance</th>
                  <th className="px-4 py-2 font-medium">Retard</th>
                  <th className="px-4 py-2 text-right font-medium">Mensualité</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {data.at_risk.map((o) => (
                  <tr key={o.organization_id}>
                    <td className="px-4 py-2">
                      <Link
                        to={`/console/stations/${o.organization_id}`}
                        className="text-sky-300 hover:underline"
                      >
                        {o.organization_name}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-slate-300">{o.plan_name}</td>
                    <td className="px-4 py-2 text-slate-400">{formatDate(o.current_period_end)}</td>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-1 text-amber-300">
                        <AlertTriangle className="size-3.5" />
                        {o.days_overdue} j
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-white">
                      {formatFcfa(o.price_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {data.pending.length > 0 && (
        <Panel
          title="Déclarés, non confirmés"
          description="Le client dit avoir payé. Tant que l'argent n'est pas vérifié, il n'entre pas au registre : déclarer n'est pas payer."
          action={
            <Link to="/console/paiements" className="text-xs text-sky-300 hover:underline">
              Ouvrir la file
            </Link>
          }
        >
          <ul className="divide-y divide-white/5">
            {data.pending.map((p) => (
              <li key={p.reference} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <Clock className="size-4 shrink-0 text-amber-300" />
                <span className="font-medium text-white">{p.organization_name}</span>
                <span className="text-slate-400">
                  {p.plan_code} · {p.months} mois · déclaré le {formatDate(p.declared_at)}
                </span>
                <span className="ml-auto font-mono text-xs text-slate-400">{p.reference}</span>
                <span className="tabular-nums text-white">{formatFcfa(p.amount_cents)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel
        title="Derniers encaissements"
        description="Une ligne ne se modifie ni ne se supprime : une erreur se contrepasse, et les deux lignes restent."
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Station</th>
                <th className="px-4 py-2 font-medium">Forfait</th>
                <th className="px-4 py-2 font-medium">Canal</th>
                <th className="px-4 py-2 font-medium">Référence</th>
                <th className="px-4 py-2 text-right font-medium">Montant</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {data.recent.map((r) => {
                const channel = data.channels.find((c) => c.code === r.channel)
                const isReversal = r.reverses_id !== null
                return (
                  <tr key={r.id} className={isReversal ? "text-slate-500" : ""}>
                    <td className="px-4 py-2 whitespace-nowrap">{formatDate(r.occurred_at)}</td>
                    <td className="px-4 py-2">{r.organization_name}</td>
                    <td className="px-4 py-2">
                      {r.plan_name} · {r.months} mois
                    </td>
                    <td className="px-4 py-2 text-slate-400">{channel?.label ?? r.channel}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-400">
                      {r.payment_reference ?? "—"}
                    </td>
                    <td
                      className={`px-4 py-2 text-right tabular-nums ${
                        r.amount_cents < 0 ? "text-rose-300" : "text-white"
                      }`}
                    >
                      {formatFcfa(r.amount_cents)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {!isReversal && r.amount_cents > 0 && (
                        <ConsoleWrite>
                        <button
                          type="button"
                          onClick={() => {
                            setReversing(r)
                            setReason("")
                          }}
                          className="inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-xs text-slate-300 transition-opacity duration-150 hover:opacity-80"
                        >
                          <Undo2 className="size-3" />
                          Contrepasser
                        </button>
                        </ConsoleWrite>
                      )}
                      {isReversal && <span className="text-xs italic">annulation</span>}
                    </td>
                  </tr>
                )
              })}
              {data.recent.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    Aucun encaissement pour l'instant.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      {reversing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-white/10 bg-slate-900 p-5">
            <h3 className="text-sm font-semibold text-white">Contrepasser cet encaissement</h3>
            <p className="mt-2 text-xs text-slate-400">
              {reversing.organization_name} · {formatFcfa(reversing.amount_cents)} ·{" "}
              {formatDate(reversing.occurred_at)}
            </p>
            <p className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              L'écriture d'origine est conservée et une écriture inverse est ajoutée.
              L'abonnement de la station n'est pas touché : pour le couper, il faut suspendre.
            </p>
            <label className="mt-4 block text-xs text-slate-400">
              Motif (10 caractères minimum)
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-md border border-white/15 bg-slate-950 px-3 py-2 text-sm text-white"
                placeholder="Encaissement saisi deux fois"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReversing(null)}
                className="rounded-md border border-white/15 px-3 py-2 text-sm text-slate-300"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={confirmReversal}
                disabled={reason.trim().length < 10 || busy}
                className="rounded-md bg-rose-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? "…" : "Contrepasser"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ConsoleRevenue
