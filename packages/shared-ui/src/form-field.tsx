import * as React from "react"
import { cn } from "cn"

export interface FormFieldProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** Stable control id used by the label and accessible descriptions. */
  htmlFor: string
  label: React.ReactNode
  children: React.ReactElement
  description?: React.ReactNode
  error?: React.ReactNode
  required?: boolean
}

/**
 * A small cross-app form pattern: consistent label, control, help text and
 * validation message with the corresponding accessible relationships.
 */
export function FormField({
  htmlFor,
  label,
  children,
  description,
  error,
  required = false,
  className,
  ...props
}: FormFieldProps) {
  const descriptionId = `${htmlFor}-description`
  const errorId = `${htmlFor}-error`
  const child = React.Children.only(children) as React.ReactElement<{
    id?: string
    "aria-describedby"?: string
    "aria-invalid"?: boolean | "true" | "false"
    "aria-required"?: boolean | "true" | "false"
  }>
  const existingDescriptionIds = child.props["aria-describedby"]
    ?.split(/\s+/)
    .filter(Boolean) ?? []
  const describedBy = [
    ...existingDescriptionIds,
    description ? descriptionId : null,
    error ? errorId : null,
  ].filter((value): value is string => Boolean(value))

  const control = React.cloneElement(child, {
    id: child.props.id ?? htmlFor,
    "aria-invalid": error ? true : child.props["aria-invalid"],
    "aria-required": required ? true : child.props["aria-required"],
    "aria-describedby": describedBy.length ? [...new Set(describedBy)].join(" ") : undefined,
  })

  return (
    <div
      data-slot="form-field"
      data-invalid={error ? "true" : undefined}
      className={cn("grid gap-2", className)}
      {...props}
    >
      <label
        data-slot="form-field-label"
        htmlFor={htmlFor}
        className="flex items-center gap-1 text-sm leading-none font-medium"
      >
        {label}
        {required && <span aria-hidden="true" className="text-destructive">*</span>}
      </label>
      {control}
      {description && (
        <p id={descriptionId} data-slot="form-field-description" className="text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {error && (
        <p id={errorId} data-slot="form-field-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
