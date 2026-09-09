"use client"

import React from "react"
import Link from "next/link"
import { FileText, Trash2, AlertCircle } from "lucide-react"
import { Header } from "@/components/layout/header"
import { DashboardLayout } from "@/components/dashboard/dashboard-layout"
import { useAuth } from "@/lib/auth-context"
export default function SavedNoticesPage() {
  const { user } = useAuth()

  if (!user) {
    return (
      <div className="min-h-screen bg-white font-poppins">
        <Header />
        <div className="flex items-center justify-center py-32">
          <div className="w-full max-w-sm rounded-[24px] bg-vez-surface p-10 text-center">
            <AlertCircle className="mx-auto mb-4 size-10 text-vez-mute" />
            <h2 className="mb-1 text-lg text-vez-ink">Sign in required</h2>
            <p className="mb-6 text-sm text-vez-mute">Please sign in to view saved notices.</p>
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

  // Real saved notices — backend does not yet persist bookmarks, so this reflects the current session.
  // When the save API lands, replace this with fetchSavedNotices().
  const savedNotices: Array<{ id: string; title: string; description: string; category: string; organization: string; publishedAt: string }> = []

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-white font-poppins">
      <Header />
      <DashboardLayout>
        <div className="mb-6 w-full max-w-full min-w-0 overflow-hidden sm:mb-8">
          <h1 className="break-words text-[clamp(22px,6vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
            Saved notices.
          </h1>
          <p className="mt-1 text-sm text-vez-mute sm:mt-2">{savedNotices.length} notices saved</p>
        </div>

        <div className="w-full max-w-full min-w-0 space-y-3 overflow-hidden">
          {savedNotices.length === 0 ? (
            <div className="rounded-[20px] bg-white p-8 sm:p-10 text-center">
              <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-vez-sky/20">
                <FileText className="size-6 text-vez-navy" />
              </div>
              <h3 className="text-sm font-medium text-vez-ink">No saved notices yet</h3>
              <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-vez-mute">Bookmark notices from the browse page to see them here. Your personal collection stays in sync with your account.</p>
              <Link href="/notices" className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white hover:opacity-90">Browse notices →</Link>
            </div>
          ) : (
            savedNotices.map((notice) => (
              <div
                key={notice.id}
                className="flex w-full max-w-full min-w-0 flex-col gap-3 overflow-hidden rounded-[16px] bg-white p-4 transition-colors hover:bg-vez-sky/10 sm:flex-row sm:items-start sm:gap-4 sm:p-5"
              >
                <div className="flex min-w-0 flex-1 items-start gap-3 sm:gap-4">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-vez-sky/30 sm:size-10">
                    <FileText className="size-3.5 text-vez-navy sm:size-4" />
                  </div>
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <p className="break-words text-sm font-medium text-vez-ink sm:truncate sm:text-base">{notice.title}</p>
                    <p className="mt-1 line-clamp-2 break-words text-sm text-vez-mute">{notice.description}</p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5 sm:gap-2.5">
                      <span className="shrink-0 rounded-full bg-vez-sky/30 px-2.5 py-0.5 text-xs capitalize text-vez-navy sm:px-3">{notice.category}</span>
                      <span className="min-w-0 truncate text-xs text-vez-mute">{notice.organization}</span>
                      <span className="shrink-0 text-xs text-vez-mute">· {new Date(notice.publishedAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
                <button
                  className="flex size-9 shrink-0 items-center justify-center self-start rounded-full text-vez-mute transition-colors hover:bg-red-50 hover:text-red-600 sm:self-auto"
                  aria-label="Remove saved notice"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))
          )}
        </div>
      </DashboardLayout>
    </div>
  )
}
