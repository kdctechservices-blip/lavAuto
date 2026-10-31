import { useApi } from "@/lib/api";

// Types partagés avec le backend (docs/WORKFLOW_PLAN.md §4)
export type OnboardingState = "not_started" | "in_progress" | "completed";

export interface OnboardingStatus {
  state: OnboardingState;
  current_stage: string;
  org_name: string;
  station?: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    address: string | null;
    city: string | null;
    description: string | null;
    logo_url: string | null;
    slug: string | null;
  };
}

export interface StationData {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  city: string;
  description?: string;
  logo_url?: string;
}

export interface CatalogTemplate {
  id: string;
  category: string;
  name: string;
  price_cents: number | null;
  /** Durée indicative en minutes — affichée à côté du prix. */
  duration_minutes: number | null;
  description: string | null;
  sort_order: number;
}

export interface SelectedService {
  template_id: string;
  name: string;
  price_cents: number | null;
}

export interface CustomService {
  name: string;
  category: string;
  price_cents: number | null;
}

export interface ServicesData {
  selected: SelectedService[];
  custom: CustomService[];
}

export interface WorkerInput {
  first_name: string;
  last_name: string;
  phone?: string;
  district?: string;
  role: string;
  custom_role?: string;
  joined_at?: string;
}

export interface WorkersData {
  workers: WorkerInput[];
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price_cents: number;
  billing_cycle: string;
  max_workers: number | null;
  max_services: number | null;
  max_sites?: number | null;
  max_users?: number | null;
  /** The database stores boolean entitlements; older responses used labels. */
  features: string[] | Record<string, boolean>;
  sort_order: number;
}

export interface OnboardingProgress {
  current_stage: string;
  station_data: StationData | null;
  services_data: ServicesData | null;
  workers_data: WorkersData | null;
  plan_code: string | null;
  completed_at: string | null;
}

export interface OnboardingSummary {
  station: StationData | null;
  services: ServicesData | null;
  workers: WorkersData | null;
  plan: Plan | null;
  subscription_status: string;
  subscription_period_end: string | null;
  completed: boolean;
  org_name: string;
}

// Étapes et libellés : `onboarding-stages.ts` (module pur, sans React), ré-exportés
// ici pour les appelants existants.
export { STAGES, STAGE_LABELS, type OnboardingStage } from "./onboarding-stages";

export function useOnboardingStatus() {
  return useApi<OnboardingStatus>("/api/v1/onboarding/status");
}
