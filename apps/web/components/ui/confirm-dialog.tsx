"use client"

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
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

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <AlertDialog open={options !== null} onOpenChange={(open) => !open && settle(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{options?.title}</AlertDialogTitle>
            {options?.description && (
              <AlertDialogDescription className="whitespace-pre-line">
                {options.description}
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-3">
            <AlertDialogCancel onClick={() => settle(false)} className="min-h-[44px] sm:min-h-0 w-full sm:w-auto">
              {options?.cancelLabel ?? "Cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => settle(true)}
              className={
                (options?.danger
                  ? "bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-600"
                  : "bg-vez-navy text-white hover:opacity-90") + " min-h-[44px] sm:min-h-0 w-full sm:w-auto"
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
