import { NextResponse } from "next/server"
import { API_URL } from "@/lib/api"

/**
 * Same-origin proxy for RAG document downloads — mirrors
 * app/api/files/attachment/[id]/route.ts. Redirects to the backend's
 * GET /documents/:id/download, which itself redirects to a short-lived
 * presigned S3 URL (see DocumentsService.getDownloadUrl).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
  if (!uuidRe.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  const encoded = encodeURIComponent(id)
  return NextResponse.redirect(`${API_URL}/documents/${encoded}/download`)
}
