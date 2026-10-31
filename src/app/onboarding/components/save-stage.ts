import { apiFetch } from "@/lib/api"

/** Sauvegarde générique d'une étape côté serveur (§8 : persistance systématique). */
export async function saveStage(
  stage: string,
  data: unknown,
  planCode?: string,
  draft = false
): Promise<Response> {
  return apiFetch("/api/v1/onboarding/progress", {
    method: "PUT",
    body: JSON.stringify({ stage, data, plan_code: planCode, draft }),
  })
}
