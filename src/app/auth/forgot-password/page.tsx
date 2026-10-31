import { useState, type FormEvent } from "react"
import { ArrowLeft, ArrowRight, Mail } from "lucide-react"
import { Link } from "react-router-dom"
import { AuthPageLayout } from "@/components/auth/auth-page-layout"
import {
  AuthField,
  AuthNotice,
  AuthSubmitButton,
} from "@/components/auth/auth-form-elements"
import { apiErrorMessage, apiFetch } from "@/lib/api"

interface ForgotPasswordResponse {
  ok: boolean
  message: string
  delivery: "email" | "manual"
  /** Renvoyé hors production uniquement, quand aucun service d'e-mail n'est configuré. */
  reset_url?: string
}

/**
 * Demande de réinitialisation : l'adresse est envoyée à
 * POST /api/v1/auth/forgot-password. Le serveur répond toujours de la même
 * manière (aucune énumération de comptes) et envoie un lien à usage unique.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<ForgotPasswordResponse | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")

    const normalizedEmail = email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setError("Saisissez une adresse e-mail valide.")
      return
    }

    setIsSubmitting(true)
    try {
      const response = await apiFetch("/api/v1/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email: normalizedEmail }),
      })
      if (!response.ok) throw new Error(await apiErrorMessage(response))
      setResult((await response.json()) as ForgotPasswordResponse)
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Demande impossible pour le moment. Réessayez dans un instant.",
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <AuthPageLayout
      eyebrow="MOT DE PASSE OUBLIÉ"
      title="Réinitialiser votre accès"
      description="Saisissez l'adresse e-mail de votre compte : nous vous envoyons un lien sécurisé pour choisir un nouveau mot de passe."
      imageSrc="/images/wash-car.jpg"
      imageAlt="Un professionnel ivoirien nettoie une voiture dans une station de lavage moderne."
      panelTitle="Votre station, à son meilleur."
      panelDescription="Un pilotage plus clair de vos opérations, pour garder le cap et faire grandir votre activité."
      topAction={
        <Link
          to="/auth/sign-in"
          className="flex items-center gap-1.5 font-bold text-blue-700 transition-colors hover:text-blue-900"
        >
          <ArrowLeft className="size-4" /> Retour à la connexion
        </Link>
      }
    >
      {result ? (
        <div className="space-y-5">
          <AuthNotice tone="success">
            <strong>Demande enregistrée.</strong> {result.message}
          </AuthNotice>

          {result.reset_url ? (
            <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-xs font-semibold text-amber-900">
                Environnement sans service d'e-mail : lien de réinitialisation direct
              </p>
              <a
                href={result.reset_url}
                className="block break-all rounded-lg bg-white px-3 py-2 text-xs font-medium text-blue-700 underline underline-offset-2"
              >
                {result.reset_url}
              </a>
              <p className="text-[11px] leading-4 text-amber-800">
                Ce lien n'est affiché qu'en développement. En production, il est transmis
                uniquement par e-mail.
              </p>
            </div>
          ) : (
            <p className="text-xs leading-5 text-slate-500">
              Le lien reste valable une heure et ne peut servir qu'une seule fois. Sans
              e-mail reçu au bout de quelques minutes, vérifiez vos indésirables ou
              réessayez avec une autre adresse.
            </p>
          )}

          <button
            type="button"
            onClick={() => {
              setResult(null)
              setEmail("")
            }}
            className="text-xs font-semibold text-blue-700 transition-colors hover:text-blue-900 hover:underline hover:underline-offset-4"
          >
            Utiliser une autre adresse e-mail
          </button>

          <Link
            to="/auth/sign-in"
            className="flex h-[50px] w-full items-center justify-center gap-2 rounded-xl bg-[#123d79] px-5 text-sm font-bold text-white shadow-lg shadow-blue-900/15 transition hover:bg-[#0d3268]"
          >
            <ArrowLeft className="size-4" /> Revenir à la connexion
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          <AuthField
            id="forgot-password-email"
            label="Adresse e-mail"
            icon={Mail}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            placeholder="vous@votrestation.ci"
            hint="Nous n'indiquons jamais si une adresse possède un compte."
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            disabled={isSubmitting}
          />

          {error ? <AuthNotice>{error}</AuthNotice> : null}

          <AuthSubmitButton pending={isSubmitting}>
            Envoyer le lien de réinitialisation{" "}
            <ArrowRight
              className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </AuthSubmitButton>

          <p className="text-center text-[11px] leading-5 text-slate-400">
            Vous vous souvenez de votre mot de passe ?{" "}
            <Link
              to="/auth/sign-in"
              className="font-semibold text-blue-700 hover:text-blue-900 hover:underline hover:underline-offset-4"
            >
              Se connecter
            </Link>
          </p>
        </form>
      )}
    </AuthPageLayout>
  )
}
