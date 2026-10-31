/**
 * Types de l'artefact produit par `npm run build:api`.
 *
 * Le fichier `server/vercel-bundle.js` est généré (donc absent du dépôt) :
 * cette déclaration le remplace pour le compilateur, si bien que `tsc -b`
 * fonctionne sur un dépôt fraîchement cloné, sans build préalable.
 */
import type { IncomingMessage, ServerResponse } from "node:http"

declare const handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
export default handler
