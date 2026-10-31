export type WorkerRole =
  | "car_washer"
  | "moto_washer"
  | "versatile_washer"
  | "team_lead"
  | "custom"

export interface WorkerRecord {
  id: string
  organization_id: string
  first_name: string
  last_name: string
  phone: string | null
  district: string | null
  role: WorkerRole
  status: "active" | "inactive"
  custom_role: string | null
  joined_at: string | null
  created_at: string
  updated_at: string
}

export interface WorkerInput {
  first_name: string
  last_name: string
  phone: string | null
  district: string | null
  role: WorkerRole
  custom_role: string | null
  joined_at: string | null
}

export interface OrganizationAccount {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
  role: string
  status: string
  created_at: string
  updated_at: string
}

export interface CurrentMember {
  role: string
}
