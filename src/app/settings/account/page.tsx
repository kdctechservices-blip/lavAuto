import { useState, type FormEvent } from "react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ThemeSegmentedControl } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuth } from "@/lib/auth"
import { apiFetch, apiErrorMessage } from "@/lib/api"
import { MIN_PASSWORD_LENGTH } from "@/app/auth/password-policy"

export default function AccountSettings() {
  const { user, refresh } = useAuth()
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [phone, setPhone] = useState("")
  const [profileStatus, setProfileStatus] = useState<{ tone: "success" | "error"; message: string } | null>(null)
  const [profileSaving, setProfileSaving] = useState(false)

  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [passwordStatus, setPasswordStatus] = useState<{ tone: "success" | "error"; message: string } | null>(null)
  const [passwordSaving, setPasswordSaving] = useState(false)

  // Ajustement d'état pendant le rendu (pattern React recommandé) : quand
  // l'utilisateur chargé change, on resynchronise les champs du formulaire.
  const [syncedUserId, setSyncedUserId] = useState<string | null>(null)
  if (user && user.id !== syncedUserId) {
    setSyncedUserId(user.id)
    setFirstName(user.firstName ?? "")
    setLastName(user.lastName ?? "")
    setPhone(user.phone ?? "")
  }

  async function handleProfileSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setProfileStatus(null)
    setProfileSaving(true)
    try {
      const response = await apiFetch("/api/v1/auth/profile", {
        method: "PATCH",
        body: JSON.stringify({
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
          phone: phone.trim() || null,
        }),
      })
      if (!response.ok) throw new Error(await apiErrorMessage(response))
      await refresh()
      setProfileStatus({ tone: "success", message: "Profil mis à jour." })
    } catch (error) {
      setProfileStatus({ tone: "error", message: error instanceof Error ? error.message : "La mise à jour a échoué." })
    } finally {
      setProfileSaving(false)
    }
  }

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPasswordStatus(null)
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setPasswordStatus({ tone: "error", message: `Le nouveau mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.` })
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordStatus({ tone: "error", message: "La confirmation ne correspond pas au nouveau mot de passe." })
      return
    }
    setPasswordSaving(true)
    try {
      const response = await apiFetch("/api/v1/auth/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      if (!response.ok) throw new Error(await apiErrorMessage(response))
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
      setPasswordStatus({ tone: "success", message: "Mot de passe modifié. Vos autres sessions ont été déconnectées." })
    } catch (error) {
      setPasswordStatus({ tone: "error", message: error instanceof Error ? error.message : "Le changement de mot de passe a échoué." })
    } finally {
      setPasswordSaving(false)
    }
  }

  return (
    <BaseLayout>
      <div className="flex flex-col gap-6 px-4 lg:px-6">
        <div>
          <h1 className="text-3xl font-bold">Mon compte</h1>
          <p className="text-muted-foreground">
            Gérez vos informations personnelles, votre mot de passe et
            l’apparence de l’interface.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Apparence</CardTitle>
            <CardDescription>
              Ce réglage est enregistré sur cet appareil. « Système » suit le
              réglage de votre téléphone ou de votre ordinateur, y compris
              lorsqu’il bascule automatiquement le soir.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ThemeSegmentedControl />
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Informations personnelles</CardTitle>
              <CardDescription>Votre adresse e-mail de connexion : {user?.email}</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleProfileSubmit} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="account-first-name">Prénom</Label>
                    <Input
                      id="account-first-name"
                      value={firstName}
                      onChange={(event) => setFirstName(event.target.value)}
                      autoComplete="given-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="account-last-name">Nom</Label>
                    <Input
                      id="account-last-name"
                      value={lastName}
                      onChange={(event) => setLastName(event.target.value)}
                      autoComplete="family-name"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="account-phone">Téléphone</Label>
                  <Input
                    id="account-phone"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    autoComplete="tel"
                    placeholder="+225 07 00 00 00 00"
                  />
                </div>
                {profileStatus ? (
                  <p className={profileStatus.tone === "success" ? "text-sm text-emerald-600" : "text-sm text-destructive"}>
                    {profileStatus.message}
                  </p>
                ) : null}
                <Button type="submit" disabled={profileSaving}>
                  {profileSaving ? "Enregistrement…" : "Enregistrer"}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Mot de passe</CardTitle>
              <CardDescription>
                Changer votre mot de passe déconnecte vos autres appareils.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handlePasswordSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="account-current-password">Mot de passe actuel</Label>
                  <Input
                    id="account-current-password"
                    type="password"
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="account-new-password">Nouveau mot de passe</Label>
                  <Input
                    id="account-new-password"
                    type="password"
                    value={newPassword}
                    onChange={(event) => setNewPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="account-confirm-password">Confirmez le nouveau mot de passe</Label>
                  <Input
                    id="account-confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </div>
                {passwordStatus ? (
                  <p className={passwordStatus.tone === "success" ? "text-sm text-emerald-600" : "text-sm text-destructive"}>
                    {passwordStatus.message}
                  </p>
                ) : null}
                <Button type="submit" disabled={passwordSaving}>
                  {passwordSaving ? "Modification…" : "Changer le mot de passe"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </BaseLayout>
  )
}
