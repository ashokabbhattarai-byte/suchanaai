"use client"

import React, { useState, useRef, useEffect, useCallback } from "react"
import { usePathname } from "next/navigation"
import { MessageCircle, X, Send, Bot, User, Sparkles, ExternalLink, FileText, Maximize2, Minimize2, HelpCircle, RotateCcw } from "lucide-react"
import { ChatMarkdown } from "@/components/chat/chat-markdown"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { cn } from "@/lib/utils"
import { searchNotices, askNoticeQuestion, isQuotaError, NoticeSearchResponse, type QuotaDenial } from "@/lib/api"
import { useNoticeContext } from "@/lib/notice-context"
import { useChatStore, type ChatMessage as Message } from "@/lib/chat-store"
import { UpgradePrompt } from "@/components/billing/upgrade-prompt"
import gsap from "gsap"

const GENERAL_SUGGESTIONS = [
  "What exams are coming up?",
  "Latest tender notices",
  "NRB policy updates",
  "Recent vacancy announcements",
]

const NOTICE_SUGGESTIONS = [
  "What is this notice about?",
  "What are the key deadlines?",
  "Who does this affect?",
  "What action should I take?",
]

// Resizing only applies to the floating card layout (sm: and up) — the
// mobile bottom sheet is intentionally full-width/fixed-height.
const DEFAULT_SIZE = { width: 360, height: 520 }
const EXPANDED_SIZE = { width: 480, height: 680 }
const MIN_SIZE = { width: 320, height: 360 }
const SIZE_STORAGE_KEY = "pnm_chat_size"

interface ChatSize {
  width: number
  height: number
}

function clampSize(size: ChatSize): ChatSize {
  const maxWidth = typeof window !== "undefined" ? window.innerWidth - 32 : 720
  const maxHeight = typeof window !== "undefined" ? window.innerHeight - 96 : 800
  return {
    width: Math.min(Math.max(size.width, MIN_SIZE.width), maxWidth),
    height: Math.min(Math.max(size.height, MIN_SIZE.height), maxHeight),
  }
}

export function FloatingChat() {
  const pathname = usePathname()
  // The notice on screen right now — null as soon as the detail page unmounts.
  const { activeNotice } = useNoticeContext()
  // The thread itself lives in a store so route changes can't reset it.
  const open = useChatStore((s) => s.open)
  const setOpen = useChatStore((s) => s.setOpen)
  const messages = useChatStore((s) => s.messages)
  const addMessage = useChatStore((s) => s.addMessage)
  const resetChat = useChatStore((s) => s.resetChat)
  const contextNotice = useChatStore((s) => s.contextNotice)
  const setContextNotice = useChatStore((s) => s.setContextNotice)
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [quota, setQuota] = useState<QuotaDenial | null>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const messagesEnd = useRef<HTMLDivElement>(null)
  const fabRef = useRef<HTMLButtonElement>(null)

  // Custom size the user dragged/toggled to — null means "use the default
  // responsive Tailwind sizing" (no inline override, so mobile's full-width
  // bottom sheet is untouched).
  const [size, setSize] = useState<ChatSize | null>(null)
  const [isDesktop, setIsDesktop] = useState(false)
  const resizingRef = useRef<{ startX: number; startY: number; startSize: ChatSize } | null>(null)

  // Resizing is a floating-card-only affordance — track the sm: breakpoint
  // so drag/maximize never applies to the mobile bottom sheet.
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 640px)")
    setIsDesktop(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(SIZE_STORAGE_KEY)
      if (saved) setSize(clampSize(JSON.parse(saved)))
    } catch {
      // ignore — falls back to default responsive sizing
    }
  }, [])

  const persistSize = useCallback((next: ChatSize) => {
    setSize(next)
    try {
      window.localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // ignore
    }
  }, [])

  const toggleMaximize = useCallback(() => {
    const isExpanded = size && size.width >= EXPANDED_SIZE.width
    persistSize(clampSize(isExpanded ? DEFAULT_SIZE : EXPANDED_SIZE))
  }, [size, persistSize])

  // Dragged from the top-left grip — the panel is anchored bottom-right, so
  // growing width/height means moving the opposite (top-left) edge outward,
  // i.e. subtracting the pointer's delta rather than adding it.
  //
  // Window-level listeners (not pointer capture) track the drag: they keep
  // receiving move/up events no matter where the cursor ends up, without
  // depending on setPointerCapture succeeding on every input source. Setting
  // `user-select: none` on <body> for the duration is what actually stops
  // the page underneath from showing a text-selection highlight while
  // dragging past it.
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const base = size ?? DEFAULT_SIZE
    resizingRef.current = { startX: e.clientX, startY: e.clientY, startSize: base }
    document.body.style.userSelect = "none"

    const onMove = (ev: PointerEvent) => {
      const drag = resizingRef.current
      if (!drag) return
      const next = clampSize({
        width: drag.startSize.width - (ev.clientX - drag.startX),
        height: drag.startSize.height - (ev.clientY - drag.startY),
      })
      setSize(next)
    }
    const onUp = () => {
      resizingRef.current = null
      document.body.style.userSelect = ""
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      setSize((current) => {
        if (current) {
          try {
            window.localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(current))
          } catch {
            // ignore
          }
        }
        return current
      })
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }, [size])

  // Adopt whatever notice is on screen as the thread's context, and keep it
  // after navigating away — leaving the page is not "I'm done with this
  // notice", so follow-ups still resolve against it. The thread is only
  // cleared by the explicit "New chat" control.
  useEffect(() => {
    if (activeNotice && activeNotice.id !== contextNotice?.id) {
      setContextNotice(activeNotice)
    }
  }, [activeNotice, contextNotice?.id, setContextNotice])

  useEffect(() => {
    if (fabRef.current) {
      gsap.fromTo(fabRef.current,
        { scale: 0, rotation: -90 },
        { scale: 1, rotation: 0, duration: 0.5, ease: "back.out(2)", delay: 1 }
      )
    }
  }, [])

  useEffect(() => {
    if (open && chatRef.current) {
      gsap.fromTo(chatRef.current,
        { opacity: 0, scale: 0.9, y: 20 },
        { opacity: 1, scale: 1, y: 0, duration: 0.3, ease: "power2.out" }
      )
    }
  }, [open])

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, loading])

  const handleSend = useCallback(async (text?: string, skipClarification = false) => {
    const query = text || input.trim()
    if (!query || loading) return

    const userMsg: Message = { id: Date.now().toString(), role: "user", content: query }
    addMessage(userMsg)
    setInput("")
    setLoading(true)
    setQuota(null)

    try {
      // Answer from the thread's notice — which outlives the detail page, so
      // a follow-up asked from the dashboard still resolves against it.
      if (contextNotice?.id && contextNotice.contentText) {
        const isAboutCurrentNotice = isNoticeRelatedQuery(query, contextNotice.title)

        if (isAboutCurrentNotice) {
          const { answer } = await askNoticeQuestion(contextNotice.id, query)
          const botMsg: Message = {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content: answer,
            contextUsed: "notice",
          }
          addMessage(botMsg)
          return
        }
      }

      // General notice search, scoped to the filter the user is looking at:
      // asking "latest tender notices" from /notices?category=TENDER should
      // not answer with vacancies. Read at send time from the URL rather than
      // via useSearchParams, which would force a Suspense boundary around
      // every page this floating widget is mounted on.
      const result: NoticeSearchResponse = await searchNotices(
        query,
        activeCategoryFromUrl(),
        undefined,
        skipClarification,
      )
      const botMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: result.answer,
        sources: result.sources?.length ? result.sources : undefined,
        contextUsed: "general",
        clarification: result.clarification,
        clarifiedFrom: result.clarification ? query : undefined,
      }
      addMessage(botMsg)
    } catch (e) {
      // A spent AI allowance is a billing state, not a chat failure — surface
      // it as an upgrade prompt below the composer instead of a bot apology.
      if (isQuotaError(e)) {
        setQuota(e.quota)
        return
      }
      const errorMsg: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: "Sorry, I couldn't process that request right now. Please try again.",
      }
      addMessage(errorMsg)
    } finally {
      setLoading(false)
    }
  }, [input, loading, contextNotice, addMessage])

  if (pathname?.startsWith("/documents")) return null

  const suggestions = contextNotice ? NOTICE_SUGGESTIONS : GENERAL_SUGGESTIONS
  const subtitle = contextNotice
    ? `Answering about: ${contextNotice.title.slice(0, 40)}${contextNotice.title.length > 40 ? "…" : ""}`
    : "Ask about any government notice"

  return (
    <>
      {/* Chat Panel — full-width bottom sheet on mobile, floating card from sm: up */}
      {open && (
        <div
          ref={chatRef}
          style={isDesktop && size ? { width: size.width, height: size.height, maxHeight: "none" } : undefined}
          className={cn(
            "fixed z-[60] flex flex-col overflow-hidden border border-border/60 bg-card/95 backdrop-blur-xl shadow-2xl",
            "inset-x-0 bottom-0 h-[85vh] rounded-t-2xl",
            // Smaller footprint than before (was 400x540, ~75vh) — it was
            // covering page controls (action buttons, title) on narrower or
            // shorter desktop viewports. max-h keeps it well clear of the
            // top of the page even on short windows. Overridden by `style`
            // above once the user has dragged/maximized to a custom size.
            "sm:inset-x-auto sm:bottom-6 sm:right-6 sm:h-[65vh] sm:max-h-[480px] sm:w-[360px] sm:rounded-2xl",
          )}
        >
          {/* Resize grip — floating-card layout only; drag to grow toward the
              top-left since the panel is anchored bottom-right. */}
          {isDesktop && (
            <div
              onPointerDown={handleResizeStart}
              role="separator"
              aria-label="Resize chat window"
              className="absolute left-0 top-0 z-10 flex size-5 touch-none select-none items-start justify-start p-1 text-muted-foreground/50 hover:text-muted-foreground cursor-nwse-resize"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="pointer-events-none">
                <path d="M9 1L1 9M9 5L5 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </div>
          )}

          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-border/60 bg-primary/5">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="size-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Bot className="size-4 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold">Suchana AI</p>
                <p className="text-[10px] text-muted-foreground truncate max-w-[200px]">{subtitle}</p>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {messages.length > 0 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={resetChat}
                  aria-label="Start a new chat"
                  title="New chat"
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              )}
              {isDesktop && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={toggleMaximize}
                  aria-label={size && size.width >= EXPANDED_SIZE.width ? "Restore chat size" : "Expand chat"}
                  title={size && size.width >= EXPANDED_SIZE.width ? "Restore size" : "Expand"}
                >
                  {size && size.width >= EXPANDED_SIZE.width ? (
                    <Minimize2 className="size-3.5" />
                  ) : (
                    <Maximize2 className="size-3.5" />
                  )}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => setOpen(false)}
                aria-label="Close chat"
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>

          {/* Context badge */}
          {contextNotice && (
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border/40 bg-primary/3">
              <FileText className="size-3 text-primary shrink-0" />
              <p className="text-[10px] text-primary truncate flex-1">
                Context: {contextNotice.title}
              </p>
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary shrink-0">
                Locked
              </span>
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-center py-6">
                <div className="size-12 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-3">
                  <Sparkles className="size-6 text-primary" />
                </div>
                <p className="text-sm font-medium mb-1">
                  {contextNotice ? "Ask about this notice" : "How can I help?"}
                </p>
                <p className="text-xs text-muted-foreground mb-4">
                  {contextNotice
                    ? "I have the full context of this notice — ask me anything"
                    : "Ask about notices, exams, tenders, or policies"}
                </p>
                <div className="flex flex-wrap gap-1.5 justify-center">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      onClick={() => handleSend(s)}
                      className="text-[11px] px-2.5 py-1.5 rounded-full border border-border/60 hover:border-primary/40 hover:bg-primary/5 transition-colors text-muted-foreground hover:text-foreground"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => (
              <div key={msg.id} className={cn("flex gap-2", msg.role === "user" ? "justify-end" : "")}>
                {msg.role === "assistant" && (
                  <div className="size-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="size-3 text-primary" />
                  </div>
                )}
                <div className="max-w-[80%]">
                  <div className={cn(
                    "rounded-xl px-3 py-2 text-xs leading-relaxed",
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground rounded-br-sm"
                      : "bg-accent/60 rounded-bl-sm"
                  )}>
                    {msg.role === "assistant" ? (
                      <ChatMarkdown content={msg.content} />
                    ) : (
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                    )}
                  </div>
                  {msg.role === "assistant" && (
                    <div className="mt-0.5 flex items-center gap-2">
                      {msg.contextUsed === "notice" && (
                        <p className="flex items-center gap-1 text-[9px] text-muted-foreground">
                          <FileText className="size-2.5" /> From current notice
                        </p>
                      )}
                      <CopyButton text={msg.content} className="-ml-1.5" />
                    </div>
                  )}
                  {/* Ambiguous question — offer the specific subjects the
                      corpus can actually answer, instead of guessing one. */}
                  {msg.clarification && msg.clarification.options.length > 0 && (
                    <div className="mt-1.5 rounded-xl border border-border/60 bg-background/60 p-2">
                      <p className="mb-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                        <HelpCircle className="size-2.5 shrink-0" /> Pick one to get an exact answer
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {msg.clarification.options.map((opt) => (
                          <button
                            key={opt.query}
                            onClick={() => handleSend(opt.query)}
                            disabled={loading}
                            className="rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-[11px] text-foreground transition-colors hover:border-primary/60 hover:bg-primary/10 disabled:opacity-50"
                          >
                            {opt.label}
                          </button>
                        ))}
                        {msg.clarifiedFrom && (
                          <button
                            onClick={() => handleSend(msg.clarifiedFrom, true)}
                            disabled={loading}
                            className="rounded-full border border-border/60 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50"
                          >
                            Show all
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="mt-1.5 space-y-1">
                      {msg.sources.slice(0, 3).map((src) => (
                        <a
                          key={src.id}
                          href={`/notices/${src.id}`}
                          className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-primary transition-colors group"
                        >
                          <ExternalLink className="size-2.5 shrink-0 opacity-50 group-hover:opacity-100" />
                          <span className="truncate">{src.title}</span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                {msg.role === "user" && (
                  <div className="size-6 rounded-full bg-accent flex items-center justify-center shrink-0 mt-0.5">
                    <User className="size-3" />
                  </div>
                )}
              </div>
            ))}

            {loading && (
              <div className="flex gap-2">
                <div className="size-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Bot className="size-3 text-primary" />
                </div>
                <div className="bg-accent/60 rounded-xl rounded-bl-sm px-3 py-2">
                  <div className="flex gap-1">
                    <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce" style={{ animationDelay: "300ms" }} />
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEnd} />
          </div>

          {/* Input */}
          <div className="p-3 border-t border-border/60" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
            {quota && (
              <div className="mb-2">
                <UpgradePrompt quota={quota} compact onDismiss={() => setQuota(null)} />
              </div>
            )}
            <form onSubmit={(e) => { e.preventDefault(); handleSend() }} className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={contextNotice ? "Ask about this notice…" : "Ask about notices..."}
                className="flex-1 h-9 rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus:border-primary/50 transition-colors"
                disabled={loading}
              />
              <Button type="submit" size="icon" className="size-9 rounded-lg shrink-0" disabled={!input.trim() || loading}>
                <Send className="size-3.5" />
              </Button>
            </form>
          </div>
        </div>
      )}

      {/* FAB Button — only shown when the panel is closed; the panel's own
          header X handles closing, so a second floating close button
          hovering over page content underneath (a confusing, cramped look
          especially on mobile) is unnecessary. */}
      {!open && (
        <button
          ref={fabRef}
          onClick={() => setOpen(true)}
          aria-label="Open chat"
          className="fixed right-4 sm:right-6 z-[60] size-14 sm:size-16 rounded-full shadow-2xl flex items-center justify-center transition-all hover:scale-110 active:scale-95 bg-white text-gray-900 ring-4 ring-white/30"
          style={{
            boxShadow: "0 0 20px rgba(255,255,255,0.3), 0 8px 32px rgba(0,0,0,0.4)",
            bottom: "max(1rem, env(safe-area-inset-bottom))",
          }}
        >
          <MessageCircle className="size-6" />
          <span className="absolute -top-1 -right-1 size-5 rounded-full bg-green-400 border-2 border-white flex items-center justify-center animate-pulse">
            <span className="size-2.5 rounded-full bg-white" />
          </span>
        </button>
      )}
    </>
  )
}

/** Categories the notices page can filter by — mirrors ScrapedItemCategory. */
const URL_CATEGORIES = new Set([
  "NOTICE", "NEWS", "PRESS_RELEASE", "CIRCULAR", "TENDER", "VACANCY", "JOB", "INTERNSHIP", "OTHER",
])

/**
 * The category filter currently applied to the notices list, if any, so a
 * question inherits the scope the user can see. Validated against the known
 * enum rather than forwarded blind — the value goes into a server-side
 * category filter.
 */
function activeCategoryFromUrl(): string | undefined {
  if (typeof window === "undefined") return undefined
  const category = new URLSearchParams(window.location.search).get("category")?.toUpperCase()
  return category && URL_CATEGORIES.has(category) ? category : undefined
}

/**
 * Routes a question to the locked notice or to corpus search.
 *
 * The user opened this chat from a notice and the header says "Locked", so the
 * notice is the default context — only an explicit reach for the wider corpus
 * ("other notices", "latest tenders") leaves it. The previous default was the
 * opposite, which sent plain questions like "how many still missing?" to global
 * search and answered a flood notice with unrelated press releases.
 */
function isNoticeRelatedQuery(query: string, noticeTitle: string): boolean {
  const q = query.toLowerCase().trim()

  // Explicit general-corpus signals — never route to single-notice Q&A
  const generalPatterns = [
    /^(show|find|list|search|get)\s+(me\s+)?(all|latest|recent|other|new)\b/,
    /\bother notices\b/,
    /\bdifferent (notice|topic)\b/,
    /\bwhat('s| is) (new|happening|latest)\b/,
    /\bhow many notices\b/,
    /\b(latest|recent|newest) .*(tender|vacancy|notice|circular|job)\b/,
    /\btender notices\b/,
    /\bvacancy\b.*\bnotices\b/,
    /\b(any|all) other\b/,
    /\bsearch (for|the)\b/,
    /\bacross (all )?notices\b/,
  ]
  if (generalPatterns.some((p) => p.test(q))) return false

  // Everything else belongs to the notice the user is reading. `noticeTitle`
  // is no longer needed to decide, but stays in the signature so callers and
  // tests don't change.
  void noticeTitle
  return true
}
