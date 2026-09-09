"use client"

import React, { useEffect, useState } from "react"
import Link from "next/link"
import {
  Clock,
  Eye,
  Bookmark,
  Bell,
  Search,
  FileText,
  AlertCircle,
  Loader2,
} from "lucide-react"
import { Header } from "@/components/layout/header"
import { DashboardLayout } from "@/components/dashboard/dashboard-layout"
import { useAuth } from "@/lib/auth-context"
import { useAlerts } from "@/lib/alerts-context"
import { fetchNotices } from "@/lib/api"
import type { ScrapedItem } from "@/lib/types"

export default function ActivityPage() {
  const { user } = useAuth()
  const { alerts } = useAlerts()
  const [notices, setNotices] = useState<ScrapedItem[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetchNotices({ limit: 10, sortBy: "publishedAt", sortOrder: "desc" })
        if (!cancelled) setNotices(res.data ?? [])
      } catch {
        if (!cancelled) setNotices([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [user])

  if (!user) {
    return (
      <div className="min-h-screen bg-white font-poppins">
        <Header />
        <div className="flex items-center justify-center py-32">
          <div className="w-full max-w-sm rounded-[24px] bg-vez-surface p-10 text-center">
            <AlertCircle className="mx-auto mb-4 size-10 text-vez-mute" />
            <h2 className="mb-1 text-lg text-vez-ink">Sign in required</h2>
            <p className="mb-6 text-sm text-vez-mute">Please sign in to view activity.</p>
            <Link
              href="/login"
              className="block w-full rounded-full bg-vez-navy px-6 py-3 text-base text-white transition-opacity hover:opacity-90"
            >
              Sign in
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const activityIcon = (type: string) => {
    switch (type) {
      case "view": return <Eye className="size-4" />
      case "save": return <Bookmark className="size-4" />
      case "alert": return <Bell className="size-4" />
      case "search": return <Search className="size-4" />
      case "document": return <FileText className="size-4" />
      default: return <Clock className="size-4" />
    }
  }

  const activities = [
    ...alerts.slice(0, 3).map(a => ({
      id: `alert-${a.id}`,
      type: "alert" as const,
      description: `Alert "${a.name}" — ${a.matchCount} matches`,
      timestamp: (a as unknown as { createdAt?: string }).createdAt ?? new Date().toISOString(),
    })),
    ...notices.slice(0, 7).map(n => ({
      id: `notice-${n.id}`,
      type: "view" as const,
      description: `Viewed '${n.title.slice(0, 50)}'`,
      timestamp: n.publishedAt ?? n.scrapedAt ?? new Date().toISOString(),
    })),
  ].slice(0, 10)

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-white font-poppins">
      <Header />
      <DashboardLayout>
        <div className="mb-6 w-full max-w-full min-w-0 overflow-hidden sm:mb-8">
          <h1 className="break-words text-[clamp(22px,6vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
            Activity.
          </h1>
          <p className="mt-1 text-sm text-vez-mute sm:mt-2">Your recent actions and history</p>
        </div>

        <div className="w-full max-w-full min-w-0 space-y-3 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-vez-mute"><Loader2 className="size-5 animate-spin" /></div>
          ) : activities.length === 0 ? (
            <div className="rounded-[16px] bg-white p-8 text-center">
              <Clock className="mx-auto size-8 text-vez-mute/40" />
              <p className="mt-2 text-sm text-vez-mute">No recent activity — browse notices to get started.</p>
              <Link href="/notices" className="mt-3 inline-flex rounded-full bg-vez-navy px-4 py-2 text-xs text-white">Browse notices</Link>
            </div>
          ) : activities.map((activity) => (
            <div
              key={activity.id}
              className="flex w-full min-w-0 items-center gap-3 overflow-hidden rounded-[16px] bg-white p-4 transition-colors hover:bg-vez-sky/10 sm:gap-4 sm:p-5"
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-vez-sky/30 text-vez-navy sm:size-10">
                {activityIcon(activity.type)}
              </div>
              <div className="min-w-0 flex-1 overflow-hidden">
                <p className="break-words text-sm leading-relaxed text-vez-ink">{activity.description}</p>
                <p className="mt-0.5 break-words text-xs text-vez-mute">
                  {new Date(activity.timestamp).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
            </div>
          ))}
        </div>
      </DashboardLayout>
    </div>
  )
}
