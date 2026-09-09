"use client"

import React, { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  Bookmark,
  Bell,
  Clock,
  Settings,
  Menu,
  X,
  ArrowLeft,
  FileSearch,
  CreditCard,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth-context"
import { useAlerts } from "@/lib/alerts-context"
import { RequireAuth } from "@/components/auth/require-auth"

const navGroups = [
  {
    label: "Overview",
    links: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    ],
  },
  {
    label: "My content",
    links: [
      { href: "/dashboard/saved", label: "Saved notices", icon: Bookmark },
      { href: "/dashboard/alerts", label: "My alerts", icon: Bell, badge: true },
      { href: "/documents", label: "Document search", icon: FileSearch },
    ],
  },
  {
    label: "Account",
    links: [
      { href: "/dashboard/billing", label: "Plan & billing", icon: CreditCard },
      { href: "/dashboard/activity", label: "Activity", icon: Clock },
      { href: "/dashboard/settings", label: "Settings", icon: Settings },
    ],
  },
]

function SidebarContent({ pathname, onLinkClick }: { pathname: string; onLinkClick?: () => void }) {
  const { user } = useAuth()
  const { alerts } = useAlerts()
  const activeAlerts = alerts.filter(a => a.enabled).length

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Back to site */}
      <div className="border-b border-vez-line px-4 pb-3 pt-4">
        <Link
          href="/"
          onClick={onLinkClick}
          className="flex items-center gap-2 rounded-full px-3 py-2 text-sm text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy"
        >
          <ArrowLeft className="size-4" />
          Back to site
        </Link>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5">
        {navGroups.map((group) => (
          <div key={group.label}>
            <p className="mb-2 px-3 text-xs text-vez-mute">{group.label}</p>
            <div className="space-y-1">
              {group.links.map((link) => {
                const Icon = link.icon
                const isActive = pathname === link.href
                return (
                    <Link
                    key={link.href}
                    href={link.href}
                    onClick={onLinkClick}
                    className={cn(
                      "flex items-center gap-3 rounded-full px-4 py-2.5 text-sm transition-colors",
                      isActive
                        ? "bg-vez-navy text-white"
                        : "text-vez-mute hover:bg-vez-surface hover:text-vez-navy"
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="flex-1">{link.label}</span>
                    {"badge" in link && link.badge && activeAlerts > 0 && (
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-vez-navy px-1.5 text-[10px] text-white">
                        {activeAlerts}
                      </span>
                    )}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* User profile */}
      {user && (
        <div className="border-t border-vez-line p-4">
          <div className="flex items-center gap-3 rounded-[16px] bg-vez-surface px-3 py-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-vez-sky">
              <span className="text-sm text-vez-navy">
                {user.username.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-vez-ink">{user.username}</p>
              <p className="text-xs capitalize text-vez-mute">{user.role}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <RequireAuth>
      <div className="flex flex-col lg:flex-row h-[calc(100vh-5rem)] w-full max-w-full overflow-hidden">
      {/* Mobile hamburger - top bar for larger mobile, also floating */}
      <div className="flex items-center justify-between gap-2 border-b border-vez-line bg-white px-4 py-3 lg:hidden">
        <button
          className="flex size-10 shrink-0 items-center justify-center rounded-full bg-vez-navy text-white shadow-sm"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
        >
          <Menu className="size-5" />
        </button>
        <span className="text-sm font-medium text-vez-ink">Dashboard</span>
        <span className="size-10 shrink-0" aria-hidden />
      </div>
      {/* Floating hamburger for content scroll */}
      <div className="fixed bottom-4 left-4 z-50 lg:hidden">
        <button
          className="flex size-12 items-center justify-center rounded-full bg-vez-navy text-white shadow-lg"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
        >
          <Menu className="size-5" />
        </button>
      </div>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-vez-navy/40 backdrop-blur-[6px]" onClick={() => setMobileOpen(false)} />
          <aside className="absolute bottom-0 left-0 top-0 flex w-[min(272px,85vw)] max-w-[85vw] translate-x-0 flex-col border-r border-vez-line bg-white shadow-xl transition-transform duration-300 lg:translate-x-0">
            <div className="flex items-center justify-end border-b border-vez-line p-2">
              <button
                className="flex size-9 items-center justify-center rounded-full text-vez-mute hover:bg-vez-surface"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
              >
                <X className="size-4" />
              </button>
            </div>
            <SidebarContent pathname={pathname} onLinkClick={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden w-full lg:w-64 shrink-0 flex-col border-r border-vez-line bg-white lg:flex">
        <SidebarContent pathname={pathname} />
      </aside>

      <main className="min-w-0 flex-1 w-full overflow-y-auto overflow-x-hidden bg-vez-surface/60 overscroll-contain">
        <div className="mx-auto w-full max-w-full min-w-0 p-4 sm:p-5 md:p-6 lg:p-8 overflow-x-hidden">
          {children}
        </div>
      </main>
      </div>
    </RequireAuth>
  )
}
