import { useState, type FormEvent } from "react"
import { ArrowRight, KeyRound, Mail } from "lucide-react"
import { Link, useNavigate } from "react-router-dom"
import { useAuth } from "@/lib/auth"
import { AuthPageLayout } from "@/components/auth/auth-page-layout"
import {
  AuthField,
  AuthNotice,
  AuthSubmitButton,
  PasswordVisibilityButton,
} from "@/components/auth/auth-form-elements"

const REMEMBERED_EMAIL_KEY = "washpilot.remembered-email"

function getInitialEmail(): string {
  if (typeof window === "undefined") return ""
  try {
    return window.localStorage.getItem(REMEMBERED_EMAIL_KEY) ?? ""
  } catch {
    return ""
  }
}

function persistRememberedEmail(email: string, remember: boolean) {
  try {
    if (remember) window.localStorage.setItem(REMEMBERED_EMAIL_KEY, email)
    else window.localStorage.removeItem(REMEMBERED_EMAIL_KEY)
  } catch {
    // Stockage local indisponible : non bloquant.
  }
}

export default function SignInPage() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState(getInitialEmail)
  const [password, setPassword] = useState("")
  const [rememberMe, setRememberMe] = useState(() => Boolean(getInitialEmail()))
  const [showPassword, setShowPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [error, setError] = useState("")

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")

    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail) {
      setError("Saisissez votre adresse e-mail.")
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setError("Saisissez une adresse e-mail valide.")
      return
    }
    if (!password) {
      setError("Saisissez votre mot de passe.")
      return
    }

    persistRememberedEmail(normalizedEmail, rememberMe)

    setIsSubmitting(true)
    try {
      await signIn(normalizedEmail, password)
      // Coche verte très brève : la connexion a réussi, la page va changer.
      setSignedIn(true)
      navigate("/dashboard", { replace: true })
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "Connexion impossible pour le moment. Réessayez.")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <AuthPageLayout
      eyebrow="RAVI DE VOUS REVOIR"
      title="Connectez-vous à votre espace"
      description="Retrouvez les lavages, l’équipe et les encaissements de votre station au même endroit."
      imageSrc="/images/wash-car.jpg"
      imageAlt="Un professionnel ivoirien nettoie une voiture dans une station de lavage moderne."
      panelTitle="Votre station, à son meilleur."
      panelDescription="Un pilotage plus clair de vos opérations, pour garder le cap et faire grandir votre activité."
      topAction={
        <>
          <span className="hidden sm:inline">Nouveau sur WashPilot ? </span>
          <Link
            to="/auth/sign-up"
            className="font-bold text-blue-700 underline decoration-blue-200 underline-offset-4 transition-colors hover:text-blue-900 motion-reduce:transition-none"
          >
            Créer un compte
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <AuthField
          id="sign-in-email"
          label="Adresse e-mail"
          icon={Mail}
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          placeholder="vous@votrestation.ci"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          disabled={isSubmitting}
        />

        <AuthField
          id="sign-in-password"
          label="Mot de passe"
          labelTrailing={
            <Link
              to="/auth/forgot-password"
              className="text-xs font-semibold text-blue-700 transition-colors hover:text-blue-900 hover:underline hover:underline-offset-4 motion-reduce:transition-none"
            >
              Mot de passe oublié ?
            </Link>
          }
          icon={KeyRound}
          type={showPassword ? "text" : "password"}
          name="password"
          autoComplete="current-password"
          placeholder="Saisissez votre mot de passe"
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

        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg py-0.5 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(event) => setRememberMe(event.target.checked)}
            className="mt-0.5 size-4 rounded border-slate-300 accent-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
          />
          <span>
            <span className="block font-semibold text-slate-700">Se souvenir de moi</span>
            <span className="mt-0.5 block text-[11px] text-slate-400">Garder mon adresse e-mail sur cet appareil</span>
          </span>
        </label>

        {error ? <AuthNotice>{error}</AuthNotice> : null}

        <AuthSubmitButton pending={isSubmitting} success={signedIn} successLabel="Connexion réussie">
          Se connecter <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
        </AuthSubmitButton>
      </form>
    </AuthPageLayout>
  )
}
