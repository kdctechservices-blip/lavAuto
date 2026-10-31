import { useEffect, useState, type FormEvent } from "react"
import { ArrowLeft, ArrowRight, KeyRound } from "lucide-react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { AuthPageLayout } from "@/components/auth/auth-page-layout"
import {
  AuthField,
  AuthNotice,
  AuthSubmitButton,
  PasswordVisibilityButton,
} from "@/components/auth/auth-form-elements"
import { MIN_PASSWORD_LENGTH } from "@/app/auth/password-policy"
import { apiErrorMessage, apiFetch, API_BASE_URL } from "@/lib/api"

type TokenState = "checking" | "valid" | "invalid"

/**
 * Choix d'un nouveau mot de passe à partir du lien reçu par e-mail.
 * Le jeton est vérifié à l'affichage (GET) puis consommé à l'envoi (POST) :
 * il est à usage unique et toutes les sessions ouvertes sont révoquées.
 */
export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get("token") ?? ""

  // Sans jeton dans l'URL, inutile d'interroger l'API : le lien est invalide.
  const [tokenState, setTokenState] = useState<TokenState>(token ? "checking" : "invalid")
  const [password, setPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState(false)

  // Vérifie la validité du lien avant d'afficher le formulaire.
  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    ;(async () => {
      try {
        const response = await fetch(
          `${API_BASE_URL}/api/v1/auth/reset-password?token=${encodeURIComponent(token)}`,
          { headers: { Accept: "application/json" }, signal: controller.signal },
        )
        if (controller.signal.aborted) return
        const payload = response.ok
          ? ((await response.json()) as { valid?: boolean })
          : { valid: false }
        setTokenState(payload.valid ? "valid" : "invalid")
      } catch {
        if (!controller.signal.aborted) setTokenState("invalid")
      }
    })()
    return () => controller.abort()
  }, [token])

  // Redirection automatique vers la connexion après succès.
  useEffect(() => {
    if (!success) return
    const timer = window.setTimeout(() => navigate("/auth/sign-in", { replace: true }), 4000)
    return () => window.clearTimeout(timer)
  }, [success, navigate])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`)
      return
    }
    if (password !== confirmation) {
      setError("La confirmation ne correspond pas au mot de passe.")
      return
    }

    setIsSubmitting(true)
    try {
      const response = await apiFetch("/api/v1/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      })
      if (!response.ok) throw new Error(await apiErrorMessage(response))
      setSuccess(true)
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Réinitialisation impossible pour le moment. Réessayez.",
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <AuthPageLayout
      eyebrow="NOUVEAU MOT DE PASSE"
      title="Choisissez un nouveau mot de passe"
      description="Votre lien est valable une heure et ne peut servir qu'une seule fois. Les sessions ouvertes seront déconnectées."
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
      {success ? (
        <div className="space-y-5">
          <AuthNotice tone="success">
            <strong>Mot de passe mis à jour.</strong> Connectez-vous avec votre nouveau mot
            de passe. Redirection automatique dans quelques secondes…
          </AuthNotice>
          <Link
            to="/auth/sign-in"
            className="flex h-[50px] w-full items-center justify-center gap-2 rounded-xl bg-[#123d79] px-5 text-sm font-bold text-white shadow-lg shadow-blue-900/15 transition hover:bg-[#0d3268]"
          >
            Se connecter <ArrowRight className="size-4" />
          </Link>
        </div>
      ) : tokenState === "checking" ? (
        <div className="space-y-4" role="status" aria-live="polite">
          <div className="h-[50px] animate-pulse rounded-xl bg-slate-100" />
          <div className="h-[50px] animate-pulse rounded-xl bg-slate-100" />
          <p className="text-xs text-slate-400">Vérification de votre lien…</p>
        </div>
      ) : tokenState === "invalid" ? (
        <div className="space-y-5">
          <AuthNotice>
            <strong>Lien invalide ou expiré.</strong> Les liens de réinitialisation
            expirent au bout d'une heure et ne fonctionnent qu'une seule fois.
          </AuthNotice>
          <Link
            to="/auth/forgot-password"
            className="flex h-[50px] w-full items-center justify-center gap-2 rounded-xl bg-[#123d79] px-5 text-sm font-bold text-white shadow-lg shadow-blue-900/15 transition hover:bg-[#0d3268]"
          >
            Demander un nouveau lien <ArrowRight className="size-4" />
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          <AuthField
            id="reset-password"
            label="Nouveau mot de passe"
            icon={KeyRound}
            type={showPassword ? "text" : "password"}
            name="new-password"
            autoComplete="new-password"
            placeholder={`${MIN_PASSWORD_LENGTH} caractères minimum`}
            hint={`Au moins ${MIN_PASSWORD_LENGTH} caractères.`}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            disabled={isSubmitting}
            trailing={
              <PasswordVisibilityButton
                visible={showPassword}
                onToggle={() => setShowPassword((visible) => !visible)}
                label="le mot de passe"
              />
            }
          />

          <AuthField
            id="reset-password-confirmation"
            label="Confirmez le mot de passe"
            icon={KeyRound}
            type={showConfirmation ? "text" : "password"}
            name="confirm-password"
            autoComplete="new-password"
            placeholder="Répétez le mot de passe"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            required
            disabled={isSubmitting}
            trailing={
              <PasswordVisibilityButton
                visible={showConfirmation}
                onToggle={() => setShowConfirmation((visible) => !visible)}
                label="la confirmation"
              />
            }
          />

          {error ? <AuthNotice>{error}</AuthNotice> : null}

          <AuthSubmitButton pending={isSubmitting}>
            Enregistrer le nouveau mot de passe{" "}
            <ArrowRight
              className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </AuthSubmitButton>
        </form>
      )}
    </AuthPageLayout>
  )
}
