// SPDX-License-Identifier: GPL-3.0-or-later
"use client"

import { useId } from "react"
import { cn } from "@/lib/utils"

const CONTROL =
  "w-full rounded-md border border-input bg-input/30 px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 hover:border-input/80 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20"

/**
 * Label + control + hint/error in one unit, with the association done properly (`htmlFor`,
 * `aria-describedby`, `aria-invalid`). The submit form previously built labels by hand in four
 * different ways, which is why some of its fields were unreachable by keyboard and screen readers.
 *
 * Credentials are pasted, not typed, so `mono` is on by default: monospaced, no spellcheck,
 * `autocompletedelete=off`, and `inputmode` left alone so mobile keyboards still work.
 */
export function Field({
  label,
  name,
  type = "text",
  placeholder,
  hint,
  error,
  required,
  mono = true,
  rows,
  value,
  defaultValue,
  onValueChange,
  autoComplete = "off",
  maxLength,
  minLength,
  className,
}: {
  label: string
  name: string
  type?: string
  placeholder?: string
  hint?: string
  error?: string | null
  required?: boolean
  /** Monospace + no spellcheck: right for tokens, URLs, app_secrets; off for prose fields. */
  mono?: boolean
  rows?: number
  value?: string
  defaultValue?: string
  onValueChange?: (v: string) => void
  autoComplete?: string
  maxLength?: number
  minLength?: number
  className?: string
}) {
  const id = useId()
  const describedBy = hint || error ? `${id}-desc` : undefined

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
        {required ? <span className="ml-1 text-muted-foreground">*</span> : null}
      </label>
      {rows ? (
        <textarea
          id={id}
          name={name}
          rows={rows}
          placeholder={placeholder}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          spellCheck={mono ? false : undefined}
          autoComplete={autoComplete}
          maxLength={maxLength}
          minLength={minLength}
          value={value}
          defaultValue={defaultValue}
          onChange={onValueChange ? (e) => onValueChange(e.target.value) : undefined}
          className={cn(CONTROL, "resize-y leading-relaxed", mono && "font-mono text-xs")}
        />
      ) : (
        <input
          id={id}
          name={name}
          type={type}
          placeholder={placeholder}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          spellCheck={mono ? false : undefined}
          autoComplete={autoComplete}
          maxLength={maxLength}
          minLength={minLength}
          value={value}
          defaultValue={defaultValue}
          onChange={onValueChange ? (e) => onValueChange(e.target.value) : undefined}
          className={cn(CONTROL, mono && "font-mono text-xs")}
        />
      )}
      {error ? (
        <p id={`${id}-desc`} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-desc`} className="text-xs leading-relaxed text-muted-foreground text-pretty">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Label is the hit target as much as the box is: the whole row is a `<label>`, so there is no
 * dead zone between text and checkbox (the guideline that most hand-rolled checkboxes trip on).
 */
export function CheckField({
  label,
  description,
  name,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string
  description?: string
  name: string
  checked: boolean
  onCheckedChange: (next: boolean) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border border-input bg-input/20 p-3 transition-colors hover:border-input/80",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <input
        id={id}
        name={name}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onCheckedChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground text-pretty">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  )
}
