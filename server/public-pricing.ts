import { Router } from "express"
import { getPool } from "./db.ts"
import { asyncRoute } from "./http.ts"
import { HttpError } from "./auth.ts"
import { TRIAL_DAYS } from "./entitlements.ts"

// ---------------------------------------------------------------------------
// Grille tarifaire publique
//
// Pourquoi cette route existe, alors que la vitrine connaît déjà ses prix :
// depuis que l'éditeur peut changer un tarif depuis la console, le prix écrit
// en dur dans la page n'est plus forcément le prix facturé. Un visiteur qui
// lit « 10 000 F » et se voit réclamer 12 000 F à l'inscription n'a aucune
// raison de croire le second chiffre — il s'en va. La page doit donc dire la
// vérité de la base, pas celle du jour où elle a été écrite.
//
// Trois propriétés de cette route méritent d'être explicites :
//
//   • Elle est **publique**. Montée avant `requireSession`, elle répond à un
//     visiteur anonyme : c'est tout l'intérêt, la page de tarifs est lue
//     avant d'avoir un compte.
//   • Elle n'expose **que** ce qui est déjà affiché publiquement : un code,
//     un prix, une durée d'essai. Ni les plafonds, ni les capacités, ni le
//     nombre de clients. Une route sans authentification doit être avare.
//   • Elle ne porte **aucun texte commercial**. Les arguments de vente
//     restent dans la vitrine, qui est leur place. Ici on ne publie que les
//     chiffres opposables : ceux qui engagent l'éditeur vis-à-vis du client.
// ---------------------------------------------------------------------------

export function createPublicPricingRouter(): Router {
  const r = Router()

  r.get(
    "/pricing",
    asyncRoute(async (_req, res) => {
      const pool = getPool()
      if (!pool) throw new HttpError(503, "database_not_configured", "Base de données indisponible.")
      const q = await pool.query(
        `SELECT code, price_cents
           FROM plans
          WHERE code IN ('starter','pro','business')
          ORDER BY sort_order ASC, price_cents ASC`,
      )
      // Le client reçoit des francs, pas des centimes : le XOF n'a pas de
      // sous-unité, et l'affichage n'a aucune raison de refaire la division.
      res.json({
        trial_days: TRIAL_DAYS,
        plans: q.rows.map((row) => ({
          code: String(row.code),
          price_xof: Math.round(Number(row.price_cents) / 100),
        })),
      })
    }),
  )

  return r
}
