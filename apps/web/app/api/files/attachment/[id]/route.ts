import { NextResponse } from "next/server"
import { API_URL } from "@/lib/api"

/**
 * Thin same-origin proxy for scraped-notice attachments. Keeps the backend
 * API URL out of hrefs rendered in the page (a relative `/api/files/...`
 * link instead of an absolute cross-origin one) and gives the browser one
 * redirect hop to the API, which itself redirects again to a short-lived
 * presigned S3 URL (see AttachmentsController). Nothing here touches S3 or
 * the database directly — this route's only job is the redirect.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const uuidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
  if (!uuidRe.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  const url = new URL(request.url)
  const mode = url.searchParams.get("mode")
  if (mode && mode !== "inline" && mode !== "download") {
    return NextResponse.json({ error: "Invalid mode" }, { status: 400 })
  }
  const encoded = encodeURIComponent(id)
  const search = url.search
  return NextResponse.redirect(`${API_URL}/attachments/${encoded}/file${search}`)
}
