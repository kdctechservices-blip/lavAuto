import { useState, type FormEvent } from "react"
import { ArrowRight, Building2, KeyRound, Mail, UserRound } from "lucide-react"
import { Link, useNavigate } from "react-router-dom"
import { useAuth } from "@/lib/auth"
import { AuthPageLayout } from "@/components/auth/auth-page-layout"
import {
  AuthField,
  AuthNotice,
  AuthSubmitButton,
  PasswordVisibilityButton,
} from "@/components/auth/auth-form-elements"
import { MIN_PASSWORD_LENGTH } from "@/app/auth/password-policy"

export default function SignUpPage() {
  const { signUp } = useAuth()
  const navigate = useNavigate()
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [organizationName, setOrganizationName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [signedUp, setSignedUp] = useState(false)
  const [error, setError] = useState("")

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")

    const normalizedEmail = email.trim().toLowerCase()
    if (!firstName.trim() || !lastName.trim()) {
      setError("Saisissez votre prénom et votre nom.")
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setError("Saisissez une adresse e-mail valide.")
      return
    }
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
      await signUp({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: normalizedEmail,
        password,
        organizationName: organizationName.trim() || undefined,
      })
      // Workflow : inscription → onboarding (configuration de la station).
      setSignedUp(true)
      navigate("/onboarding", { replace: true })
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "L’inscription a échoué. Réessayez dans un instant.")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <AuthPageLayout
      eyebrow="BIENVENUE SUR WASHPILOT"
      title="Créez le compte de votre station"
      description="Quelques informations suffisent : vous configurerez votre station juste après."
      imageSrc="/images/wash-station.jpg"
      imageAlt="Une station de lavage automobile moderne en Côte d'Ivoire."
      panelTitle="Pilotez votre station en toute sérénité."
      panelDescription="Lavages, caisse, équipe et rapports : tout votre quotidien est centralisé."
      topAction={
        <>
          <span className="hidden sm:inline">Déjà un compte ? </span>
          <Link
            to="/auth/sign-in"
            className="font-bold text-blue-700 underline decoration-blue-200 underline-offset-4 transition-colors hover:text-blue-900 motion-reduce:transition-none"
          >
            Se connecter
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5" noValidate>
        <div className="grid gap-5 sm:grid-cols-2">
          <AuthField
            id="sign-up-first-name"
            label="Prénom"
            icon={UserRound}
            type="text"
            name="given-name"
            autoComplete="given-name"
            placeholder="Awa"
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
            required
            disabled={isSubmitting}
          />
          <AuthField
            id="sign-up-last-name"
            label="Nom"
            icon={UserRound}
            type="text"
            name="family-name"
            autoComplete="family-name"
            placeholder="Kouassi"
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
            required
            disabled={isSubmitting}
          />
        </div>

        <AuthField
          id="sign-up-organization"
          label="Nom de votre station"
          icon={Building2}
          type="text"
          name="organization"
          autoComplete="organization"
          placeholder="Lavage Premium Cocody"
          hint="Facultatif — vous pourrez le préciser pendant la configuration."
          value={organizationName}
          onChange={(event) => setOrganizationName(event.target.value)}
          disabled={isSubmitting}
        />

        <AuthField
          id="sign-up-email"
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
          id="sign-up-password"
          label="Mot de passe"
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
          id="sign-up-confirmation"
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

        <AuthSubmitButton pending={isSubmitting} success={signedUp} successLabel="Compte créé">
          Créer mon compte <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden="true" />
        </AuthSubmitButton>

        <p className="text-center text-[11px] leading-5 text-slate-400">
          En créant un compte, vous acceptez nos conditions d’utilisation. Vos données restent la propriété de votre station.
        </p>
      </form>
    </AuthPageLayout>
  )
}
