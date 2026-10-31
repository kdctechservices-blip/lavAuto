import { z } from "zod"

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().trim().optional().default(""),
  /**
   * Autorité de certification à faire confiance pour la connexion externe.
   * Chemin d'un fichier (`.crt`) ou contenu PEM, `\n` littéraux acceptés.
   *
   * Nécessaire quand l'hébergeur signe ses connexions avec sa propre AC —
   * Supabase, par exemple, avec `prod-ca-2021.crt`. Sans elle, `pg` refuse le
   * certificat (« self-signed certificate in certificate chain ») et le
   * serveur bascule sur la base embarquée. Vide : seules les autorités
   * publiques sont acceptées (Supabase et autres services PostgreSQL managés).
   */
  DATABASE_SSL_CA: z.string().trim().optional().default(""),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * Dossier de la base PostgreSQL embarquée (PGlite), utilisée quand
   * `DATABASE_URL` est vide ou injoignable.
   *
   * Vide (défaut) : les données sont écrites dans `.data/pglite` et
   * survivent au redémarrage. La valeur `:memory:` demande explicitement une
   * base volatile, par exemple pour une démonstration jetable. En
   * `NODE_ENV=test`, la base est toujours en mémoire quelle que soit cette
   * variable, pour que deux fichiers de tests ne se contaminent pas.
   */
  PGLITE_DATA_DIR: z.string().trim().optional().default(""),
  CORS_ORIGINS: z.string().optional().default("http://localhost:5173"),
  /** URL publique de l'application, utilisée pour construire les liens e-mail. */
  APP_URL: z.string().trim().optional().default(""),
  /** Durée de validité d'un lien de réinitialisation de mot de passe. */
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  /**
   * Durée de l'essai gratuit offert à l'inscription, en jours.
   *
   * 14 par défaut. Le plancher à 1 interdit l'essai de zéro jour, qui
   * afficherait « essayez gratuitement » à un visiteur déjà expiré. Le
   * plafond à 90 interdit l'essai perpétuel : un produit qu'on n'achète
   * jamais n'est pas un produit. La vitrine annonce cette même valeur,
   * qu'elle lit sur l'API — elle n'est donc jamais démentie par la réalité.
   */
  TRIAL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  /** Transport e-mail (Resend). Sans clé, les liens sont journalisés côté serveur. */
  RESEND_API_KEY: z.string().trim().optional().default(""),
  MAIL_FROM: z.string().trim().optional().default("WashPilot CI <onboarding@resend.dev>"),
  /** Numéro WhatsApp de l'assistance, au format international (ex. +2250700000000). */
  // --- Encaissement des abonnements ---------------------------------------
  // `manual` : aucun contrat marchand, l'editeur valide depuis le back-office.
  // Un code d'agregateur (ex. `cinetpay`) bascule l'activation en automatique.
  PAYMENT_PROVIDER: z.string().trim().toLowerCase().default("manual"),
  // Numero marchand mobile money affiche au client en mode manuel.
  PAYMENT_MERCHANT_NUMBER: z.string().trim().optional().default(""),
  PAYMENT_MERCHANT_NAME: z.string().trim().optional().default(""),
  SUPPORT_WHATSAPP: z.string().trim().optional().default(""),
  /** Adresse e-mail de l'assistance, affichée en second recours. */
  SUPPORT_EMAIL: z.string().trim().optional().default("support@washpilot.ci"),
  /** Relances automatiques d'échéance d'abonnement (désactivables en test). */
  REMINDERS_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("true")
    .transform((value) => value === "true"),
  /** Intervalle entre deux passages du planificateur de relances, en minutes. */
  REMINDERS_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  /** Fréquence d'évaluation des alertes de supervision (seuils réglés en Console). */
  MONITORING_ALERT_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(60).default(5),
  /** WhatsApp Cloud API : les alertes proactives exigent un modèle approuvé. */
  WHATSAPP_ACCESS_TOKEN: z.string().trim().optional().default(""),
  WHATSAPP_PHONE_NUMBER_ID: z.string().trim().optional().default(""),
  WHATSAPP_API_VERSION: z.string().trim().regex(/^v\d+\.\d+$/).default("v22.0"),
  WHATSAPP_ALERT_TEMPLATE: z.string().trim().optional().default(""),
  WHATSAPP_ALERT_TEMPLATE_LANGUAGE: z.string().trim().optional().default("fr"),
  /** Relevé d'agrégateur lu périodiquement, sans activer les paiements en ligne. */
  RECONCILIATION_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("false")
    .transform((value) => value === "true"),
  RECONCILIATION_PROVIDER: z.string().trim().toLowerCase().optional().default(""),
  RECONCILIATION_STATEMENT_URL: z.string().trim().optional().default(""),
  RECONCILIATION_STATEMENT_TOKEN: z.string().trim().optional().default(""),
  RECONCILIATION_LOOKBACK_HOURS: z.coerce.number().int().min(1).max(24 * 31).default(24),
  /**
   * Adresses d'amorçage des administrateurs de plateforme, séparées par des
   * virgules. Elles créent/réactivent les comptes `bootstrap` au démarrage.
   * Les comptes gérés depuis la Console (`managed_by = 'console'`) sont
   * volontairement ignorés : leur cycle de vie ne dépend plus de cette liste.
   * Aucun compte de station ne peut obtenir ce droit par ses propres routes.
   */
  PLATFORM_ADMIN_EMAILS: z.string().trim().optional().default(""),

  /**
   * Mot de passe initial des comptes de la console.
   *
   * N'est lu qu'à la création d'un opérateur : changer cette variable ne
   * réécrit jamais un mot de passe existant. Si elle est vide, un secret
   * aléatoire est tiré et affiché une seule fois dans les journaux de
   * démarrage.
   */
  PLATFORM_ADMIN_PASSWORD: z.string().optional().default(""),

  /**
   * Jeu de démonstration (station « Cocody Riviera », comptes @washpilot.ci).
   *
   * Actif par défaut en développement et en test, où il donne des données
   * lisibles immédiatement. Jamais en production. `false` sur une base réelle :
   * sans cela, effacer les comptes serait inutile — le démarrage suivant les
   * recréerait, avec leur mot de passe public.
   */
  SEED_DEMO_DATA: z.string().trim().optional().default(""),

  /**
   * Secret du déclencheur de relances (`POST /api/v1/cron/reminders`).
   *
   * Sur un hébergement serverless, aucun processus ne vit assez longtemps pour
   * porter une horloge : les relances d'échéance sont déclenchées par le cron
   * de la plateforme. Sans ce secret, la route n'existe pas — un déclencheur
   * ouvert permettrait d'envoyer des e-mails aux clients à volonté.
   */
  CRON_SECRET: z.string().trim().optional().default(""),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  throw new Error("Invalid environment configuration: " + parsed.error.issues.map(i => i.path.join(".")).join(", "))
}
export const env = {
  ...parsed.data,
  CORS_ORIGINS: parsed.data.CORS_ORIGINS.split(",").map(v => v.trim()).filter(Boolean),
  PLATFORM_ADMIN_EMAILS: parsed.data.PLATFORM_ADMIN_EMAILS.split(",")
    .map(v => v.trim().toLowerCase())
    .filter(Boolean),
}
