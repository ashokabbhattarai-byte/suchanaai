"use client"

import { GoogleOAuthProvider } from "@react-oauth/google"
import { AuthProvider } from "@/lib/auth-context"
import { LanguageProvider } from "@/lib/language-context"
import { AlertsProvider } from "@/lib/alerts-context"
import { NoticeContextProvider } from "@/lib/notice-context"
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog"
import { FloatingChat } from "@/components/floating-chat"
import { AlertCtaBanner } from "@/components/alert-cta-banner"

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? ""

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <AuthProvider>
        <LanguageProvider>
          <AlertsProvider>
            <NoticeContextProvider>
              <ConfirmDialogProvider>
                {children}
                <FloatingChat />
                <AlertCtaBanner />
              </ConfirmDialogProvider>
            </NoticeContextProvider>
          </AlertsProvider>
        </LanguageProvider>
      </AuthProvider>
    </GoogleOAuthProvider>
  )
}
