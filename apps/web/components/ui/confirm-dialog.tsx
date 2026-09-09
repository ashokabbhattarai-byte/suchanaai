"use client"

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react"
import { AlertTriangle, Info } from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

/**
 * App-wide replacement for the browser's native `window.confirm()` — that
 * dialog is unstyled, blocks the whole tab (including any toast/animation),
 * and reads as "your website is broken" rather than as part of the product.
 * This renders one styled AlertDialog, mounted once at the app root
 * (see app/layout.tsx), and exposes an imperative `confirm()` so call sites
 * that used to write:
 *
 *   if (!confirm("Delete this?")) return
 *
 * change to only:
 *
 *   if (!(await confirm({ title: "Delete this?" }))) return
 *
 * — same control flow, no dialog JSX or open-state to manage per call site.
 */
export interface ConfirmOptions {
  title: string
  /** Supporting detail shown under the title. */
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Renders the confirm button destructive (red) for irreversible actions. */
  danger?: boolean
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const resolverRef = useRef<(value: boolean) => void>(null)

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
      setOptions(opts)
    })
  }, [])

  const settle = useCallback((value: boolean) => {
    resolverRef.current?.(value)
    resolverRef.current = null
    setOptions(null)
  }, [])

  const value = useMemo(() => confirm, [confirm])

  const isDanger = Boolean(options?.danger)

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <AlertDialog open={options !== null} onOpenChange={(open) => !open && settle(false)}>
        <AlertDialogContent data-variant={isDanger ? "danger" : "default"} className="gap-0">
          <AlertDialogHeader className="gap-3">
            <div className="flex items-start gap-4">
              <AlertDialogMedia className={isDanger ? "bg-red-50 border-red-100 text-red-600" : "bg-vez-sky/20 border-vez-sky/30 text-vez-navy"}>
                {isDanger ? <AlertTriangle className="size-5" /> : <Info className="size-5" />}
              </AlertDialogMedia>
              <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
                <AlertDialogTitle>{options?.title}</AlertDialogTitle>
                {options?.description && (
                  <AlertDialogDescription className="whitespace-pre-line">
                    {options.description}
                  </AlertDialogDescription>
                )}
              </div>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-6">
            <AlertDialogCancel
              onClick={() => settle(false)}
              className="min-h-[44px] w-full sm:w-auto rounded-full border border-vez-line bg-white px-5 py-2.5 text-sm font-medium text-vez-ink hover:bg-vez-surface focus-visible:ring-vez-navy/20"
            >
              {options?.cancelLabel ?? "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => settle(true)}
              className={
                (isDanger
                  ? "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-600 shadow-sm"
                  : "bg-vez-navy text-white hover:bg-vez-navy/90 focus-visible:ring-vez-navy shadow-sm") +
                " min-h-[44px] w-full sm:w-auto rounded-full px-6 py-2.5 text-sm font-medium"
              }
            >
              {options?.confirmLabel ?? "Continue"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}

/** `if (!(await confirm({ title: "..." }))) return` — see module docstring. */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) {
    throw new Error("useConfirm() must be used within <ConfirmDialogProvider>")
  }
  return ctx
}
