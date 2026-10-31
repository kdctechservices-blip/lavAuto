"use client"

import * as React from "react"
import { Check, Circle } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Timeline verticale.
 *
 * Une seule colonne de contenu : l'indicateur et son trait sont dans une
 * gouttière fixe, le contenu occupe le reste. Le trait est un vrai élément
 * (et non un pseudo-élément en `::before`) pour qu'il s'étire sur toute la
 * hauteur de l'étape, quelle que soit la longueur du formulaire ouvert.
 */
export type TimelineStatus = "completed" | "active" | "pending"

function Timeline({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="timeline"
      className={cn("flex w-full flex-col", className)}
      {...props}
    />
  )
}

interface TimelineItemProps extends React.ComponentProps<"li"> {
  status?: TimelineStatus
  /** Dernière étape : pas de trait sous l'indicateur. */
  last?: boolean
}

function TimelineItem({
  status = "pending",
  last = false,
  className,
  children,
  ...props
}: TimelineItemProps) {
  return (
    <li
      data-slot="timeline-item"
      data-status={status}
      className={cn("relative flex gap-3 sm:gap-4", className)}
      {...props}
    >
      <div className="flex flex-col items-center">
        <TimelineIndicator status={status} />
        {!last && (
          <span
            aria-hidden="true"
            className={cn(
              "mt-1 w-px flex-1",
              status === "completed" ? "bg-primary/35" : "bg-border"
            )}
          />
        )}
      </div>
      <div className="min-w-0 flex-1 pt-1 pb-6">{children}</div>
    </li>
  )
}

interface TimelineIndicatorProps extends React.ComponentProps<"span"> {
  status?: TimelineStatus
}

function TimelineIndicator({
  status = "pending",
  className,
  children,
  ...props
}: TimelineIndicatorProps) {
  return (
    <span
      data-slot="timeline-indicator"
      data-status={status}
      className={cn(
        "relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-background transition-colors duration-300",
        status === "completed" &&
          "border-primary/40 bg-primary/10 text-primary",
        status === "active" && "border-primary bg-primary/10 text-primary",
        status === "pending" && "border-border text-muted-foreground/60",
        className
      )}
      {...props}
    >
      {children ?? <TimelineStatusIcon status={status} />}
    </span>
  )
}

/**
 * Icône d'état : coche une fois l'étape validée, point pulsé sur l'étape en
 * cours, cercle vide pour la suite. Le point pulsé dit « c'est ici » sans
 * suggérer un chargement réseau, comme le ferait un spinner.
 */
function TimelineStatusIcon({ status }: { status: TimelineStatus }) {
  if (status === "completed") {
    return <Check className="size-4" aria-hidden="true" />
  }
  if (status === "active") {
    return (
      <span className="relative flex size-1.5" aria-hidden="true">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
      </span>
    )
  }
  return <Circle className="size-3" aria-hidden="true" />
}

function TimelineHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="timeline-header"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    />
  )
}

function TimelineTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="timeline-title"
      className={cn("text-sm leading-snug font-semibold", className)}
      {...props}
    />
  )
}

function TimelineDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="timeline-description"
      className={cn("text-xs text-muted-foreground sm:text-sm", className)}
      {...props}
    />
  )
}

function TimelineContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="timeline-content"
      className={cn("mt-3 text-sm", className)}
      {...props}
    />
  )
}

export {
  Timeline,
  TimelineItem,
  TimelineIndicator,
  TimelineStatusIcon,
  TimelineHeader,
  TimelineTitle,
  TimelineDescription,
  TimelineContent,
}
