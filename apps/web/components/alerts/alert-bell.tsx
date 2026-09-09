"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Bell, Loader2, MessageCircle, Mail, BellOff } from "lucide-react"
import { fetchAlertFeed, markAlertFeedRead } from "@/lib/api"
import { AlertFeedEntry, categoryLabel } from "@/lib/types"
import { useAuth } from "@/lib/auth-context"
import { cn } from "@/lib/utils"

const POLL_MS = 60_000

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Small icons for the channels that actually delivered the alert. */
function ChannelMarks({ entry }: { entry: AlertFeedEntry }) {
  if (entry.channels.includes("whatsapp") || entry.channels.includes("email")) {
    return (
      <span className="flex items-center gap-1 text-vez-mute/70">
        {entry.channels.includes("whatsapp") && <MessageCircle className="size-3" />}
        {entry.channels.includes("email") && <Mail className="size-3" />}
      </span>
    )
  }
  if (entry.status === "PENDING") return <span className="text-[10px] text-vez-mute/70">queued</span>
  if (entry.status === "SKIPPED") return <BellOff className="size-3 text-vez-mute/70" />
  return null
}

/**
 * Header bell: opens a panel of recent alert matches. Reads the in-app feed,
 * which records every match whether or not WhatsApp/email took it — so the
 * bell works before any channel is connected.
 */
export function AlertBell({ className }: { className?: string }) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<AlertFeedEntry[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    if (!user) return
    fetchAlertFeed(15)
      .then((feed) => {
        setEntries(feed.entries)
        setUnread(feed.unread)
      })
      .catch(() => undefined)
      .finally(() => setLoading(false))
  }, [user])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  // Close on outside click / Escape, so the panel behaves like a menu.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onClick)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  const handleOpen = () => {
    const next = !open
    setOpen(next)
    if (next && unread > 0) {
      setUnread(0) // optimistic — the badge shouldn't linger while the POST flies
      markAlertFeedRead().catch(() => setUnread(unread))
    }
  }

  if (!user) return null

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={handleOpen}
        className={className}
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        aria-expanded={open}
      >
        <Bell className="size-4" />
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-[18px] border border-vez-line bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-vez-line/60 px-4 py-3">
            <p className="text-sm font-medium text-vez-ink">Alert matches</p>
            <Link
              href="/dashboard/alerts"
              onClick={() => setOpen(false)}
              className="text-xs text-vez-mute underline underline-offset-2 hover:text-vez-navy"
            >
              Manage
            </Link>
          </div>

          <div className="max-h-[min(26rem,60vh)] overflow-y-auto overscroll-contain">
            {loading && (
              <div className="flex justify-center py-8">
                <Loader2 className="size-4 animate-spin text-vez-mute" />
              </div>
            )}

            {!loading && entries.length === 0 && (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-vez-ink">No matches yet</p>
                <p className="mt-1 text-xs leading-relaxed text-vez-mute">
                  Your alerts run against every new notice as it&apos;s scraped. Matches show up here.
                </p>
              </div>
            )}

            {entries.map((entry) => (
              <Link
                key={entry.id}
                href={`/notices/${entry.notice.id}`}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex flex-col gap-1 border-b border-vez-line/40 px-4 py-3 transition-colors last:border-0 hover:bg-vez-sky/10",
                  !entry.readAt && "bg-vez-sky/[0.07]",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="rounded-full bg-vez-sky/40 px-2 py-0.5 text-[10px] font-medium text-vez-navy">
                    {categoryLabel(entry.notice.category)}
                  </span>
                  <span className="shrink-0 text-[10px] text-vez-mute">{relativeTime(entry.matchedAt)}</span>
                </div>
                <p className="line-clamp-2 text-sm leading-snug text-vez-ink">{entry.notice.title}</p>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] text-vez-mute">{entry.ruleName}</span>
                  <ChannelMarks entry={entry} />
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
