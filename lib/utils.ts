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

/** Days out at which a declared expiry starts being called out rather than merely displayed. */
export const EXPIRY_SOON_DAYS = 14

/** Compact countdown ("in 40m", "in 6h", "in 12d", "expired"), the mirror of formatAgo. */
export function formatUntil(value: string | number | Date | null | undefined): string {
  const date = toDate(value)
  if (!date) return "no expiry"
  const seconds = Math.floor((date.getTime() - Date.now()) / 1000)
  if (seconds <= 0) return "expired"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `in ${Math.max(minutes, 1)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h`
  return `in ${Math.floor(hours / 24)}d`
}

/**
 * Where a declared expiry stands. `none` is not `ok`: an entry with no expiry is served forever,
 * which is a different thing from one whose expiry is comfortably away.
 */
export function expiryState(
  value: string | number | Date | null | undefined,
): "none" | "expired" | "expiring" | "ok" {
  const date = toDate(value)
  if (!date) return "none"
  const days = (date.getTime() - Date.now()) / 86_400_000
  if (days <= 0) return "expired"
  return days <= EXPIRY_SOON_DAYS ? "expiring" : "ok"
}
