import { toast as baseToast } from "@/components/ui/toast"

type ToastType = "default" | "success" | "error" | "warning" | "info" | "loading"

export function toast({
  title,
  description,
  type = "default",
  action,
}: {
  title: string
  description?: string
  type?: ToastType
  action?: { label: string; onClick: () => void }
}) {
  baseToast.add({
    title,
    description,
    type,
    ...(action && {
      actionProps: {
        children: action.label,
        onClick: action.onClick,
      },
    }),
  })
}

export function toastSuccess(title: string, description?: string) {
  toast({ title, description, type: "success" })
}

export function toastError(title: string, description?: string) {
  toast({ title, description, type: "error" })
}

export function toastWarning(title: string, description?: string) {
  toast({ title, description, type: "warning" })
}

export function toastInfo(title: string, description?: string) {
  toast({ title, description, type: "info" })
}

export function toastLoading(title: string, description?: string) {
  toast({ title, description, type: "loading" })
}