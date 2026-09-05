"use client"

import { create } from "zustand"
import type { SearchClarification } from "@/lib/api"
import type { NoticeContext } from "@/lib/notice-context"

export interface ChatSource {
  id: string
  title: string
  category: string
  sourceUrl: string
}

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  sources?: ChatSource[]
  contextUsed?: "notice" | "general"
  // Present instead of an answer when the question was ambiguous against the
  // corpus; rendered as pickable choices rather than prose.
  clarification?: SearchClarification
  // The question that triggered the clarification, so "Show all" can re-ask
  // it with the gate bypassed.
  clarifiedFrom?: string
}

interface ChatState {
  open: boolean
  messages: ChatMessage[]
  /**
   * The notice this thread is about. Set when the user opens a notice and
   * deliberately kept afterwards: `NoticeContextProvider` nulls its own value
   * when the detail page unmounts, which used to wipe the conversation and
   * its context the moment you navigated anywhere else.
   */
  contextNotice: NoticeContext | null

  setOpen: (open: boolean) => void
  addMessage: (message: ChatMessage) => void
  setContextNotice: (notice: NoticeContext) => void
  resetChat: () => void
}

/**
 * In-memory chat state, shared by every route.
 *
 * Intentionally *not* persisted: the thread has to survive client-side
 * navigation (notice → dashboard → landing) but start clean on a hard reload,
 * so a plain module-level store is exactly the lifetime we want.
 */
export const useChatStore = create<ChatState>((set) => ({
  open: false,
  messages: [],
  contextNotice: null,

  setOpen: (open) => set({ open }),
  addMessage: (message) => set((s) => ({ messages: [...s.messages, message] })),
  setContextNotice: (notice) => set({ contextNotice: notice }),
  resetChat: () => set({ messages: [], contextNotice: null }),
}))
