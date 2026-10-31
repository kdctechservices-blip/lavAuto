import { AppErrorState } from "@/components/errors/app-error-state"

export function UnderMaintenanceError() {
  return (
    <AppErrorState
      code="503"
      title="Service temporairement indisponible"
      description="WashPilot CI est momentanément indisponible. Veuillez réessayer plus tard."
      onRetry={() => window.location.reload()}
    />
  )
}
