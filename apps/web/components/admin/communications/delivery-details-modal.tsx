"use client"

import * as React from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import {
  CheckCircle2,
  XCircle,
  Clock,
  Users,
  Mail,
  MessageSquare,
  Phone,
  CalendarDays,
  FileText
} from "lucide-react"

// Types to mock the communication data structure
export type CommunicationStatus = "Draft" | "Scheduled" | "Sent" | "Failed"
export type CommunicationChannel = "SMS" | "Email" | "Voice/IVR"

export interface CommunicationDetails {
  id: string
  title: string
  channel: CommunicationChannel
  audience: string[]
  status: CommunicationStatus
  messageContent: string
  createdAt: string
  updatedAt: string
  sentTime?: string
  deliveryStats?: {
    total: number
    delivered: number
    failed: number
    pending: number
  }
  failReason?: string
}

interface DeliveryDetailsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  communication: CommunicationDetails | null
}

export function DeliveryDetailsModal({ open, onOpenChange, communication }: DeliveryDetailsModalProps) {
  if (!communication) return null

  // Helper to determine status color and icon
  const getStatusConfig = (status: CommunicationStatus) => {
    switch (status) {
      case "Sent":
        return {
          color: "bg-green-100 text-green-700 border-green-200",
          icon: <CheckCircle2 className="size-3.5" />
        }
      case "Failed":
        return {
          color: "bg-red-100 text-red-700 border-red-200",
          icon: <XCircle className="size-3.5" />
        }
      case "Scheduled":
        return {
          color: "bg-blue-100 text-blue-700 border-blue-200",
          icon: <Clock className="size-3.5" />
        }
      default: // Draft
        return {
          color: "bg-gray-100 text-gray-700 border-gray-200",
          icon: <FileText className="size-3.5" />
        }
    }
  }

  // Helper to get channel icon
  const getChannelIcon = (channel: CommunicationChannel) => {
    switch (channel) {
      case "Email":
        return <Mail className="size-4 text-vez-mute" />
      case "SMS":
        return <MessageSquare className="size-4 text-vez-mute" />
      case "Voice/IVR":
        return <Phone className="size-4 text-vez-mute" />
    }
  }

  const statusConfig = getStatusConfig(communication.status)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-6 sm:p-8">
        <DialogHeader className="gap-1">
          <div className="flex items-start justify-between">
            <div className="space-y-1 pr-6">
              <DialogTitle className="text-xl sm:text-2xl">{communication.title}</DialogTitle>
              <DialogDescription className="flex items-center gap-2">
                ID: {communication.id}
              </DialogDescription>
            </div>
            <div className="shrink-0 mt-1">
              <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium border ${statusConfig.color}`}>
                {statusConfig.icon}
                {communication.status}
              </span>
            </div>
          </div>
        </DialogHeader>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Left Column: Metadata */}
          <div className="space-y-5">
            <div>
              <h3 className="text-sm font-medium text-vez-ink mb-3">Communication Details</h3>
              <div className="space-y-3 rounded-2xl bg-vez-surface p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 text-vez-mute">
                    {getChannelIcon(communication.channel)}
                    Channel
                  </span>
                  <span className="font-medium text-vez-ink">{communication.channel}</span>
                </div>
                <div className="h-px w-full bg-vez-line/60" />
                <div className="flex items-start justify-between text-sm">
                  <span className="flex items-center gap-2 text-vez-mute shrink-0 mt-0.5">
                    <Users className="size-4" />
                    Audience
                  </span>
                  <div className="flex flex-wrap gap-1.5 justify-end">
                    {communication.audience.map(group => (
                      <Badge key={group} variant="secondary" className="bg-white">
                        {group}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-medium text-vez-ink mb-3">Timestamps</h3>
              <div className="space-y-3 rounded-2xl bg-vez-surface p-4 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-vez-mute">Created</span>
                  <span className="font-medium text-vez-ink">{communication.createdAt}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-vez-mute">Updated</span>
                  <span className="font-medium text-vez-ink">{communication.updatedAt}</span>
                </div>
                {communication.sentTime && (
                  <>
                    <div className="h-px w-full bg-vez-line/60" />
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2 text-vez-navy font-medium">
                        <CalendarDays className="size-4" />
                        Sent Time
                      </span>
                      <span className="font-semibold text-vez-navy">{communication.sentTime}</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Right Column: Delivery Stats & Content */}
          <div className="space-y-5">
            {communication.deliveryStats && (
              <div>
                <h3 className="text-sm font-medium text-vez-ink mb-3">Delivery Analytics</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-vez-line p-3">
                    <p className="text-xs text-vez-mute mb-1">Total Recipients</p>
                    <p className="text-xl font-semibold text-vez-ink">{communication.deliveryStats.total}</p>
                  </div>
                  <div className="rounded-2xl border border-green-100 bg-green-50/50 p-3">
                    <p className="text-xs text-green-600 mb-1">Delivered</p>
                    <p className="text-xl font-semibold text-green-700">{communication.deliveryStats.delivered}</p>
                  </div>
                  <div className="rounded-2xl border border-red-100 bg-red-50/50 p-3">
                    <p className="text-xs text-red-600 mb-1">Failed</p>
                    <p className="text-xl font-semibold text-red-700">{communication.deliveryStats.failed}</p>
                  </div>
                  <div className="rounded-2xl border border-orange-100 bg-orange-50/50 p-3">
                    <p className="text-xs text-orange-600 mb-1">Pending</p>
                    <p className="text-xl font-semibold text-orange-700">{communication.deliveryStats.pending}</p>
                  </div>
                </div>
                
                {communication.failReason && (
                  <div className="mt-3 rounded-xl bg-red-50 p-3 border border-red-100">
                    <p className="text-xs font-medium text-red-800 mb-1">Failure Reason</p>
                    <p className="text-xs text-red-600">{communication.failReason}</p>
                  </div>
                )}
              </div>
            )}

            <div className="flex-1 flex flex-col">
              <h3 className="text-sm font-medium text-vez-ink mb-3">Message Content</h3>
              <div className="flex-1 rounded-2xl border border-vez-line bg-gray-50/50 p-4">
                <p className="text-sm leading-relaxed text-vez-ink whitespace-pre-wrap font-mono text-[13px]">
                  {communication.messageContent}
                </p>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
