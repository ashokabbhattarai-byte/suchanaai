"use client"

import { AdminLayout } from "@/components/admin/admin-layout"
import { AdminWhatsappCard } from "@/components/admin/admin-whatsapp-card"
import { AdminEmailCard } from "@/components/admin/admin-email-card"
import { AlertTemplateCard } from "@/components/admin/alert-template-card"
import { Header } from "@/components/layout/header"

/**
 * The two — and only two — delivery channels for user alerts: WhatsApp (the
 * shared Evolution API sender) and email (admin-configured SMTP). Both cards
 * read and write real server state; neither ever receives a stored
 * credential back from the API. AlertTemplateCard edits what the WhatsApp
 * channel actually sends — kept on this page since it's meaningless without
 * the sender being connected.
 */
export default function AdminAlertChannelsPage() {
  return (
    <div className="min-h-screen bg-white font-poppins">
      <Header />
      <AdminLayout>
        <div className="mb-8">
          <h1 className="text-[clamp(28px,3vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
            Alert channels.
          </h1>
          <p className="mt-2 text-sm text-vez-mute">
            Configure the two notification delivery methods for user alerts — WhatsApp and email.
          </p>
        </div>

        <div className="space-y-6">
          <AdminWhatsappCard />
          <AlertTemplateCard />
          <AdminEmailCard />
        </div>
      </AdminLayout>
    </div>
  )
}
