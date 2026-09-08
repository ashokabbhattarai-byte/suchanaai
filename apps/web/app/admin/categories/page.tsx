"use client"

import React, { useState } from "react"
import { Plus, Edit, Trash2 } from "lucide-react"
import { AdminLayout } from "@/components/admin/admin-layout"
import { Header } from "@/components/layout/header"
import { categories } from "@/lib/mock-data"

export default function AdminCategoriesPage() {
  const [newCategory, setNewCategory] = useState("")

  return (
    <div className="min-h-screen bg-white font-poppins">
      <Header />
      <AdminLayout>
        <div className="mb-8">
          <h1 className="text-[clamp(28px,3vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
            Category management.
          </h1>
          <p className="mt-2 text-sm text-vez-mute">Manage notice categories</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
          <div className="rounded-[20px] bg-white p-4 sm:p-6 w-full overflow-hidden">
            <h2 className="mb-5 text-lg text-vez-ink">Existing categories</h2>
            <div className="space-y-2.5">
              {categories.map((cat) => (
                <div key={cat.id} className="flex items-center justify-between rounded-[14px] bg-vez-surface px-4 py-3 transition-colors hover:bg-vez-sky/15">
                  <div className="flex items-center gap-3">
                    <span className="rounded-full bg-vez-navy px-3.5 py-1 text-xs text-white">{cat.label}</span>
                    <span className="text-sm text-vez-mute">{cat.count} notices</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button className="flex size-8 items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-white hover:text-vez-navy" aria-label="Edit category"><Edit className="size-3.5" /></button>
                    <button className="flex size-8 items-center justify-center rounded-full text-vez-mute transition-colors hover:bg-red-50 hover:text-red-600" aria-label="Delete category"><Trash2 className="size-3.5" /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="h-fit rounded-[20px] bg-vez-sky/25 p-4 sm:p-6 w-full overflow-hidden">
            <h2 className="mb-5 text-lg text-vez-ink">Add category</h2>
            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-sm text-vez-mute">Category name</label>
                <input
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  placeholder="Enter category name"
                  className="h-11 w-full rounded-full border border-vez-line bg-white px-5 text-sm text-vez-ink outline-none transition-colors placeholder:text-vez-mute focus:border-vez-sky"
                />
              </div>
              <button className="flex w-full items-center justify-center gap-2 rounded-full bg-vez-navy px-5 py-3 text-sm text-white transition-opacity hover:opacity-90">
                <Plus className="size-4" /> Add category
              </button>
            </div>
          </div>
        </div>
      </AdminLayout>
    </div>
  )
}
