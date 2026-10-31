import * as React from "react"
import { CFormInput } from "@coreui/react"
import { cn } from "cn"

/** Champ CoreUI conservant intégralement l'API HTML de l'ancienne primitive. */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <CFormInput
      type={type}
      data-slot="input"
      className={cn("w-full min-w-0 text-base md:text-sm", className)}
      {...(props as React.ComponentProps<typeof CFormInput>)}
    />
  )
}

export { Input }
