"use client"

import * as React from "react"
import { ThemeProvider as NextThemesProvider } from "next-themes"

/**
 * Theme provider — wraps next-themes.
 * Responsive design: no layout impact; ensures dark/light tokens
 * (vez- tokens, border-vez-line) switch correctly at all breakpoints
 * (sm:640, md:768, lg:1024, xl:1280).
 */
export function ThemeProvider({ children, ...props }: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>
}
