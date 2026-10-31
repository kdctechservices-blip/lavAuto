import { env } from "./env.ts"

/**
 * Transport e-mail minimaliste.
 *
 * - Si `RESEND_API_KEY` est défini, le message part via l'API HTTP de Resend
 *   (aucune dépendance npm : `fetch` natif suffit).
 * - Sinon, le message est journalisé côté serveur. L'application reste
 *   fonctionnelle en développement sans configurer de fournisseur e-mail.
 */

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

export function isMailerConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY)
}

export async function sendMail(message: MailMessage): Promise<boolean> {
  if (!isMailerConfigured()) {
    console.info(
      `[mail] Aucun fournisseur configuré (RESEND_API_KEY absent). Message non envoyé à ${message.to} — sujet : ${message.subject}`,
    )
    console.info(`[mail] Contenu :\n${message.text}`)
    return false
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      console.error(`[mail] Envoi refusé par Resend (${response.status}) : ${detail.slice(0, 500)}`)
      return false
    }
    return true
  } catch (error) {
    console.error(
      "[mail] Envoi impossible :",
      error instanceof Error ? error.message : "erreur inconnue",
    )
    return false
  }
}

/** Gabarit du message de réinitialisation de mot de passe (texte + HTML). */
export function passwordResetMessage(to: string, resetUrl: string, ttlMinutes: number): MailMessage {
  const validity =
    ttlMinutes >= 60
      ? `${Math.round(ttlMinutes / 60)} heure${ttlMinutes >= 120 ? "s" : ""}`
      : `${ttlMinutes} minutes`

  const text = [
    "Bonjour,",
    "",
    "Vous avez demandé la réinitialisation du mot de passe de votre compte WashPilot CI.",
    `Ouvrez le lien ci-dessous pour choisir un nouveau mot de passe (valable ${validity}) :`,
    "",
    resetUrl,
    "",
    "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.",
    "",
    "— L'équipe WashPilot CI",
  ].join("\n")

  const html = `<!doctype html>
<html lang="fr"><body style="margin:0;background:#f1f5f9;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
  <table role="presentation" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px">
    <tr><td>
      <p style="margin:0 0 16px;font-size:14px">Bonjour,</p>
      <p style="margin:0 0 16px;font-size:14px;line-height:22px">
        Vous avez demandé la réinitialisation du mot de passe de votre compte <strong>WashPilot CI</strong>.
        Le lien ci-dessous est valable <strong>${validity}</strong> et ne peut servir qu'une seule fois.
      </p>
      <p style="margin:24px 0">
        <a href="${resetUrl}" style="display:inline-block;background:#123d79;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:14px 22px;border-radius:12px">
          Choisir un nouveau mot de passe
        </a>
      </p>
      <p style="margin:0 0 16px;font-size:12px;color:#64748b;word-break:break-all">${resetUrl}</p>
      <p style="margin:0;font-size:12px;color:#64748b;line-height:20px">
        Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe reste inchangé.
      </p>
    </td></tr>
  </table>
</body></html>`

  return {
    to,
    subject: "Réinitialisation de votre mot de passe WashPilot CI",
    text,
    html,
  }
}

// ---------------------------------------------------------------------------
// Relances d'échéance d'abonnement
// ---------------------------------------------------------------------------

export interface TrialReminderContext {
  to: string
  firstName?: string | null
  organizationName: string
  daysRemaining: number
  trialEndsAt: string | null
  billingUrl: string
}

function formatDay(iso: string | null): string {
  if (!iso) return "prochainement"
  return new Date(iso).toLocaleDateString("fr-CI", { day: "2-digit", month: "long", year: "numeric" })
}

/** Gabarit d'une relance d'essai (J-3, J-1 ou essai terminé). */
export function trialReminderMessage(
  kind: "trial_j3" | "trial_j1" | "trial_expired",
  context: TrialReminderContext,
): MailMessage {
  const greeting = context.firstName ? `Bonjour ${context.firstName},` : "Bonjour,"
  const endDay = formatDay(context.trialEndsAt)

  const copy = {
    trial_j3: {
      subject: `Il vous reste ${context.daysRemaining} jours d'essai WashPilot CI`,
      headline: `Votre essai gratuit se termine le ${endDay}.`,
      body: `Votre station ${context.organizationName} utilise WashPilot CI en essai gratuit. Passé cette date, votre espace restera consultable, mais vous ne pourrez plus enregistrer de lavages, de dépenses ni d'opérations de caisse.`,
      cta: "Choisir un forfait",
    },
    trial_j1: {
      subject: "Dernier jour d'essai WashPilot CI",
      headline: `Votre essai gratuit se termine demain (${endDay}).`,
      body: `Pour que votre équipe continue d'enregistrer les lavages de ${context.organizationName} sans interruption, activez un forfait dès aujourd'hui.`,
      cta: "Activer un forfait",
    },
    trial_expired: {
      subject: "Votre essai WashPilot CI est terminé",
      headline: "Votre espace est passé en lecture seule.",
      body: `L'essai gratuit de ${context.organizationName} est arrivé à échéance. Toutes vos données restent disponibles et consultables : activez un forfait pour reprendre les enregistrements.`,
      cta: "Réactiver mon espace",
    },
  }[kind]

  const text = [
    greeting,
    "",
    copy.headline,
    "",
    copy.body,
    "",
    `${copy.cta} : ${context.billingUrl}`,
    "",
    "— L'équipe WashPilot CI",
  ].join("\n")

  const html = `<!doctype html>
<html lang="fr"><body style="margin:0;background:#f1f5f9;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
  <table role="presentation" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px">
    <tr><td>
      <p style="margin:0 0 16px;font-size:14px">${greeting}</p>
      <p style="margin:0 0 12px;font-size:18px;font-weight:700">${copy.headline}</p>
      <p style="margin:0 0 16px;font-size:14px;line-height:22px">${copy.body}</p>
      <p style="margin:24px 0">
        <a href="${context.billingUrl}" style="display:inline-block;background:#123d79;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:14px 22px;border-radius:12px">${copy.cta}</a>
      </p>
      <p style="margin:0;font-size:12px;color:#64748b;line-height:20px">
        Vos données restent conservées et exportables à tout moment depuis Paramètres &gt; Données et sauvegarde.
      </p>
    </td></tr>
  </table>
</body></html>`

  return { to: context.to, subject: copy.subject, text, html }
}

/**
 * Relance d'échéance d'un forfait payant.
 *
 * Distincte des relances d'essai, et le ton doit l'être aussi : on ne
 * convainc pas un client qui paie déjà, on lui évite une interruption. Le
 * rail mobile money ne permet pas de prélèvement récurrent fiable, donc ce
 * courriel **est** le mécanisme de renouvellement — pas un simple rappel.
 */
export function renewalReminderMessage(
  kind: "renewal_j7" | "renewal_j3" | "renewal_j1" | "renewal_overdue",
  context: {
    to: string
    firstName?: string | null
    organizationName: string
    planName: string
    periodEnd: string | null
    billingUrl: string
  },
): MailMessage {
  const greeting = context.firstName ? `Bonjour ${context.firstName},` : "Bonjour,"
  const endDay = formatDay(context.periodEnd)

  const copy = {
    renewal_j7: {
      subject: `Votre forfait ${context.planName} arrive à échéance le ${endDay}`,
      headline: `Votre abonnement se termine le ${endDay}.`,
      body: `Le forfait ${context.planName} de ${context.organizationName} arrive à échéance dans une semaine. Renouvelez dès maintenant : les jours restants ne sont pas perdus, ils s'ajoutent à la nouvelle période.`,
      cta: "Renouveler mon forfait",
    },
    renewal_j3: {
      subject: `Plus que 3 jours — forfait ${context.planName}`,
      headline: `Votre abonnement se termine le ${endDay}.`,
      body: `Pour que ${context.organizationName} continue sans interruption, renouvelez votre forfait ${context.planName}. Le paiement se fait par mobile money, en quelques minutes.`,
      cta: "Renouveler maintenant",
    },
    renewal_j1: {
      subject: `Dernier jour — forfait ${context.planName}`,
      headline: `Votre abonnement se termine demain (${endDay}).`,
      body: `Renouvelez aujourd'hui pour éviter toute coupure sur ${context.organizationName}. Vos données restent évidemment conservées dans tous les cas.`,
      cta: "Renouveler aujourd'hui",
    },
    renewal_overdue: {
      subject: `Forfait ${context.planName} : échéance dépassée`,
      headline: `Votre abonnement a expiré le ${endDay}.`,
      body: `Votre accès à ${context.organizationName} n'a pas été interrompu, mais votre forfait ${context.planName} n'est plus à jour. Merci de régulariser pour que le service continue.`,
      cta: "Régulariser mon abonnement",
    },
  }[kind]

  const text = [
    greeting,
    "",
    copy.headline,
    "",
    copy.body,
    "",
    `${copy.cta} : ${context.billingUrl}`,
    "",
    "— L'équipe WashPilot CI",
  ].join("\n")

  const html = `<!doctype html>
<html lang="fr"><body style="margin:0;background:#f1f5f9;padding:24px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">
  <table role="presentation" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px">
    <tr><td>
      <p style="margin:0 0 16px;font-size:14px">${greeting}</p>
      <p style="margin:0 0 12px;font-size:18px;font-weight:700">${copy.headline}</p>
      <p style="margin:0 0 16px;font-size:14px;line-height:22px">${copy.body}</p>
      <p style="margin:24px 0">
        <a href="${context.billingUrl}" style="display:inline-block;background:#123d79;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:14px 22px;border-radius:12px">${copy.cta}</a>
      </p>
      <p style="margin:0;font-size:12px;color:#64748b;line-height:20px">
        Vos donnees restent conservees et exportables a tout moment depuis Parametres &gt; Donnees et sauvegarde.
      </p>
    </td></tr>
  </table>
</body></html>`

  return { to: context.to, subject: copy.subject, text, html }
}

/** Prévient le demandeur qu'une réponse publique l'attend dans l'application. */
export function supportReplyMessage(context: {
  to: string
  firstName?: string | null
  organizationName: string
  requestSubject: string
  supportUrl: string
}): MailMessage {
  const greeting = context.firstName ? `Bonjour ${context.firstName},` : "Bonjour,"
  const text = [
    greeting,
    "",
    `L'équipe WashPilot CI a répondu à votre demande « ${context.requestSubject} » pour ${context.organizationName}.`,
    "",
    `Lire la réponse : ${context.supportUrl}`,
    "",
    "Ce message concerne uniquement une réponse publique de l'assistance.",
    "",
    "— L'équipe WashPilot CI",
  ].join("\n")
  return {
    to: context.to,
    subject: `Réponse de l'assistance — ${context.requestSubject}`,
    text,
  }
}

/** Gabarit envoyé à l'assistance quand une station demande un forfait payant. */
export function upgradeRequestMessage(context: {
  to: string
  organizationName: string
  planName: string
  requesterEmail: string
  requesterName: string
  phone?: string | null
  note?: string | null
}): MailMessage {
  const text = [
    `Nouvelle demande de forfait : ${context.planName}`,
    "",
    `Station : ${context.organizationName}`,
    `Demandeur : ${context.requesterName} (${context.requesterEmail})`,
    `Téléphone : ${context.phone || "non renseigné"}`,
    context.note ? `Message : ${context.note}` : "",
    "",
    "— WashPilot CI",
  ]
    .filter(Boolean)
    .join("\n")

  return {
    to: context.to,
    subject: `Demande de forfait ${context.planName} — ${context.organizationName}`,
    text,
  }
}
