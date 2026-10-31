import { Router, type Request } from "express";
import { z } from "zod";
import { getPool } from "./db.ts";
import { env } from "./env.ts";
import { asyncRoute } from "./http.ts";
import { isMailerConfigured, passwordResetMessage, sendMail } from "./mailer.ts";
import {
  HttpError,
  clearSessionCookie,
  consumePasswordResetToken,
  createPasswordResetToken,
  createSession,
  destroySession,
  getSessionUser,
  hashPassword,
  isPasswordResetTokenValid,
  readSessionToken,
  setSessionCookie,
  verifyPassword,
} from "./auth.ts";

export const MIN_PASSWORD_LENGTH = 5;

// ---------------------------------------------------------------------------
// Minimal in-memory rate limiting for credential endpoints (per IP).
// ---------------------------------------------------------------------------
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 30;
const attempts = new Map<string, { count: number; resetAt: number }>();

function assertRateLimit(req: Request) {
  const key = req.ip || "unknown";
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
  if (entry.count > MAX_ATTEMPTS) {
    throw new HttpError(
      429,
      "too_many_requests",
      "Trop de tentatives. Patientez quelques minutes puis réessayez.",
    );
  }
}

const registerSchema = z.object({
  firstName: z.string().trim().min(1, "Le prénom est requis.").max(100),
  lastName: z.string().trim().min(1, "Le nom est requis.").max(100),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Adresse e-mail invalide.")
    .max(254),
  password: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`,
    )
    .max(200),
  phone: z.string().trim().max(30).optional().nullable(),
  organizationName: z.string().trim().max(150).optional(),
});

const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Adresse e-mail invalide.")
    .max(254),
  password: z.string().min(1, "Le mot de passe est requis.").max(200),
});

const profileSchema = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().max(30).optional().nullable(),
});

const passwordSchema = z.object({
  currentPassword: z
    .string()
    .min(1, "Le mot de passe actuel est requis.")
    .max(200),
  newPassword: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `Le nouveau mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`,
    )
    .max(200),
});

const forgotPasswordSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Adresse e-mail invalide.")
    .max(254),
});

const resetPasswordSchema = z.object({
  token: z.string().trim().min(10, "Lien invalide.").max(300),
  password: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`,
    )
    .max(200),
});

/**
 * Construit l'URL publique du lien de réinitialisation.
 * Priorité à APP_URL ; sinon l'origine de la requête si elle est autorisée ;
 * sinon l'hôte vu par le serveur (utile derrière le proxy d'aperçu).
 */
export function buildResetUrl(req: Request, token: string): string {
  const candidates = [
    env.APP_URL,
    req.get("origin") && env.CORS_ORIGINS.includes(req.get("origin") as string)
      ? req.get("origin")
      : "",
    `${req.get("x-forwarded-proto") || req.protocol}://${req.get("host") ?? "localhost"}`,
  ];
  const base = (candidates.find((value) => Boolean(value)) ?? "").replace(/\/+$/, "");
  return `${base}/auth/reset-password?token=${encodeURIComponent(token)}`;
}

interface MePayload {
  user: {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    avatar_url: string | null;
  };
  organization: {
    id: string;
    name: string;
    onboarding_completed: boolean;
  } | null;
  role: string | null;
}

async function buildMePayload(userId: string): Promise<MePayload> {
  const pool = getPool();
  if (!pool)
    throw new HttpError(
      503,
      "database_not_configured",
      "Base de données indisponible.",
    );
  const q = await pool.query(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.avatar_url,
            m.role, o.id AS organization_id, o.name AS organization_name, o.onboarding_completed
     FROM users u
     LEFT JOIN organization_members m ON m.user_id = u.id
     LEFT JOIN organizations o ON o.id = m.organization_id
     WHERE u.id = $1
     ORDER BY m.created_at ASC NULLS LAST
     LIMIT 1`,
    [userId],
  );
  const row = q.rows[0];
  if (!row)
    throw new HttpError(
      401,
      "authentication_required",
      "Connectez-vous pour continuer.",
    );
  return {
    user: {
      id: row.id,
      email: row.email,
      first_name: row.first_name,
      last_name: row.last_name,
      phone: row.phone,
      avatar_url: row.avatar_url,
      // Administrateur de plateforme (l'éditeur). Exposé ici parce que le
      // back-office vit hors du contexte de station : un administrateur peut
      // n'appartenir à aucune organisation.
    },
    organization: row.organization_id
      ? {
          id: row.organization_id,
          name: row.organization_name,
          onboarding_completed: Boolean(row.onboarding_completed),
        }
      : null,
    role: (row.role as string | null) ?? null,
  };
}

export function createAuthRouter() {
  const r = Router();

  // POST /api/v1/auth/register — crée le compte, son organisation (la station)
  // et ouvre la session. Workflow : landing → inscription → onboarding.
  r.post(
    "/register",
    asyncRoute(async (req, res) => {
      assertRateLimit(req);
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "invalid_data",
          parsed.error.issues[0]?.message ?? "Données invalides.",
        );
      }
      const { firstName, lastName, email, password, phone, organizationName } =
        parsed.data;
      const pool = getPool();
      if (!pool)
        throw new HttpError(
          503,
          "database_not_configured",
          "Base de données indisponible.",
        );

      const existing = await pool.query(
        "SELECT 1 FROM users WHERE lower(email) = $1 LIMIT 1",
        [email],
      );
      if (existing.rowCount) {
        throw new HttpError(
          409,
          "email_exists",
          "Un compte existe déjà avec cette adresse e-mail. Connectez-vous plutôt.",
        );
      }

      const passwordHash = await hashPassword(password);
      const orgName = organizationName?.trim() || `Station de ${firstName}`;

      const client = await pool.connect();
      let userId: string;
      try {
        await client.query("BEGIN");
        const orgQ = await client.query(
          `INSERT INTO organizations (name, slug) VALUES ($1, NULL) RETURNING id`,
          [orgName],
        );
        const organizationId = orgQ.rows[0].id as string;
        const userQ = await client.query(
          `INSERT INTO users (email, first_name, last_name, phone, password_hash, status, organization_id)
           VALUES ($1, $2, $3, $4, $5, 'active', $6) RETURNING id`,
          [
            email,
            firstName,
            lastName,
            phone ?? null,
            passwordHash,
            organizationId,
          ],
        );
        userId = userQ.rows[0].id as string;
        await client.query(
          `INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [organizationId, userId],
        );
        await client.query(
          `INSERT INTO onboarding_progress (organization_id, current_stage) VALUES ($1, 'station')
           ON CONFLICT (organization_id) DO NOTHING`,
          [organizationId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const token = await createSession(pool, userId);
      setSessionCookie(req, res, token);
      // Le jeton est aussi renvoyé pour les contextes où le cookie est bloqué
      // (aperçu intégré / iframe) : le client l'enverra en Authorization: Bearer.
      res
        .status(201)
        .json({ ...(await buildMePayload(userId)), session_token: token });
    }),
  );

  // POST /api/v1/auth/login — vérifie les identifiants et ouvre la session.
  r.post(
    "/login",
    asyncRoute(async (req, res) => {
      assertRateLimit(req);
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "invalid_data",
          parsed.error.issues[0]?.message ?? "Données invalides.",
        );
      }
      const { email, password } = parsed.data;
      const pool = getPool();
      if (!pool)
        throw new HttpError(
          503,
          "database_not_configured",
          "Base de données indisponible.",
        );

      const q = await pool.query(
        "SELECT id, password_hash, status FROM users WHERE lower(email) = $1 LIMIT 1",
        [email],
      );
      const row = q.rows[0] as
        | { id: string; password_hash: string | null; status: string }
        | undefined;
      const valid = row
        ? await verifyPassword(password, row.password_hash)
        : false;
      if (!row || !valid) {
        throw new HttpError(
          401,
          "invalid_credentials",
          "Adresse e-mail ou mot de passe incorrect.",
        );
      }
      if (row.status !== "active") {
        throw new HttpError(
          403,
          "account_disabled",
          "Ce compte a été désactivé. Contactez votre administrateur.",
        );
      }

      const token = await createSession(pool, row.id);
      setSessionCookie(req, res, token);
      res.json({ ...(await buildMePayload(row.id)), session_token: token });
    }),
  );

  // POST /api/v1/auth/logout — détruit la session et efface le cookie.
  r.post(
    "/logout",
    asyncRoute(async (req, res) => {
      const pool = getPool();
      const token = readSessionToken(req);
      if (pool && token) await destroySession(pool, token);
      clearSessionCookie(req, res);
      res.status(204).end();
    }),
  );

  // GET /api/v1/auth/me — utilisateur courant + organisation + rôle.
  r.get(
    "/me",
    asyncRoute(async (req, res) => {
      const session = await getSessionUser(req);
      if (!session)
        throw new HttpError(
          401,
          "authentication_required",
          "Connectez-vous pour continuer.",
        );
      res.json(await buildMePayload(session.userId));
    }),
  );

  // PATCH /api/v1/auth/profile — met à jour prénom / nom / téléphone.
  r.patch(
    "/profile",
    asyncRoute(async (req, res) => {
      const session = await getSessionUser(req);
      if (!session)
        throw new HttpError(
          401,
          "authentication_required",
          "Connectez-vous pour continuer.",
        );
      const parsed = profileSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "invalid_data",
          parsed.error.issues[0]?.message ?? "Données invalides.",
        );
      }
      const pool = getPool();
      if (!pool)
        throw new HttpError(
          503,
          "database_not_configured",
          "Base de données indisponible.",
        );
      const { firstName, lastName, phone } = parsed.data;
      await pool.query(
        `UPDATE users SET
           first_name = COALESCE($2, first_name),
           last_name = COALESCE($3, last_name),
           phone = CASE WHEN $4::boolean THEN $5 ELSE phone END,
           updated_at = NOW()
         WHERE id = $1`,
        [
          session.userId,
          firstName ?? null,
          lastName ?? null,
          phone !== undefined,
          phone ?? null,
        ],
      );
      res.json(await buildMePayload(session.userId));
    }),
  );

  // POST /api/v1/auth/password — change le mot de passe (session requise).
  r.post(
    "/password",
    asyncRoute(async (req, res) => {
      assertRateLimit(req);
      const session = await getSessionUser(req);
      if (!session)
        throw new HttpError(
          401,
          "authentication_required",
          "Connectez-vous pour continuer.",
        );
      const parsed = passwordSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "invalid_data",
          parsed.error.issues[0]?.message ?? "Données invalides.",
        );
      }
      const pool = getPool();
      if (!pool)
        throw new HttpError(
          503,
          "database_not_configured",
          "Base de données indisponible.",
        );

      const q = await pool.query(
        "SELECT password_hash FROM users WHERE id = $1",
        [session.userId],
      );
      const currentHash = q.rows[0]?.password_hash as string | null | undefined;
      if (!(await verifyPassword(parsed.data.currentPassword, currentHash))) {
        throw new HttpError(
          401,
          "invalid_credentials",
          "Le mot de passe actuel est incorrect.",
        );
      }
      const newHash = await hashPassword(parsed.data.newPassword);
      await pool.query(
        "UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1",
        [session.userId, newHash],
      );
      // Invalide les autres sessions de l'utilisateur par précaution.
      await pool.query(
        "DELETE FROM auth_sessions WHERE user_id = $1 AND id::text <> $2",
        [session.userId, session.sessionId],
      );
      res.json({ ok: true });
    }),
  );

  // POST /api/v1/auth/forgot-password — envoie un lien de réinitialisation.
  // La réponse est toujours identique pour ne pas révéler si un compte existe.
  r.post(
    "/forgot-password",
    asyncRoute(async (req, res) => {
      assertRateLimit(req);
      const parsed = forgotPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "invalid_data",
          parsed.error.issues[0]?.message ?? "Données invalides.",
        );
      }
      const { email } = parsed.data;
      const pool = getPool();
      if (!pool)
        throw new HttpError(
          503,
          "database_not_configured",
          "Base de données indisponible.",
        );

      const genericResponse: {
        ok: true;
        message: string;
        delivery: "email" | "manual";
        reset_url?: string;
      } = {
        ok: true,
        message:
          "Si un compte existe avec cette adresse, un lien de réinitialisation vient d'être envoyé. Pensez à vérifier vos indésirables.",
        delivery: isMailerConfigured() ? "email" : "manual",
      };

      const q = await pool.query(
        "SELECT id, email, status FROM users WHERE lower(email) = $1 LIMIT 1",
        [email],
      );
      const row = q.rows[0] as
        | { id: string; email: string; status: string }
        | undefined;

      // Compte inconnu ou désactivé : même réponse, aucun jeton créé.
      if (!row || row.status !== "active") {
        res.json(genericResponse);
        return;
      }

      const token = await createPasswordResetToken(
        pool,
        row.id,
        env.PASSWORD_RESET_TTL_MINUTES,
        req.ip ?? null,
      );
      const resetUrl = buildResetUrl(req, token);
      const sent = await sendMail(
        passwordResetMessage(row.email, resetUrl, env.PASSWORD_RESET_TTL_MINUTES),
      );

      // Sans fournisseur e-mail, le lien est exposé uniquement hors production
      // afin de permettre les tests et la réinitialisation assistée en local.
      if (!sent && env.NODE_ENV !== "production") {
        genericResponse.reset_url = resetUrl;
        genericResponse.message =
          "Aucun service d'e-mail n'est configuré sur cet environnement : utilisez le lien ci-dessous pour réinitialiser le mot de passe.";
      }

      res.json(genericResponse);
    }),
  );

  // GET /api/v1/auth/reset-password?token=… — vérifie un lien sans le consommer.
  r.get(
    "/reset-password",
    asyncRoute(async (req, res) => {
      const token = typeof req.query.token === "string" ? req.query.token : "";
      const pool = getPool();
      if (!pool)
        throw new HttpError(
          503,
          "database_not_configured",
          "Base de données indisponible.",
        );
      res.json({ valid: await isPasswordResetTokenValid(pool, token) });
    }),
  );

  // POST /api/v1/auth/reset-password — consomme le lien et change le mot de passe.
  r.post(
    "/reset-password",
    asyncRoute(async (req, res) => {
      assertRateLimit(req);
      const parsed = resetPasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpError(
          400,
          "invalid_data",
          parsed.error.issues[0]?.message ?? "Données invalides.",
        );
      }
      const pool = getPool();
      if (!pool)
        throw new HttpError(
          503,
          "database_not_configured",
          "Base de données indisponible.",
        );

      const userId = await consumePasswordResetToken(pool, parsed.data.token);
      if (!userId) {
        throw new HttpError(
          400,
          "invalid_reset_token",
          "Ce lien de réinitialisation est invalide ou a expiré. Demandez-en un nouveau.",
        );
      }

      const newHash = await hashPassword(parsed.data.password);
      await pool.query(
        "UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1",
        [userId, newHash],
      );
      // Toutes les sessions existantes sont révoquées : seul le nouveau mot de
      // passe donne accès au compte.
      await pool.query("DELETE FROM auth_sessions WHERE user_id = $1", [userId]);

      res.json({
        ok: true,
        message:
          "Votre mot de passe a été réinitialisé. Vous pouvez maintenant vous connecter.",
      });
    }),
  );

  return r;
}
