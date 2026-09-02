import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/*
 * Shared date/number formatting. Formatters are constructed once at module scope rather than per
 * row: `Intl.*Format` objects are expensive to build and were being recreated inside `.map()`
 * calls all over the admin and dashboard lists.
 *
 * These are only called from client components that render data fetched after mount, so the
 * resolved locale can never differ between server and client output (a real hydration hazard if
 * a formatter were used in a server-rendered page).
 */
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
})
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
const numberFormat = new Intl.NumberFormat()

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null || value === "") return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value)
  return date ? dateTimeFormat.format(date) : "never"
}

export function formatDay(value: string | number | Date | null | undefined): string {
  const date = toDate(value)
  return date ? dayFormat.format(date) : "never"
}

/** Compact elapsed-time label ("just now", "4m ago", "3h ago", "12d ago"). */
export function formatAgo(value: string | number | Date | null | undefined): string {
  const date = toDate(value)
  if (!date) return "never"
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function formatCount(value: number): string {
  return numberFormat.format(value)
}
