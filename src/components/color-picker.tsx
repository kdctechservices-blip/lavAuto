"use client"

import * as React from "react"
import { Field, FieldLabel } from "@/components/ui/field"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface ColorPickerProps {
  label: string
  cssVar: string
  value: string
  onChange: (cssVar: string, value: string) => void
}

export function ColorPicker({
  label,
  cssVar,
  value,
  onChange,
}: ColorPickerProps) {
  const [localValue, setLocalValue] = React.useState(value)
  const [prevValue, setPrevValue] = React.useState(value)

  // Re-sync when the parent changes the value (e.g. a theme preset is applied).
  if (value !== prevValue) {
    setPrevValue(value)
    setLocalValue(value)
  }

  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newColor = e.target.value
    setLocalValue(newColor)
    onChange(cssVar, newColor)
  }

  const handleTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    setLocalValue(newValue)
    onChange(cssVar, newValue)
  }

  // Get current computed color for display
  const displayColor = React.useMemo(() => {
    if (localValue && localValue.startsWith("#")) {
      return localValue
    }

    // Try to get computed value from CSS
    const computed = getComputedStyle(document.documentElement)
      .getPropertyValue(cssVar)
      .trim()
    if (computed && computed.startsWith("#")) {
      return computed
    }

    return "#000000"
  }, [localValue, cssVar])

  return (
    <Field className="gap-2">
      <FieldLabel htmlFor={`color-${cssVar}`} className="text-xs">
        {label}
      </FieldLabel>
      <div className="flex items-start gap-2">
        <div className="relative">
          <Button
            type="button"
            variant="outline"
            className="size-8 p-0 overflow-hidden cursor-pointer"
            style={{ backgroundColor: displayColor }}
          >
            <input
              type="color"
              id={`color-${cssVar}`}
              value={displayColor}
              onChange={handleColorChange}
              className="absolute inset-0 size-full opacity-0 cursor-pointer"
            />
          </Button>
        </div>
        <Input
          type="text"
          placeholder={`${cssVar} value`}
          value={localValue}
          onChange={handleTextChange}
          className="h-8 text-xs flex-1"
        />
      </div>
    </Field>
  )
}
