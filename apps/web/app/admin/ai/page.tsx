"use client"

import React, { useCallback, useEffect, useState } from "react"
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  GripVertical,
  Loader2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { AdminLayout } from "@/components/admin/admin-layout"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { Header } from "@/components/layout/header"
import { ProviderDialog } from "@/components/admin/provider-dialog"
import { AiTemperatureCard } from "@/components/admin/ai-temperature-card"
import {
  fetchAiProviders,
  createAiProvider,
  updateAiProvider,
  deleteAiProvider,
  reorderAiProviders,
  testAiProvider,
  fetchAiHealth,
} from "@/lib/api"
import type { AiProvider, AiProviderHealth, AiProviderInput } from "@/lib/types"

export default function AdminAiPage() {
  const confirm = useConfirm()
  const [providers, setProviders] = useState<AiProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  // Health is keyed by slug so a single-provider test updates just that card
  // instead of blowing away every other card's result.
  const [health, setHealth] = useState<Record<string, AiProviderHealth>>({})
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [checkingAll, setCheckingAll] = useState(false)
  const [activeProvider, setActiveProvider] = useState<string | null>(null)

  const [dialogFor, setDialogFor] = useState<AiProvider | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setProviders(await fetchAiProviders())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load providers")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const mergeHealth = (rows: AiProviderHealth[]) =>
    setHealth((h) => ({ ...h, ...Object.fromEntries(rows.map((r) => [r.provider, r])) }))

  const testOne = async (p: AiProvider) => {
    setTesting((t) => ({ ...t, [p.id]: true }))
    try {
      const snap = await testAiProvider(p.id)
      mergeHealth(snap.providers)
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "Test failed." })
    } finally {
      setTesting((t) => ({ ...t, [p.id]: false }))
    }
  }

  const testAll = async () => {
    setCheckingAll(true)
    try {
      const snap = await fetchAiHealth()
      mergeHealth(snap.providers)
      setActiveProvider(snap.activeProvider)
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "Health check failed." })
    } finally {
      setCheckingAll(false)
    }
  }

  const sensors = useSensors(
    // A small distance threshold so a plain click on a card's buttons is not
    // swallowed as the start of a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = providers.findIndex((p) => p.id === active.id)
    const newIndex = providers.findIndex((p) => p.id === over.id)
    const next = arrayMove(providers, oldIndex, newIndex)
    // Optimistic: the list reorders instantly, then the server confirms. On
    // failure we reload rather than guess, so the UI can't drift from truth.
    setProviders(next)
    try {
      setProviders(await reorderAiProviders(next.map((p) => p.id)))
      setNotice({ ok: true, text: "Fallback order updated." })
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "Could not save order." })
      void load()
    }
  }

  const toggleEnabled = async (p: AiProvider) => {
    try {
      const updated = await updateAiProvider(p.id, { enabled: !p.enabled })
      setProviders((list) => list.map((x) => (x.id === p.id ? updated : x)))
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "Could not update." })
    }
  }

  const remove = async (p: AiProvider) => {
    if (
      !(await confirm({
        title: `Delete "${p.label}"?`,
        description: "Its stored API key is deleted too.",
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return
    try {
      await deleteAiProvider(p.id)
      setProviders((list) => list.filter((x) => x.id !== p.id))
      setNotice({ ok: true, text: `${p.label} deleted.` })
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : "Could not delete." })
    }
  }

  const submitDialog = async (input: Partial<AiProviderInput>) => {
    if (dialogFor) {
      const updated = await updateAiProvider(dialogFor.id, input)
      setProviders((list) => list.map((x) => (x.id === dialogFor.id ? updated : x)))
      setNotice({ ok: true, text: `${updated.label} updated.` })
    } else {
      const created = await createAiProvider(input as AiProviderInput)
      setProviders((list) => [...list, created])
      setNotice({ ok: true, text: `${created.label} added.` })
    }
  }

  const enabled = providers.filter((p) => p.enabled)

  return (
    <div className="min-h-screen bg-white font-poppins">
      <Header />
      <AdminLayout>
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[clamp(28px,3vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
              AI &amp; Models.
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-vez-mute">
              Add any provider, set the fallback order by dragging, and test each one
              individually. Keys are encrypted at rest and never shown again once saved.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={testAll}
              disabled={checkingAll}
              className="flex items-center gap-2 rounded-full border border-vez-line px-4 py-2.5 text-sm text-vez-ink transition-colors hover:bg-vez-surface disabled:opacity-50"
            >
              {checkingAll ? <Loader2 className="size-4 animate-spin" /> : <Activity className="size-4" />}
              Test all
            </button>
            <button
              onClick={() => {
                setDialogFor(null)
                setDialogOpen(true)
              }}
              className="flex items-center gap-2 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity hover:opacity-90"
            >
              <Plus className="size-4" /> Add provider
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-5 flex items-center gap-2 rounded-[14px] bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertCircle className="size-4 shrink-0" /> {error}
            <button onClick={load} className="ml-auto font-medium underline underline-offset-2">
              Retry
            </button>
          </div>
        )}

        {notice && (
          <div
            className={`mb-5 flex items-start gap-2 rounded-[14px] px-4 py-3 text-sm ${
              notice.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"
            }`}
          >
            {notice.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            ) : (
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1">{notice.text}</span>
            <button onClick={() => setNotice(null)} className="shrink-0 text-xs underline">
              Dismiss
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-3 rounded-[20px] border border-vez-line bg-white p-6 sm:p-10 text-sm text-vez-mute">
            <Loader2 className="size-4 animate-spin text-vez-navy" /> Loading providers…
          </div>
        ) : (
          <div className="w-full overflow-hidden">
            <AiTemperatureCard />

            {/* Fallback chain summary */}
            <div className="mb-5 flex flex-wrap items-center gap-2 rounded-[16px] border border-vez-line bg-white p-4 sm:px-5 sm:py-4 overflow-x-auto">
              <Sparkles className="size-4 shrink-0 text-vez-navy" />
              <span className="text-sm text-vez-ink">Fallback order</span>
              <span className="text-xs text-vez-mute">· tried top to bottom</span>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                {enabled.length === 0 ? (
                  <span className="text-xs text-red-600">No providers enabled</span>
                ) : (
                  enabled.map((p, i) => (
                    <React.Fragment key={p.id}>
                      {i > 0 && <span className="text-vez-mute">→</span>}
                      <span className="rounded-full bg-vez-surface px-2.5 py-1 text-xs text-vez-ink">
                        {p.label}
                      </span>
                    </React.Fragment>
                  ))
                )}
              </div>
            </div>

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={providers.map((p) => p.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-3">
                  {providers.map((p, index) => (
                    <ProviderCard
                      key={p.id}
                      provider={p}
                      rank={index + 1}
                      health={health[p.slug]}
                      testing={Boolean(testing[p.id])}
                      inUse={activeProvider === p.slug}
                      onTest={() => testOne(p)}
                      onToggle={() => toggleEnabled(p)}
                      onEdit={() => {
                        setDialogFor(p)
                        setDialogOpen(true)
                      }}
                      onDelete={() => remove(p)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            {providers.length === 0 && (
              <div className="rounded-[20px] border border-dashed border-vez-line bg-vez-surface/40 p-10 text-center">
                <p className="text-sm text-vez-ink">No providers configured.</p>
                <p className="mt-1 text-xs text-vez-mute">
                  Add one to enable AI answers, summaries and classification.
                </p>
              </div>
            )}
          </div>
        )}

        {dialogOpen && (
          <ProviderDialog
            provider={dialogFor}
            onClose={() => setDialogOpen(false)}
            onSubmit={submitDialog}
          />
        )}
      </AdminLayout>
    </div>
  )
}

function ProviderCard({
  provider,
  rank,
  health,
  testing,
  inUse,
  onTest,
  onToggle,
  onEdit,
  onDelete,
}: {
  provider: AiProvider
  rank: number
  health?: AiProviderHealth
  testing: boolean
  inUse: boolean
  onTest: () => void
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: provider.id,
  })

  const dot = !provider.enabled
    ? "bg-vez-line"
    : health?.ok
      ? "bg-green-500"
      : health
        ? "bg-red-500"
        : provider.configured
          ? "bg-vez-sky"
          : "bg-vez-line"

  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`overflow-hidden rounded-[18px] border bg-white transition-shadow ${
        isDragging ? "z-10 shadow-xl" : ""
      } ${provider.enabled ? "border-vez-line" : "border-dashed border-vez-line bg-vez-surface/30"}`}
    >
      <div className="flex flex-wrap items-center gap-2.5 px-4 py-3.5">
        {/* Drag handle is its own control, so the card's buttons stay clickable
            and keyboard users get a focusable, operable reorder affordance. */}
        <button
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${provider.label}`}
          className="cursor-grab touch-none rounded-lg p-1 text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-ink active:cursor-grabbing"
        >
          <GripVertical className="size-4" />
        </button>

        <span className={`size-2.5 shrink-0 rounded-full ${dot}`} />
        {provider.enabled && (
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-vez-navy text-[10px] font-medium text-white">
            {rank}
          </span>
        )}

        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span
            className={`text-[15px] ${provider.enabled ? "text-vez-ink" : "text-vez-mute line-through"}`}
          >
            {provider.label}
          </span>
          <span className="font-mono text-[11px] text-vez-mute">{provider.model}</span>
        </div>

        {inUse && (
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700">
            in use
          </span>
        )}
        {!provider.isBuiltIn && (
          <span className="rounded-full bg-vez-sky/25 px-2 py-0.5 text-[10px] font-medium text-vez-navy">
            custom
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            onClick={onTest}
            disabled={testing}
            title="Test this provider"
            className="flex items-center gap-1.5 rounded-full border border-vez-line px-3 py-1.5 text-xs text-vez-ink transition-colors hover:bg-vez-surface disabled:opacity-50"
          >
            {testing ? <Loader2 className="size-3 animate-spin" /> : <Activity className="size-3" />}
            Test
          </button>
          <button
            onClick={onEdit}
            title="Edit"
            className="flex size-8 items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy"
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            onClick={onToggle}
            title={provider.enabled ? "Disable" : "Enable"}
            className={`flex size-8 items-center justify-center rounded-full transition-colors ${
              provider.enabled
                ? "text-vez-mute hover:bg-red-50 hover:text-red-600"
                : "text-vez-mute hover:bg-vez-surface hover:text-vez-navy"
            }`}
          >
            <Power className="size-3.5" />
          </button>
          {!provider.isBuiltIn && (
            <button
              onClick={onDelete}
              title="Delete"
              className="flex size-8 items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-red-50 hover:text-red-600"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-vez-line px-4 py-2.5 text-xs">
        <span className="flex items-center gap-1.5">
          {provider.configured ? (
            <span className="flex items-center gap-1.5 text-emerald-700">
              <ShieldCheck className="size-3.5" /> {provider.preview ?? "Key stored"}
            </span>
          ) : (
            <span className="text-vez-mute">Using the server env var</span>
          )}
        </span>

        {health ? (
          health.ok ? (
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="flex items-center gap-1.5 text-green-700">
                <CheckCircle2 className="size-3.5" /> Responding
                <span className="tabular-nums text-vez-mute">· {health.latencyMs} ms</span>
              </span>
              {health.note && (
                <span className="flex min-w-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">
                  <RefreshCw className="size-3 shrink-0" />
                  <span className="min-w-0 break-words">{health.note}</span>
                </span>
              )}
            </span>
          ) : (
            <span className="flex min-w-0 items-start gap-1.5 text-red-600">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{health.error}</span>
            </span>
          )
        ) : (
          <span className="text-vez-mute">Not tested yet</span>
        )}
      </div>
    </section>
  )
}
