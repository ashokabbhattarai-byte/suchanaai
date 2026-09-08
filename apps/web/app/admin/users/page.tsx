"use client"

import React, { useCallback, useEffect, useState } from "react"
import {
  Search,
  UserPlus,
  Edit,
  Trash2,
  Shield,
  ShieldOff,
  Loader2,
  AlertCircle,
  X,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Ban,
  CheckCircle2,
  Mail,
  User,
} from "lucide-react"
import { AdminLayout } from "@/components/admin/admin-layout"
import { useConfirm } from "@/components/ui/confirm-dialog"
import { Header } from "@/components/layout/header"
import { useAuth } from "@/lib/auth-context"
import { toast } from "sonner"
import {
  fetchAdminUsers,
  createAdminUser,
  updateAdminUser,
  deleteAdminUser,
  type AdminUser,
} from "@/lib/api"

const PAGE_SIZE = 20

const fieldClass =
  "w-full rounded-[12px] border border-vez-line bg-white px-4 py-3 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-sky"

function formatDate(d: string | null) {
  if (!d) return "—"
  return new Date(d).toLocaleDateString()
}

function formatDateTime(d: string | null) {
  if (!d) return "Never"
  return new Date(d).toLocaleString()
}

export default function AdminUsersPage() {
  const confirm = useConfirm()
  const { user: me } = useAuth()

  const [users, setUsers] = useState<AdminUser[]>([])
  const [meta, setMeta] = useState({ page: 1, limit: PAGE_SIZE, total: 0, totalPages: 1 })
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [roleFilter, setRoleFilter] = useState<"" | "admin" | "user">("")
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "inactive">("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // Modals
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState({ name: "", email: "", role: "user" as "user" | "admin", status: "active" as "active" | "inactive" })
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [editing, setEditing] = useState<AdminUser | null>(null)
  const [editForm, setEditForm] = useState({ name: "", email: "", role: "user" as "user" | "admin", status: "active" as "active" | "inactive" })
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const [deleting, setDeleting] = useState<AdminUser | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // debounce search
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 300)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    setPage(1)
  }, [roleFilter, statusFilter])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchAdminUsers({
        page,
        limit: PAGE_SIZE,
        search: debouncedSearch || undefined,
        role: roleFilter || undefined,
        status: statusFilter || undefined,
        sortBy: "createdAt",
        sortOrder: "desc",
      })
      setUsers(res.data ?? [])
      setMeta(res.meta ?? { page, limit: PAGE_SIZE, total: 0, totalPages: 1 })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users")
    } finally {
      setLoading(false)
    }
  }, [page, debouncedSearch, roleFilter, statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  const activeFilterCount = [roleFilter, statusFilter, debouncedSearch].filter(Boolean).length

  function clearFilters() {
    setSearch("")
    setDebouncedSearch("")
    setRoleFilter("")
    setStatusFilter("")
    setPage(1)
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (!createForm.name.trim() || !createForm.email.trim()) {
      setCreateError("Name and email are required")
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      await createAdminUser({
        name: createForm.name.trim(),
        email: createForm.email.trim(),
        role: createForm.role,
        status: createForm.status,
      })
      toast.success("User created — they can sign in with Google")
      setShowCreate(false)
      setCreateForm({ name: "", email: "", role: "user", status: "active" })
      await load()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create user")
    } finally {
      setCreating(false)
    }
  }

  function openEdit(u: AdminUser) {
    setEditing(u)
    setEditForm({ name: u.name, email: u.email, role: u.role, status: u.status })
    setEditError(null)
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault()
    if (!editing) return
    if (!editForm.name.trim() || !editForm.email.trim()) {
      setEditError("Name and email are required")
      return
    }
    const patch: Record<string, string> = {}
    if (editForm.name.trim() !== editing.name) patch.name = editForm.name.trim()
    if (editForm.email.trim().toLowerCase() !== editing.email.toLowerCase()) patch.email = editForm.email.trim().toLowerCase()
    if (editForm.role !== editing.role) (patch as Record<string,string>).role = editForm.role
    if (editForm.status !== editing.status) (patch as Record<string,string>).status = editForm.status
    if (Object.keys(patch).length === 0) {
      setEditing(null)
      return
    }
    setSavingEdit(true)
    setEditError(null)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await updateAdminUser(editing.id, patch as any)
      toast.success("User updated")
      setEditing(null)
      await load()
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to update user")
    } finally {
      setSavingEdit(false)
    }
  }

  async function handleToggleRole(u: AdminUser) {
    if (me?.id === u.id) {
      toast.error("You cannot change your own role")
      return
    }
    const nextRole = u.role === "admin" ? "user" : "admin"
    const label = nextRole === "admin" ? "promote to admin" : "revoke admin"
    if (!(await confirm({ title: `Are you sure you want to ${label} for ${u.email}?` }))) return
    setBusyId(u.id)
    try {
      await updateAdminUser(u.id, { role: nextRole })
      toast.success(nextRole === "admin" ? "User promoted to admin" : "Admin revoked")
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update role")
    } finally {
      setBusyId(null)
    }
  }

  async function handleToggleStatus(u: AdminUser) {
    if (me?.id === u.id) {
      toast.error("You cannot deactivate your own account")
      return
    }
    const nextStatus = u.status === "active" ? "inactive" : "active"
    if (
      nextStatus === "inactive" &&
      !(await confirm({
        title: `Deactivate ${u.email}?`,
        description: "They will not be able to sign in.",
        confirmLabel: "Deactivate",
        danger: true,
      }))
    )
      return
    setBusyId(u.id)
    try {
      await updateAdminUser(u.id, { status: nextStatus })
      toast.success(nextStatus === "active" ? "User activated" : "User deactivated")
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update status")
    } finally {
      setBusyId(null)
    }
  }

  async function handleDeleteConfirm() {
    if (!deleting) return
    setConfirmingDelete(true)
    try {
      await deleteAdminUser(deleting.id)
      toast.success("User deleted")
      setDeleting(null)
      // If we deleted the last item on this page, go back one page
      if (users.length === 1 && page > 1) setPage((p) => p - 1)
      else await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete user")
    } finally {
      setConfirmingDelete(false)
    }
  }

  const totalPages = meta.totalPages
  const total = meta.total

  return (
    <div className="min-h-screen bg-white font-poppins">
      <Header />
      <AdminLayout>
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[clamp(28px,3vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
              User management.
            </h1>
            <p className="mt-2 text-sm text-vez-mute">
              {loading ? "Loading users…" : `${total.toLocaleString()} registered ${total === 1 ? "user" : "users"}`}
              {activeFilterCount > 0 && !loading && ` · ${users.length} on this page`}
            </p>
          </div>
          <button
            onClick={() => {
              setCreateForm({ name: "", email: "", role: "user", status: "active" })
              setCreateError(null)
              setShowCreate(true)
            }}
            className="flex items-center gap-2 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white transition-opacity hover:opacity-90"
          >
            <UserPlus className="size-4" /> Add user
          </button>
        </div>

        {error && (
          <div className="mb-6 flex items-center gap-2 rounded-[14px] bg-red-50 px-4 py-3 text-sm text-red-600">
            <AlertCircle className="size-4 shrink-0" /> {error}
            <button onClick={() => void load()} className="ml-auto flex items-center gap-1 text-xs underline">
              <RefreshCw className="size-3" /> Retry
            </button>
          </div>
        )}

        <div className="rounded-[20px] bg-white p-4 sm:p-6">
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <div className="relative max-w-sm flex-1 min-w-[220px]">
              <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-vez-mute pointer-events-none" />
              <input
                placeholder="Search name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-11 min-h-[44px] w-full rounded-full border border-vez-line bg-white pl-11 pr-5 text-[16px] sm:text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-sky focus-visible:ring-2 focus-visible:ring-vez-navy/10"
              />
            </div>

            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value as "" | "admin" | "user")}
              className="h-11 rounded-full border border-vez-line bg-white px-4 text-sm text-vez-ink outline-none focus:border-vez-sky"
              aria-label="Filter by role"
            >
              <option value="">All roles</option>
              <option value="admin">Admins</option>
              <option value="user">Users</option>
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as "" | "active" | "inactive")}
              className="h-11 rounded-full border border-vez-line bg-white px-4 text-sm text-vez-ink outline-none focus:border-vez-sky"
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>

            {activeFilterCount > 0 && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1.5 text-sm text-vez-mute transition-colors hover:text-vez-navy"
              >
                <X className="size-3.5" /> Clear
              </button>
            )}

            <button
              onClick={() => void load()}
              className="ml-auto flex items-center gap-1.5 rounded-full border border-vez-line px-4 py-2.5 text-xs text-vez-ink transition-colors hover:bg-vez-surface"
              title="Refresh list"
            >
              <RefreshCw className="size-3.5" /> Refresh
            </button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16 text-vez-mute">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : users.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-vez-surface">
                <User className="size-5 text-vez-mute" />
              </div>
              <p className="text-sm text-vez-mute">
                {activeFilterCount > 0 ? "No users match these filters." : "No users found."}
              </p>
              {activeFilterCount > 0 && (
                <button
                  onClick={clearFilters}
                  className="rounded-full border border-vez-line px-4 py-1.5 text-xs text-vez-ink hover:bg-vez-surface"
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Desktop table - hidden on mobile, card list on mobile */}
              <div className="hidden md:block overflow-x-auto rounded-lg border border-vez-line -mx-2 md:mx-0">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-vez-line text-left">
                      <th className="pb-3 font-normal text-vez-mute">User</th>
                      <th className="pb-3 font-normal text-vez-mute">Email</th>
                      <th className="pb-3 font-normal text-vez-mute">Role</th>
                      <th className="pb-3 font-normal text-vez-mute">Status</th>
                      <th className="pb-3 font-normal text-vez-mute">Last login</th>
                      <th className="pb-3 font-normal text-vez-mute">Created</th>
                      <th className="pb-3 font-normal text-vez-mute">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => {
                      const isMe = me?.id === user.id
                      const busy = busyId === user.id
                      return (
                        <tr
                          key={user.id}
                          className={`border-b border-vez-line/50 transition-colors hover:bg-vez-surface/60 ${isMe ? "bg-vez-sky/10" : ""}`}
                        >
                          <td className="py-3.5 pr-4">
                            <div className="flex items-center gap-2.5">
                              <div className="flex size-8 items-center justify-center rounded-full bg-vez-sky shrink-0 overflow-hidden">
                                {user.avatarUrl ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img src={user.avatarUrl} alt="" className="size-8 rounded-full object-cover" />
                                ) : (
                                  <span className="text-xs text-vez-navy">{(user.name?.[0] ?? user.email[0]).toUpperCase()}</span>
                                )}
                              </div>
                              <div className="min-w-0">
                                <span className="flex items-center gap-1.5 text-vez-ink truncate">
                                  {user.name}
                                  {isMe && <span className="rounded-full bg-vez-navy px-1.5 py-0.5 text-[10px] text-white">you</span>}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td className="py-3.5 pr-4 text-vez-mute">
                            <span className="flex items-center gap-1.5">
                              <Mail className="size-3.5 shrink-0 opacity-50" />
                              <span className="truncate max-w-[180px]">{user.email}</span>
                            </span>
                          </td>
                          <td className="py-3.5 pr-4">
                            <span
                              className={`rounded-full px-3 py-1 text-xs capitalize ${
                                user.role === "admin" ? "bg-vez-navy text-white" : "bg-vez-surface text-vez-mute"
                              }`}
                            >
                              {user.role}
                            </span>
                          </td>
                          <td className="py-3.5 pr-4">
                            <button
                              onClick={() => void handleToggleStatus(user)}
                              disabled={busy || isMe}
                              title={isMe ? "You cannot deactivate yourself" : user.status === "active" ? "Click to deactivate" : "Click to activate"}
                              className={`rounded-full px-3 py-1 text-xs capitalize transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                                user.status === "active"
                                  ? "bg-vez-sky/30 text-vez-navy hover:bg-vez-sky/40"
                                  : "border border-vez-line text-vez-mute hover:bg-vez-surface"
                              }`}
                            >
                              {user.status === "active" ? (
                                <span className="flex items-center gap-1"><CheckCircle2 className="size-3" /> active</span>
                              ) : (
                                <span className="flex items-center gap-1"><Ban className="size-3" /> inactive</span>
                              )}
                            </button>
                          </td>
                          <td className="py-3.5 pr-4 text-xs text-vez-mute whitespace-nowrap">{formatDateTime(user.lastLoginAt)}</td>
                          <td className="py-3.5 pr-4 text-xs text-vez-mute whitespace-nowrap">{formatDate(user.createdAt)}</td>
                          <td className="py-3.5">
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => openEdit(user)}
                                className="flex size-8 min-h-[32px] min-w-[32px] items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20"
                                aria-label="Edit user"
                              >
                                <Edit className="size-3.5" />
                              </button>
                              <button
                                onClick={() => void handleToggleRole(user)}
                                disabled={busy || isMe}
                                className="flex size-8 min-h-[32px] min-w-[32px] items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-vez-surface hover:text-vez-navy cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20 disabled:opacity-40 disabled:cursor-not-allowed"
                                aria-label={user.role === "admin" ? "Revoke admin" : "Make admin"}
                                title={isMe ? "You cannot change your own role" : user.role === "admin" ? "Revoke admin" : "Make admin"}
                              >
                                {busy ? <Loader2 className="size-3.5 animate-spin" /> : user.role === "admin" ? <ShieldOff className="size-3.5" /> : <Shield className="size-3.5" />}
                              </button>
                              <button
                                onClick={() => setDeleting(user)}
                                disabled={isMe}
                                className="flex size-8 min-h-[32px] min-w-[32px] items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-red-50 hover:text-red-600 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200 disabled:opacity-40 disabled:cursor-not-allowed"
                                aria-label="Delete user"
                                title={isMe ? "You cannot delete yourself" : "Delete user"}
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards - visible only on mobile */}
              <div className="grid gap-3 md:hidden">
                {users.map((user) => {
                  const isMe = me?.id === user.id
                  const busy = busyId === user.id
                  return (
                    <div key={user.id} className={`rounded-2xl border p-4 ${isMe ? "border-vez-sky bg-vez-sky/5" : "border-vez-line/50 bg-vez-surface/50"}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-vez-sky overflow-hidden">
                            {user.avatarUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={user.avatarUrl} alt="" className="size-10 rounded-full object-cover" />
                            ) : (
                              <span className="text-sm text-vez-navy">{(user.name?.[0] ?? user.email[0]).toUpperCase()}</span>
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-vez-ink flex items-center gap-1.5">
                              {user.name} {isMe && <span className="rounded-full bg-vez-navy px-1.5 py-0.5 text-[10px] text-white">you</span>}
                            </p>
                            <p className="truncate text-xs text-vez-mute">{user.email}</p>
                          </div>
                        </div>
                        <button
                          onClick={() => void handleToggleStatus(user)}
                          disabled={busy || isMe}
                          className={`shrink-0 rounded-full px-2.5 py-1 text-xs capitalize disabled:opacity-50 ${user.status === "active" ? "bg-vez-sky/30 text-vez-navy" : "border border-vez-line text-vez-mute"}`}
                        >
                          {user.status}
                        </button>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-3 py-1 text-xs capitalize ${user.role === "admin" ? "bg-vez-navy text-white" : "bg-white border border-vez-line text-vez-mute"}`}>
                          {user.role}
                        </span>
                        <span className="text-xs text-vez-mute">Last: {formatDate(user.lastLoginAt)}</span>
                        <span className="text-xs text-vez-mute">Joined: {formatDate(user.createdAt)}</span>
                      </div>
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          onClick={() => openEdit(user)}
                          className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-full border border-vez-line bg-white px-3 py-2 text-xs text-vez-ink cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20"
                          aria-label="Edit user"
                        >
                          <Edit className="size-3.5" /> Edit
                        </button>
                        <button
                          onClick={() => void handleToggleRole(user)}
                          disabled={busy || isMe}
                          className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-full border border-vez-line bg-white px-3 py-2 text-xs text-vez-ink cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vez-navy/20 disabled:opacity-50"
                          aria-label={user.role === "admin" ? "Revoke admin" : "Make admin"}
                        >
                          {busy ? <Loader2 className="size-3.5 animate-spin" /> : user.role === "admin" ? <ShieldOff className="size-3.5" /> : <Shield className="size-3.5" />} {user.role === "admin" ? "Revoke" : "Make admin"}
                        </button>
                        <button
                          onClick={() => setDeleting(user)}
                          disabled={isMe}
                          className="flex size-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-red-50 text-red-600 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200 disabled:opacity-40"
                          aria-label="Delete user"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>

              {totalPages > 1 && (
                <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-sm">
                  <p className="text-vez-mute">
                    Page {meta.page} of {totalPages} · {total.toLocaleString()} total
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page <= 1}
                      className="flex size-8 items-center justify-center rounded-full border border-vez-line text-vez-ink transition-colors hover:bg-vez-surface disabled:opacity-40"
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="size-4" />
                    </button>
                    <button
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={page >= totalPages}
                      className="flex size-8 items-center justify-center rounded-full border border-vez-line text-vez-ink transition-colors hover:bg-vez-surface disabled:opacity-40"
                      aria-label="Next page"
                    >
                      <ChevronRight className="size-4" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </AdminLayout>

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-4 py-6" onClick={() => setShowCreate(false)}>
          <div
            className="w-full max-w-md bg-white rounded-t-[20px] sm:rounded-[20px] shadow-xl overflow-hidden animate-fade-in-up max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-vez-line px-6 py-4 sticky top-0 bg-white">
              <h3 className="text-lg font-medium text-vez-ink">Add user</h3>
              <button onClick={() => setShowCreate(false)} className="flex size-8 items-center justify-center rounded-full text-vez-mute hover:bg-vez-surface" aria-label="Close">
                <X className="size-4" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="p-4 sm:p-6 space-y-4">
              <p className="text-xs text-vez-mute">
                Creates a placeholder account. When the person signs in with Google using the same email, it will be linked automatically. Admin role is also granted automatically if the email is in the ADMIN_EMAILS allowlist.
              </p>
              <div>
                <label className="mb-1 block text-xs text-vez-mute">Name</label>
                <input
                  value={createForm.name}
                  onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="Full name"
                  className={fieldClass}
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-vez-mute">Email</label>
                <input
                  type="email"
                  value={createForm.email}
                  onChange={(e) => setCreateForm((p) => ({ ...p, email: e.target.value }))}
                  placeholder="user@example.com"
                  className={fieldClass}
                  required
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
                <div>
                  <label className="mb-1 block text-xs text-vez-mute">Role</label>
                  <select
                    value={createForm.role}
                    onChange={(e) => setCreateForm((p) => ({ ...p, role: e.target.value as "user" | "admin" }))}
                    className={`${fieldClass} h-[42px] py-0`}
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-vez-mute">Status</label>
                  <select
                    value={createForm.status}
                    onChange={(e) => setCreateForm((p) => ({ ...p, status: e.target.value as "active" | "inactive" }))}
                    className={`${fieldClass} h-[42px] py-0`}
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>
              {createError && <p className="text-xs text-red-600">{createError}</p>}
              <div className="flex flex-wrap gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="flex-1 min-w-[120px] rounded-full border border-vez-line bg-white px-5 py-2.5 text-sm text-vez-ink hover:bg-vez-surface"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="flex-1 min-w-[120px] flex items-center justify-center gap-2 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white disabled:opacity-50"
                >
                  {creating ? <Loader2 className="size-4 animate-spin" /> : <UserPlus className="size-4" />}
                  Create user
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-4 py-6" onClick={() => setEditing(null)}>
          <div
            className="w-full max-w-md bg-white rounded-t-[20px] sm:rounded-[20px] shadow-xl overflow-hidden animate-fade-in-up max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-vez-line px-6 py-4 sticky top-0 bg-white">
              <h3 className="text-lg font-medium text-vez-ink">Edit user</h3>
              <button onClick={() => setEditing(null)} className="flex size-8 items-center justify-center rounded-full text-vez-mute hover:bg-vez-surface" aria-label="Close">
                <X className="size-4" />
              </button>
            </div>
            <form onSubmit={handleEdit} className="p-4 sm:p-6 space-y-4">
              <div>
                <label className="mb-1 block text-xs text-vez-mute">Name</label>
                <input
                  value={editForm.name}
                  onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))}
                  className={fieldClass}
                  required
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-vez-mute">Email</label>
                <input
                  type="email"
                  value={editForm.email}
                  onChange={(e) => setEditForm((p) => ({ ...p, email: e.target.value }))}
                  className={fieldClass}
                  required
                />
                <p className="mt-1 text-xs text-vez-mute">Changing email may affect admin privileges if ADMIN_EMAILS is configured.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
                <div>
                  <label className="mb-1 block text-xs text-vez-mute">Role</label>
                  <select
                    value={editForm.role}
                    onChange={(e) => setEditForm((p) => ({ ...p, role: e.target.value as "user" | "admin" }))}
                    className={`${fieldClass} h-[42px] py-0`}
                    disabled={editing.id === me?.id}
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                  {editing.id === me?.id && <p className="mt-1 text-xs text-vez-mute">You cannot change your own role</p>}
                </div>
                <div>
                  <label className="mb-1 block text-xs text-vez-mute">Status</label>
                  <select
                    value={editForm.status}
                    onChange={(e) => setEditForm((p) => ({ ...p, status: e.target.value as "active" | "inactive" }))}
                    className={`${fieldClass} h-[42px] py-0`}
                    disabled={editing.id === me?.id && editForm.status === "inactive"}
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>

              <div className="rounded-[12px] bg-vez-surface px-4 py-3 text-xs text-vez-mute">
                <p>Joined: {formatDateTime(editing.createdAt)}</p>
                <p>Last login: {formatDateTime(editing.lastLoginAt)}</p>
                {editing.subscription && <p>Plan: {editing.subscription.plan.name} ({editing.subscription.plan.tier})</p>}
              </div>

              {editError && <p className="text-xs text-red-600">{editError}</p>}
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="flex-1 rounded-full border border-vez-line bg-white px-5 py-2.5 text-sm text-vez-ink hover:bg-vez-surface"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingEdit}
                  className="flex-1 flex items-center justify-center gap-2 rounded-full bg-vez-navy px-5 py-2.5 text-sm text-white disabled:opacity-50"
                >
                  {savingEdit ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                  Save changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => setDeleting(null)}>
          <div className="w-full max-w-sm bg-white rounded-[20px] shadow-xl p-4 sm:p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex size-10 items-center justify-center rounded-full bg-red-50 text-red-600 mx-auto">
              <Trash2 className="size-5" />
            </div>
            <h3 className="mt-4 text-center text-base font-medium text-vez-ink">Delete user?</h3>
            <p className="mt-2 text-center text-sm text-vez-mute">
              This will permanently delete <span className="text-vez-ink font-medium">{deleting.email}</span> and remove their alerts, subscriptions and usage history. Documents they uploaded will remain but become unowned. This cannot be undone.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setDeleting(null)}
                className="flex-1 rounded-full border border-vez-line bg-white px-5 py-2.5 text-sm text-vez-ink hover:bg-vez-surface"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={confirmingDelete}
                className="flex-1 flex items-center justify-center gap-2 rounded-full bg-red-600 px-5 py-2.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                {confirmingDelete ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
