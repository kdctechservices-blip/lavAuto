"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Frame : surface encadrée d'une étape (équivalent local des primitives reui).
 *
 * Volontairement plus plate qu'une `Card` : la Timeline porte déjà les titres,
 * la Frame ne fait que délimiter le contenu de l'étape ouverte.
 */
function Frame({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="frame"
      className={cn(
        "flex flex-col gap-4 rounded-xl border bg-card/60 p-4 text-sm",
        className
      )}
      {...props}
    />
  )
}

function FrameHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="frame-header"
      className={cn("flex flex-col gap-1", className)}
      {...props}
    />
  )
}

function FrameTitle({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="frame-title"
      className={cn("text-sm font-medium", className)}
      {...props}
    />
  )
}

function FrameDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="frame-description"
      className={cn("text-xs text-muted-foreground sm:text-sm", className)}
      {...props}
    />
  )
}

function FramePanel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="frame-panel"
      className={cn("flex flex-col gap-4", className)}
      {...props}
    />
  )
}

function FrameFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="frame-footer"
      className={cn(
        "flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between",
        className
      )}
      {...props}
    />
  )
}

export {
  Frame,
  FrameHeader,
  FrameTitle,
  FrameDescription,
  FramePanel,
  FrameFooter,
}
