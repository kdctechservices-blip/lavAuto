"use client"

import * as React from "react"
import {
  CTable,
  CTableBody,
  CTableCaption,
  CTableDataCell,
  CTableFoot,
  CTableHead,
  CTableHeaderCell,
  CTableRow,
} from "@coreui/react"
import { cn } from "cn"

/** Table CoreUI avec le même découpage que l'ancienne primitive partagée. */
function Table({ className, ...props }: React.ComponentProps<typeof CTable>) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <CTable
        hover
        data-slot="table"
        className={cn("mb-0 w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<typeof CTableHead>) {
  return <CTableHead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<typeof CTableBody>) {
  return <CTableBody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />
}

function TableFooter({ className, ...props }: React.ComponentProps<typeof CTableFoot>) {
  return (
    <CTableFoot
      data-slot="table-footer"
      className={cn("border-t font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<typeof CTableRow>) {
  return (
    <CTableRow
      data-slot="table-row"
      className={cn("has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted", className)}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<typeof CTableHeaderCell>) {
  return (
    <CTableHeaderCell
      data-slot="table-head"
      scope="col"
      className={cn("h-10 text-left align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0", className)}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<typeof CTableDataCell>) {
  return (
    <CTableDataCell
      data-slot="table-cell"
      className={cn("align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0", className)}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<typeof CTableCaption>) {
  return (
    <CTableCaption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-body-secondary", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
