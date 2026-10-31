import * as React from "react"

import { BrandMark } from "@/components/brand"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { LoadingSpinner } from "@/components/ui/loading-spinner"

import { useConsoleAuth } from "./auth"

/**
 * Connexion à la console.
 *
 * Délibérément sobre et sans lien de retour vers l'application cliente : rien
 * n'indique à un visiteur égaré qu'il existe un rapport entre cette page et
 * WashPilot CI côté station. Pas d'inscription, pas de « mot de passe
 * oublié » non plus — un compte d'administration se crée par la
 * configuration du serveur, pas par un formulaire.
 */
export function ConsoleLogin() {
  const { signIn } = useConsoleAuth()
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await signIn(email.trim(), password)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connexion impossible.")
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-slate-950 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <BrandMark height={44} tone="dark" />
          <div>
            <h1 className="text-lg font-semibold text-white">Console d'administration</h1>
            <p className="mt-1 text-sm text-slate-400">Réservée à l'équipe WashPilot CI.</p>
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur"
        >
          <div className="space-y-2">
            <Label htmlFor="console-email" className="text-slate-200">
              Adresse e-mail
            </Label>
            <Input
              id="console-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="border-white/15 bg-slate-900/60 text-white placeholder:text-slate-500"
              placeholder="vous@washpilot.ci"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="console-password" className="text-slate-200">
              Mot de passe
            </Label>
            <Input
              id="console-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="border-white/15 bg-slate-900/60 text-white"
            />
          </div>

          {error && (
            <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={busy} aria-busy={busy}>
            {busy ? <LoadingSpinner className="size-4" /> : "Se connecter"}
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-slate-500">
          Cette console n'est pas accessible depuis un compte de station.
        </p>
      </div>
    </main>
  )
}

export default ConsoleLogin
