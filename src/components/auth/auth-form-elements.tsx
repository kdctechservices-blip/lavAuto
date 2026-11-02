import type { InputHTMLAttributes, ReactNode } from "react"
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"

interface AuthFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id"> {
  id: string
  label: string
  icon: LucideIcon
  hint?: string
  error?: string
  trailing?: ReactNode
  labelTrailing?: ReactNode
}

export function AuthField({
  id,
  label,
  icon: Icon,
  hint,
  error,
  trailing,
  labelTrailing,
  ...inputProps
}: AuthFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-[13px] font-semibold text-foreground">
          {label}
        </label>
        {labelTrailing}
      </div>
      <div
        className={cn(
          "group flex h-[50px] items-center gap-3 rounded-xl border border-input bg-card px-3.5 shadow-sm shadow-slate-900/[0.025] transition duration-200 focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/20 motion-reduce:transition-none",
          error ? "border-destructive" : "hover:border-primary/60",
          inputProps.disabled && "cursor-not-allowed bg-muted opacity-70",
        )}
      >
        <Icon
          className={cn(
            "size-[17px] shrink-0 text-muted-foreground transition-colors group-focus-within:text-primary",
            error && "text-destructive",
          )}
          aria-hidden="true"
        />
        <input
          {...inputProps}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        {trailing}
      </div>
      {hint ? (
        <p id={hintId} className="text-[11px] leading-4 text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-[11px] leading-4 text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

interface PasswordVisibilityButtonProps {
  visible: boolean
  onToggle: () => void
  label: string
}

export function PasswordVisibilityButton({ visible, onToggle, label }: PasswordVisibilityButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`${visible ? "Masquer" : "Afficher"} ${label.toLowerCase()}`}
      aria-pressed={visible}
      className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none"
    >
      {visible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
    </button>
  )
}

interface AuthNoticeProps {
  children: ReactNode
  tone?: "error" | "success" | "info"
}

export function AuthNotice({ children, tone = "error" }: AuthNoticeProps) {
  const Icon = tone === "success" ? CheckCircle2 : AlertCircle
  const toneClass =
    tone === "success"
      ? "border-success/30 bg-success-soft text-success"
      : tone === "info"
        ? "border-info/30 bg-info-soft text-info"
        : "border-destructive/30 bg-destructive/10 text-destructive"

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn("flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-xs leading-5", toneClass)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div>{children}</div>
    </div>
  )
}

interface AuthSubmitButtonProps {
  children: ReactNode
  pending?: boolean
  disabled?: boolean
  /** Succès confirmé par le serveur : coche verte avant la redirection. */
  success?: boolean
  successLabel?: string
}

export function AuthSubmitButton({
  children,
  pending = false,
  disabled = false,
  success = false,
  successLabel = "C'est bon",
}: AuthSubmitButtonProps) {
  return (
    <button
      type="submit"
      disabled={pending || disabled || success}
      aria-busy={pending}
      className={`group flex h-[50px] w-full items-center justify-center gap-2.5 rounded-xl px-5 text-sm font-bold shadow-lg shadow-blue-900/15 transition duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-blue-900/20 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/30 disabled:translate-y-0 disabled:cursor-not-allowed motion-reduce:transition-none ${
        success
          ? "bg-success text-success-foreground opacity-100 hover:bg-success"
          : "bg-primary text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
      }`}
    >
      {/* Le libellé change d'état en fondu : attente, puis confirmation. */}
      <span
        key={pending ? "pending" : success ? "success" : "idle"}
        className="inline-flex animate-in items-center gap-2.5 fade-in-0 zoom-in-95 duration-200"
      >
        {pending ? (
          <>
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Patientez…
          </>
        ) : success ? (
          <>
            <Check className="size-4" aria-hidden="true" />
            {successLabel}
          </>
        ) : (
          children
        )}
      </span>
    </button>
  )
}
