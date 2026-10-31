"use client"

import { useId, useMemo } from "react"
import { cn } from "@/lib/utils"

interface SparklineProps {
  /** Série de valeurs (ordre chronologique). */
  values: number[]
  width?: number
  height?: number
  className?: string
  /** Couleur CSS du tracé (par défaut : la couleur de texte héritée). */
  stroke?: string
}

/**
 * Mini-courbe SVG (aucune dépendance, ~1 Ko) affichée au survol d'une carte
 * d'indicateur : la tendance se lit sans ouvrir la page Rapports.
 */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  className,
  stroke = "currentColor",
}: SparklineProps) {
  const gradientId = useId()

  const { line, area } = useMemo(() => {
    const points = values.filter((value) => Number.isFinite(value))
    if (points.length < 2) return { line: "", area: "" }

    const max = Math.max(...points)
    const min = Math.min(...points)
    const span = max - min || 1
    const stepX = width / (points.length - 1)
    const padding = 3

    const coords = points.map((value, index) => {
      const x = index * stepX
      const y =
        height - padding - ((value - min) / span) * (height - padding * 2)
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })

    return {
      line: `M${coords.join(" L")}`,
      area: `M0,${height} L${coords.join(" L")} L${width},${height} Z`,
    }
  }, [values, width, height])

  if (!line) return null

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      aria-hidden="true"
      className={cn("overflow-visible", className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.25} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path
        d={line}
        stroke={stroke}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
