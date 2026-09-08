"use client"

import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Copies `text` to the clipboard and flashes a checkmark for feedback. Falls
 * back to a hidden-textarea + `execCommand` when the async Clipboard API is
 * unavailable (non-HTTPS context, older Safari) instead of silently no-oping.
 */
export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement("textarea")
        textarea.value = text
        textarea.style.position = "fixed"
        textarea.style.opacity = "0"
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand("copy")
        document.body.removeChild(textarea)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard permission denied or unsupported — no feedback shown, but
      // nothing crashes either.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Copied" : "Copy answer"}
      title={copied ? "Copied" : "Copy answer"}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 sm:px-1.5 py-1.5 sm:py-1 text-[10px] sm:text-xs text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 justify-center font-poppins tracking-tight",
        className,
       )}
    >
      {copied ? <Check className="size-3 text-emerald-600" /> : <Copy className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  )
}
