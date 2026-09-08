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
    <div ref={windowRef} className="w-full overflow-hidden bg-white rounded-xl sm:rounded-2xl border border-vez-line shadow-sm hover:shadow-md transition-shadow">
      {/* ── Title bar ── */}
      <div className="flex h-10 sm:h-12 select-none items-center justify-between border-b border-vez-line bg-vez-surface px-4 sm:px-5">
        {/* Traffic lights */}
        <div className="flex items-center gap-1 sm:gap-1.5">
          <span className="size-2.5 sm:size-3 rounded-full bg-[#f87171]" />
          <span className="size-2.5 sm:size-3 rounded-full bg-[#fbbf24]" />
          <span className="size-2.5 sm:size-3 rounded-full bg-[#34d399]" />
        </div>

        {/* Window title */}
        <div className="flex items-center gap-1.5 text-xs sm:text-sm font-poppins tracking-tight text-vez-mute truncate">
          <FileText className="size-3 sm:size-3.5 shrink-0" />
          <span className="hidden sm:inline">Suchana AI - Dashboard</span>
          <span className="sm:hidden">Dashboard</span>
        </div>

        {/* Spacer */}
        <div className="w-10 sm:w-14" />
      </div>

      {/* ── Window body ── */}
      <div className="flex h-[320px] sm:h-[380px] lg:h-[420px] aspect-[4/3] sm:aspect-[16/10] lg:aspect-[16/9] max-w-full">
        {/* ── Sidebar ── visible on all, compact on mobile */}
        <div className="flex w-[56px] sm:w-40 lg:w-48 shrink-0 flex-col border-r border-vez-line bg-vez-surface/60">
          {/* Brand */}
          <div className="flex items-center gap-2 border-b border-vez-line px-3 sm:px-4 py-2 sm:py-3">
            <Image src={logo} alt="Suchana AI" className="h-6 sm:h-8 w-auto object-contain" />
          </div>

          {/* Nav */}
          <nav className="flex flex-1 flex-col gap-1 p-1 sm:p-3 items-center sm:items-stretch">
            {sidebarItems.map((item) => {
              const Icon = item.icon
              return (
                <div
                  key={item.label}
                  className={`flex cursor-pointer items-center justify-center sm:justify-start gap-2 sm:gap-2.5 rounded-full px-2 sm:px-4 py-2 sm:py-2 text-xs sm:text-sm font-poppins tracking-tight transition-colors ${
                    item.active
                      ? "bg-vez-sky/40 text-vez-navy"
                      : "text-vez-mute hover:bg-white hover:text-vez-ink"
                  }`}
                >
                  <Icon className="size-4 sm:size-4 shrink-0" />
                  <span className="hidden sm:inline truncate">{item.label}</span>
                </div>
              )
            })}
          </nav>

          {/* Bottom settings */}
          <div className="border-t border-vez-line p-1 sm:p-3 flex justify-center sm:justify-start">
            <div className="flex cursor-pointer items-center justify-center sm:justify-start gap-2 sm:gap-2.5 rounded-full px-2 sm:px-4 py-2 text-xs sm:text-sm font-poppins tracking-tight text-vez-mute transition-colors hover:bg-white hover:text-vez-ink">
              <Settings className="size-4 sm:size-4 shrink-0" />
              <span className="hidden sm:inline">Settings</span>
            </div>
          </div>
        </div>

        {/* ── Main content ── */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Content header */}
          <div className="flex shrink-0 items-center justify-between border-b border-vez-line px-3 sm:px-6 py-2.5 sm:py-3.5 gap-2 sm:gap-4">
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
              <Newspaper className="size-3.5 sm:size-4 text-vez-mute shrink-0" />
              <span className="text-xs sm:text-sm font-poppins tracking-tight text-vez-ink truncate">Latest Notices</span>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              <span className="flex items-center gap-1 sm:gap-1.5 rounded-full bg-vez-sky/30 px-2 sm:px-3 py-1 text-[10px] sm:text-[11px] font-poppins text-vez-navy">
                <span className="size-1 sm:size-1.5 animate-pulse rounded-full bg-vez-navy" />
                Live
              </span>
              <span className="hidden sm:flex rounded-full bg-vez-surface px-3 py-1 text-[11px] text-vez-mute font-poppins">
                {totalCount} total
              </span>
            </div>
          </div>

          {/* Tab bar */}
          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5 border-b border-vez-line px-3 sm:px-6 py-2 sm:py-2.5 overflow-x-auto scrollbar-none">
            {["All", "Urgent", "Tenders", "Exams", "Jobs"].map((tab, i) => (
              <span
                key={tab}
                className={`cursor-pointer shrink-0 rounded-full px-3 sm:px-3.5 py-1 text-[10px] sm:text-[11px] font-poppins tracking-tight transition-colors min-h-[28px] flex items-center ${
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
          <div ref={rowsRef} className="flex-1 divide-y divide-vez-line overflow-y-auto overscroll-contain">
            {rows.map((notice, i) => (
              <Link key={notice.id} href={`/notices/${generateSlug(notice.title, notice.id)}`} className="group block">
                <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-6 py-2.5 sm:py-3.5 transition-colors hover:bg-vez-surface/60">
                  {/* Row number */}
                  <span className="hidden sm:block w-5 shrink-0 text-[11px] tabular-nums text-vez-mute font-poppins">
                    {String(i + 1).padStart(2, "0")}
                  </span>

                  {/* Badges + title */}
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-1 sm:gap-1.5">
                      <span className="rounded-full bg-vez-sky/30 px-2 sm:px-2.5 py-0.5 text-[10px] font-poppins text-vez-navy">
                        {categoryLabels[notice.category] ?? notice.category}
                      </span>
                      {notice.priority === "high" && (
                        <span className="rounded-full bg-vez-navy px-2 sm:px-2.5 py-0.5 text-[10px] font-poppins text-white">
                          Priority
                        </span>
                      )}
                      <span className="hidden sm:inline truncate text-[10px] text-vez-mute font-poppins">
                        {notice.organization}
                      </span>
                    </div>
                    <p className="truncate text-xs sm:text-xs font-poppins tracking-tight text-vez-ink transition-colors group-hover:text-vez-navy leading-tight">
                      {notice.title}
                    </p>
                  </div>

                  {/* Meta */}
                  <div className="hidden shrink-0 flex-col items-end gap-0.5 md:flex">
                    <span className="flex items-center gap-1 text-[10px] text-vez-mute font-poppins">
                      <Eye className="size-2.5" />
                      {notice.views.toLocaleString()}
                    </span>
                    <span className="flex items-center gap-1 text-[10px] text-vez-mute font-poppins">
                      <Clock className="size-2.5" />
                      {new Date(notice.publishedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>

                  <ChevronRight className="size-3 sm:size-3.5 shrink-0 text-vez-mute/50 transition-all group-hover:translate-x-0.5 group-hover:text-vez-navy" />
                </div>
              </Link>
            ))}
          </div>

          {/* Status bar */}
          <div className="flex shrink-0 items-center justify-between border-t border-vez-line px-3 sm:px-6 py-2 sm:py-2.5 gap-2">
            <span className="text-[10px] sm:text-xs text-vez-mute font-poppins truncate">
              Showing {rows.length} of {totalCount}
            </span>
            <Link href="/notices" className="shrink-0">
              <span className="cursor-pointer text-[10px] sm:text-xs text-vez-navy hover:underline font-poppins tracking-tight min-h-[44px] sm:min-h-0 flex items-center px-2">
                View all →
              </span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
