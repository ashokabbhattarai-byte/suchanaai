"use client"

import { useTheme } from "next-themes"
import { Moon, Sun } from "lucide-react"
import { useEffect, useState } from "react"

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  if (!mounted) return <div className="size-[44px] sm:size-[34px] min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0" />

  return (
    <button
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      className="flex items-center gap-1.5 text-xs sm:text-sm font-poppins tracking-tight text-muted-foreground hover:text-primary transition-all duration-200 px-3 sm:px-4 py-2 sm:py-1.5 rounded-full hover:bg-accent min-h-[44px] sm:min-h-0 min-w-[44px] sm:min-w-0 justify-center touch-manipulation"
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
      <span className="font-semibold tracking-wide">{theme === "dark" ? "Light" : "Dark"}</span>
    </button>
  )
}
