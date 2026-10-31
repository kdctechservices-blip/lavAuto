import "dotenv/config";
import express from "express"
import type { Request, Response } from "express"
import cors from "cors"
import http from "node:http"
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { env } from "./server/env.ts"
import { initDatabaseSchema, isDatabaseReady, closeDatabase, getPool } from "./server/db.ts"
import { startReminderScheduler } from "./server/reminders.ts"
import { mountApi, apiErrorHandler } from "./server/app.ts"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()
const port = env.PORT

app.disable("x-powered-by")
app.set("trust proxy", 1)

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin")
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
  next()
})

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true)
    if (env.CORS_ORIGINS.includes(origin)) return callback(null, true)
    if (env.NODE_ENV !== "production") return callback(null, true)
    return callback(null, false)
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Idempotency-Key", "Authorization", "X-Session-Token"],
  exposedHeaders: ["Idempotency-Replayed"],
  maxAge: 600,
}))

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" })
})

app.get("/readyz", (_req, res) => {
  const missingDependencies = [
    ...(!isDatabaseReady() ? ["database"] : []),
  ]
  if (missingDependencies.length) {
    res.status(503).json({ status: "not_ready", dependencies: missingDependencies })
    return
  }
  res.status(200).json({ status: "ready" })
})

app.use(express.json({ limit: "1mb" }))

// Tout chemin /api/* qui n'est pas /api/v1 n'existe pas : y répondre tout de
// suite évite qu'il tombe dans les middlewares Vite ci-dessous, qui se
// rendent service à eux-mêmes (un 404 Vite réinjecté dans Vite) et finissent
// en 502 après vingt secondes de boucle. Des centaines de réponses par
// minute, c'est tout le budget de connexion du processus qui partait dans
// cette boucle — et l'application qui rame pour rien.
app.use("/api", (req, res, next) => {
  // `req.path` ici ne contient plus le préfixe "/api" : /api/health → "/health".
  if (req.path.startsWith("/v1")) return next()
  res.status(404).json({ error: { code: "not_found", message: "Cette route API n'existe pas." } })
})

// Tenant-scoped application responses can contain personal or financial data.
app.use("/api/v1", (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store")
  next()
})

// Health endpoints and /api/v1/auth/* are public (the auth router enforces
// its own session checks); every other application route requires a session.
// Session → appartenance (rôle + permissions) → abonnement → routes.
// Le montage vit dans server/app.ts pour que les tests exercent la même pile.
mountApi(app)

app.use(apiErrorHandler)

async function startServer() {
  const isProd = env.NODE_ENV === "production"
  const distPath = path.resolve(__dirname, "dist")

  const databaseReady = await initDatabaseSchema()
  if (isProd && !databaseReady) {
    throw new Error("DATABASE_URL is required in production; refusing to start without Neon.")
  }

  // Relances d'échéance d'abonnement (J-3, J-1, essai terminé).
  const pool = getPool()
  if (databaseReady && pool) startReminderScheduler(pool)

  if (!isProd && process.env.ENABLE_LEGACY_DEMO_API === "true") {
    console.warn("[demo] Static mock data endpoints have been removed. ENABLE_LEGACY_DEMO_API is ignored.")
  }

  const server = http.createServer(app)

  if (!isProd) {
    const { createServer: createViteServer } = await import("vite")
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: "0.0.0.0",
        port,
        allowedHosts: true,
        // Attach HMR to the same HTTP server as Express. Without this,
        // Vite creates a separate WebSocket endpoint that the preview proxy
        // cannot keep open, producing "WebSocket closed without opened".
        hmr: { server },
      },
      appType: "spa",
    })
    app.use(vite.middlewares)
  } else {
    if (!fs.existsSync(path.join(distPath, "index.html"))) {
      throw new Error("The production frontend build is missing; run npm run build before starting the server.")
    }
    app.use(express.static(distPath))
    app.use((_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"))
    })
  }

  server.listen(port, "0.0.0.0", () => {
    console.info(`WashPilot CI server listening on 0.0.0.0:${port}`)
  })

  const shutdown = (signal: string) => {
    console.info(`[server] ${signal} received; shutting down gracefully.`)
    server.close((error) => {
      if (error) {
        console.error("[server] Error closing HTTP server:", error)
        process.exitCode = 1
      }
      void closeDatabase().finally(() => process.exit())
    })
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))
}

startServer().catch((error) => {
  console.error("Failed to start server:", error)
  process.exit(1)
})
