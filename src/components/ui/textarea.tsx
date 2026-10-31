import * as React from "react"
import { CFormTextarea } from "@coreui/react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <CFormTextarea
      data-slot="textarea"
      className={cn("flex min-h-16 w-full text-base md:text-sm", className)}
      {...(props as React.ComponentProps<typeof CFormTextarea>)}
    />
  )
}

export { Textarea }
