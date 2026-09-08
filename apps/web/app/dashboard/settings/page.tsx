"use client"

import React, { useState } from "react"
import Link from "next/link"
import {
  User,
  Globe,
  Bell,
  AlertCircle,
  Mail,
  MessageCircle,
  CheckCircle,
  Info,
} from "lucide-react"
import { Header } from "@/components/layout/header"
import { DashboardLayout } from "@/components/dashboard/dashboard-layout"
import { WhatsappConnectCard } from "@/components/alerts/whatsapp-connect-card"
import { useAuth } from "@/lib/auth-context"
import { useLanguage } from "@/lib/language-context"

export default function SettingsPage() {
  const { user } = useAuth()
  const { language, setLanguage } = useLanguage()

  const [alertPrefs, setAlertPrefs] = useState({
    email: { enabled: true, value: user?.email || "" },
    messenger: { enabled: false, connected: false },
  })

  // Simulating admin-enabled channels
  const adminChannels = {
    email: true,
    messenger: false,
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-white font-poppins">
        <Header />
        <div className="flex items-center justify-center py-32">
          <div className="w-full max-w-sm rounded-[24px] bg-vez-surface p-10 text-center">
            <AlertCircle className="mx-auto mb-4 size-10 text-vez-mute" />
            <h2 className="mb-1 text-lg text-vez-ink">Sign in required</h2>
            <p className="mb-6 text-sm text-vez-mute">Please sign in to access settings.</p>
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

  const toggleButton = (enabled: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      className={`rounded-full px-4 py-2 text-xs transition-colors ${
        enabled
          ? "bg-vez-navy text-white hover:opacity-90"
          : "border border-vez-line text-vez-mute hover:bg-vez-surface hover:text-vez-navy"
      }`}
    >
      {enabled ? "Enabled" : "Disabled"}
    </button>
  )

  return (
    <div className="min-h-screen w-full max-w-full overflow-x-hidden bg-white font-poppins">
      <Header />
      <DashboardLayout>
        <div className="mb-6 w-full max-w-full min-w-0 overflow-hidden sm:mb-8">
          <h1 className="break-words text-[clamp(22px,6vw,40px)] font-normal leading-tight tracking-[-0.03em] text-vez-ink">
            Settings.
          </h1>
          <p className="mt-1 text-sm text-vez-mute sm:mt-2">Manage your account and alert preferences</p>
        </div>

        <div className="w-full max-w-full min-w-0 space-y-4 overflow-hidden sm:space-y-6">
          {/* Profile */}
          <div className="w-full max-w-full min-w-0 overflow-hidden rounded-[20px] bg-white p-4 sm:p-6 md:p-8">
            <h2 className="flex items-center gap-2 text-lg text-vez-ink">
              <User className="size-4 text-vez-navy" /> Profile
            </h2>
            <p className="mt-1 text-sm text-vez-mute">Your account information</p>
            <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
              {[
                { label: "Username", value: user.username },
                { label: "Email", value: user.email },
                { label: "Role", value: user.role, capitalize: true },
                { label: "Member since", value: new Date(user.createdAt).toLocaleDateString() },
              ].map((item) => (
                <div key={item.label}>
                  <p className="text-sm text-vez-mute">{item.label}</p>
                  <p className={`mt-1 text-base text-vez-ink ${item.capitalize ? "capitalize" : ""}`}>{item.value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Alert Preferences */}
          <div className="w-full max-w-full min-w-0 overflow-hidden rounded-[20px] bg-white p-4 sm:p-6 md:p-8">
            <h2 className="flex items-center gap-2 text-base text-vez-ink sm:text-lg">
              <Bell className="size-4 shrink-0 text-vez-navy" /> Alert preferences
            </h2>
            <p className="mt-1 break-words text-sm text-vez-mute">Choose how you want to receive notice alerts</p>

            <div className="mt-6 space-y-4">
              <div className="flex items-start gap-2.5 rounded-[14px] bg-vez-surface px-3 py-3 sm:px-4">
                <Info className="mt-0.5 size-4 shrink-0 text-vez-mute" />
                <p className="break-words text-xs leading-relaxed text-vez-mute">
                  You will only receive alerts through channels your administrator has configured.
                </p>
              </div>

              {/* Email - always available */}
              <div className="flex w-full min-w-0 flex-col gap-3 overflow-hidden rounded-[16px] bg-vez-surface p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-5">
                <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-3.5">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white sm:size-10">
                    <Mail className="size-4 text-vez-navy" />
                  </div>
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <p className="text-sm text-vez-ink">Email</p>
                    <p className="truncate text-xs text-vez-mute">{alertPrefs.email.value}</p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 sm:gap-2.5">
                  <span className="flex items-center gap-1 rounded-full bg-vez-sky/30 px-3 py-1 text-xs text-vez-navy">
                    <CheckCircle className="size-3 shrink-0" /> Available
                  </span>
                  {toggleButton(alertPrefs.email.enabled, () =>
                    setAlertPrefs({ ...alertPrefs, email: { ...alertPrefs.email, enabled: !alertPrefs.email.enabled } })
                  )}
                </div>
              </div>

              {/* WhatsApp — real OTP-verified connect flow, not a bare toggle.
                  A phone number only becomes active once its owner proves
                  they received the code sent to it (see WhatsappConnectCard /
                  NotificationsService.verifyOtp). */}
              <WhatsappConnectCard />

              {/* Facebook Messenger */}
              {adminChannels.messenger ? (
                <div className="flex w-full min-w-0 flex-col gap-3 overflow-hidden rounded-[16px] bg-vez-surface p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-5">
                  <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-3.5">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white sm:size-10">
                      <MessageCircle className="size-4 text-vez-navy" />
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <p className="text-sm text-vez-ink">Facebook Messenger</p>
                      <p className="break-words text-xs text-vez-mute">
                        {alertPrefs.messenger.connected ? "Connected" : "Not connected"}
                      </p>
                    </div>
                  </div>
                  {alertPrefs.messenger.connected ? (
                    <div className="shrink-0">
                      {toggleButton(alertPrefs.messenger.enabled, () =>
                        setAlertPrefs({ ...alertPrefs, messenger: { ...alertPrefs.messenger, enabled: !alertPrefs.messenger.enabled } })
                      )}
                    </div>
                  ) : (
                    <button
                      className="w-full shrink-0 rounded-full border border-vez-line px-4 py-2 text-xs text-vez-ink transition-colors hover:bg-vez-surface sm:w-auto"
                      onClick={() => setAlertPrefs({ ...alertPrefs, messenger: { ...alertPrefs.messenger, connected: true, enabled: true } })}
                    >
                      Connect Facebook
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex w-full min-w-0 flex-col gap-3 overflow-hidden rounded-[16px] bg-vez-surface p-4 opacity-60 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-5">
                  <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-3.5">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white sm:size-10">
                      <MessageCircle className="size-4 text-vez-mute" />
                    </div>
                    <div className="min-w-0 flex-1 overflow-hidden">
                      <p className="text-sm text-vez-mute">Facebook Messenger</p>
                      <p className="break-words text-xs text-vez-mute">Not enabled by administrator</p>
                    </div>
                  </div>
                  <span className="shrink-0 self-start rounded-full border border-vez-line px-3 py-1 text-xs text-vez-mute sm:self-auto">Unavailable</span>
                </div>
              )}

              <button className="mt-2 rounded-full bg-vez-navy px-6 py-3 text-sm text-white transition-opacity hover:opacity-90">
                Save preferences
              </button>
            </div>
          </div>

          {/* Language */}
          <div className="w-full max-w-full min-w-0 overflow-hidden rounded-[20px] bg-white p-4 sm:p-6 md:p-8">
            <h2 className="flex items-center gap-2 text-base text-vez-ink sm:text-lg">
              <Globe className="size-4 shrink-0 text-vez-navy" /> Language
            </h2>
            <p className="mt-1 break-words text-sm text-vez-mute">Choose your preferred language</p>
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                onClick={() => setLanguage("en")}
                className={`rounded-full px-5 py-2.5 text-sm transition-colors ${
                  language === "en"
                    ? "bg-vez-navy text-white"
                    : "border border-vez-line text-vez-mute hover:bg-vez-surface hover:text-vez-navy"
                }`}
              >
                English
              </button>
              <button
                onClick={() => setLanguage("ne")}
                className={`rounded-full px-5 py-2.5 text-sm transition-colors ${
                  language === "ne"
                    ? "bg-vez-navy text-white"
                    : "border border-vez-line text-vez-mute hover:bg-vez-surface hover:text-vez-navy"
                }`}
              >
                नेपाली
              </button>
            </div>
          </div>
        </div>
      </DashboardLayout>
    </div>
  )
}
