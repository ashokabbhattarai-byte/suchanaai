"use client"

import React, { useRef, useEffect } from "react"
import {
  Newspaper,
  Search,
  Bell,
  Home,
  Settings,
  Eye,
  Clock,
  ChevronRight,
  LayoutDashboard,
  FileText,
} from "lucide-react"
import Link from "next/link"
import Image from "next/image"
import gsap from "gsap"
import logo from "@/public/images/logo.png"
import { mockNotices } from "@/lib/mock-data"
import type { ScrapedItem } from "@/lib/types"

function generateSlug(title: string, id: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + id
}

const recentNotices = mockNotices.slice(0, 6)

const sidebarItems = [
  { icon: Home, label: "Home", href: "/" },
  { icon: Newspaper, label: "Notices", href: "/notices", active: true },
  { icon: Search, label: "Search", href: "/documents" },
  { icon: Bell, label: "Alerts", href: "/login" },
  { icon: LayoutDashboard, label: "Dashboard", href: "/dashboard" },
]

const categoryLabels: Record<string, string> = {
  exams: "Exams",
  vacancies: "Vacancies",
  tenders: "Tenders",
  policy: "Policy",
  announcements: "Announcements",
  NOTICE: "Notice",
  NEWS: "News",
  PRESS_RELEASE: "Press Release",
  CIRCULAR: "Circular",
  TENDER: "Tender",
  VACANCY: "Vacancy",
  JOB: "Job",
  INTERNSHIP: "Internship",
  OTHER: "Other",
}

export function NoticesDashboardMockup({ notices }: { notices?: ScrapedItem[] }) {
  const windowRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  const rows =
    notices && notices.length > 0
      ? notices.slice(0, 6).map((n) => ({
          id: n.id,
          category: n.category,
          priority: n.aiUrgency === "HIGH" ? "high" : undefined,
          organization: n.sourceLabel,
          title: n.title,
          views: n.views ?? 0,
          publishedAt: n.publishedAt ?? n.scrapedAt,
        }))
      : recentNotices
  const totalCount = notices?.length ? notices.length : mockNotices.length

  useEffect(() => {
    if (!windowRef.current) return

    gsap.set(windowRef.current, { opacity: 0, y: 48 })

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return

          gsap.to(windowRef.current, {
            opacity: 1,
            y: 0,
            duration: 0.9,
            ease: "power3.out",
          })

          if (rowsRef.current) {
            gsap.fromTo(
              Array.from(rowsRef.current.children),
              { opacity: 0, x: -16 },
              {
                opacity: 1,
                x: 0,
                duration: 0.5,
                stagger: 0.08,
                ease: "power2.out",
                delay: 0.4,
              }
            )
          }

          observer.disconnect()
        })
      },
      { threshold: 0.15 }
    )

    observer.observe(windowRef.current)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={windowRef} className="w-full overflow-hidden bg-white">
      {/* ── Title bar ── */}
      <div className="flex h-12 select-none items-center justify-between border-b border-vez-line bg-vez-surface px-5">
        {/* Traffic lights */}
        <div className="flex items-center gap-1.5">
          <span className="size-3 rounded-full bg-[#f87171]" />
          <span className="size-3 rounded-full bg-[#fbbf24]" />
          <span className="size-3 rounded-full bg-[#34d399]" />
        </div>

        {/* Window title */}
        <div className="flex items-center gap-1.5 text-sm text-vez-mute">
          <FileText className="size-3.5" />
          Suchana AI - Dashboard
        </div>

        {/* Spacer */}
        <div className="w-14" />
      </div>

      {/* ── Window body ── */}
      <div className="flex" style={{ height: "420px" }}>
        {/* ── Sidebar ── */}
        <div className="hidden w-48 shrink-0 flex-col border-r border-vez-line bg-vez-surface/60 sm:flex">
          {/* Brand */}
          <div className="flex items-center gap-2 border-b border-vez-line px-4 py-3">
            <Image src={logo} alt="Suchana AI" className="h-8 w-auto" />
          </div>

          {/* Nav */}
          <nav className="flex flex-1 flex-col gap-1 p-3">
            {sidebarItems.map((item) => {
              const Icon = item.icon
              return (
                <div
                  key={item.label}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-full px-4 py-2 text-sm transition-colors ${
                    item.active
                      ? "bg-vez-sky/40 text-vez-navy"
                      : "text-vez-mute hover:bg-white hover:text-vez-ink"
                  }`}
                >
                  <Icon className="size-4 shrink-0" />
                  {item.label}
                </div>
              )
            })}
          </nav>

          {/* Bottom settings */}
          <div className="border-t border-vez-line p-3">
            <div className="flex cursor-pointer items-center gap-2.5 rounded-full px-4 py-2 text-sm text-vez-mute transition-colors hover:bg-white hover:text-vez-ink">
              <Settings className="size-4 shrink-0" />
              Settings
            </div>
          </div>
        </div>

        {/* ── Main content ── */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Content header */}
          <div className="flex shrink-0 items-center justify-between border-b border-vez-line px-6 py-3.5">
            <div className="flex items-center gap-2">
              <Newspaper className="size-4 text-vez-mute" />
              <span className="text-sm text-vez-ink">Latest Notices</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 rounded-full bg-vez-sky/30 px-3 py-1 text-[11px] text-vez-navy">
                <span className="size-1.5 animate-pulse rounded-full bg-vez-navy" />
                Live
              </span>
              <span className="rounded-full bg-vez-surface px-3 py-1 text-[11px] text-vez-mute">
                {totalCount} total
              </span>
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex shrink-0 items-center gap-1.5 border-b border-vez-line px-6 py-2.5">
            {["All", "Urgent", "Tenders", "Exams", "Jobs"].map((tab, i) => (
              <span
                key={tab}
                className={`cursor-pointer rounded-full px-3.5 py-1 text-[11px] transition-colors ${
                  i === 0
                    ? "bg-vez-navy text-white"
                    : "text-vez-mute hover:bg-vez-surface hover:text-vez-ink"
                }`}
              >
                {tab}
              </span>
            ))}
          </div>

          {/* Notices list */}
          <div ref={rowsRef} className="flex-1 divide-y divide-vez-line overflow-y-auto">
            {rows.map((notice, i) => (
              <Link key={notice.id} href={`/notices/${generateSlug(notice.title, notice.id)}`} className="group block">
                <div className="flex items-center gap-3 px-6 py-3.5 transition-colors hover:bg-vez-surface/60">
                  {/* Row number */}
                  <span className="w-5 shrink-0 text-[11px] tabular-nums text-vez-mute">
                    {String(i + 1).padStart(2, "0")}
                  </span>

                  {/* Badges + title */}
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full bg-vez-sky/30 px-2.5 py-0.5 text-[10px] text-vez-navy">
                        {categoryLabels[notice.category] ?? notice.category}
                      </span>
                      {notice.priority === "high" && (
                        <span className="rounded-full bg-vez-navy px-2.5 py-0.5 text-[10px] text-white">
                          Priority
                        </span>
                      )}
                      <span className="truncate text-[10px] text-vez-mute">
                        {notice.organization}
                      </span>
                    </div>
                    <p className="truncate text-xs text-vez-ink transition-colors group-hover:text-vez-navy">
                      {notice.title}
                    </p>
                  </div>

                  {/* Meta */}
                  <div className="hidden shrink-0 flex-col items-end gap-0.5 md:flex">
                    <span className="flex items-center gap-1 text-[10px] text-vez-mute">
                      <Eye className="size-2.5" />
                      {notice.views.toLocaleString()}
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-vez-mute">
                      <Clock className="size-2.5" />
                      {new Date(notice.publishedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>

                  <ChevronRight className="size-3.5 shrink-0 text-vez-mute/50 transition-all group-hover:translate-x-0.5 group-hover:text-vez-navy" />
                </div>
              </Link>
            ))}
          </div>

          {/* Status bar */}
          <div className="flex shrink-0 items-center justify-between border-t border-vez-line px-6 py-2.5">
            <span className="text-[10px] text-vez-mute">
              Showing {rows.length} of {totalCount} notices
            </span>
            <Link href="/notices">
              <span className="cursor-pointer text-[10px] text-vez-navy hover:underline">
                View all →
              </span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
