"use client"

import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { isNetworkError } from "@/lib/api"

interface ErrorStateProps {
  /** The caught error, if any — used to pick an offline vs. generic icon/message and to derive body text. */
  error?: unknown
  title?: string
  message?: string
  onRetry?: () => void
  className?: string
  /** Tighter padding for use inside an already-bounded panel (e.g. a list feed) instead of a full page. */
  compact?: boolean
}

/**
 * Shared fallback for "the fetch failed" states — network drop, server 5xx,
 * or an unexpected exception. Distinguishes offline/timeout from a server
 * error at a glance, and only shows a retry button when the caller can
 * actually retry (some failures, like a 404, aren't retryable).
 */
export function ErrorState({ error, title, message, onRetry, className, compact }: ErrorStateProps) {
  const offline = isNetworkError(error)
  const Icon = offline ? WifiOff : AlertTriangle
  const heading = title ?? (offline ? "Connection problem" : "Something went wrong")
  const body = message ?? (error instanceof Error ? error.message : "Please try again in a moment.")

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 sm:gap-4 rounded-xl sm:rounded-2xl border border-dashed border-vez-line bg-muted/30 px-4 sm:px-6 text-center font-poppins tracking-tight shadow-sm",
        compact ? "py-6 sm:py-8" : "py-8 sm:py-12 lg:py-16",
        className,
      )}
    >
      <div className="flex size-10 sm:size-12 items-center justify-center rounded-full bg-destructive/10">
        <Icon className="size-4 sm:size-5 text-destructive" />
      </div>
      <div className="space-y-1 max-w-sm px-2 sm:px-0">
        <p className="text-sm sm:text-base font-medium font-poppins tracking-tight text-foreground leading-tight">{heading}</p>
        <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">{body}</p>
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry} className="mt-1 gap-1.5 min-h-[44px] sm:min-h-0">
          <RefreshCw className="size-3.5" /> Try again
        </Button>
      )}
    </div>
  )
}
