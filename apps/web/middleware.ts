import { NextRequest, NextResponse } from "next/server"

export const TOKEN_COOKIE = "pnm_token"

/**
 * Route protection at the edge. The API is the source of truth (it validates
 * the JWT signature server-side); this middleware is a per-nav UX gate that:
 *   - blocks /admin/* and /dashboard/* when no valid session cookie exists,
 *     bouncing to /login?redirect=… (the URL is preserved for after sign-in);
 *   - keeps signed-in users out of /login and /signup.
 *
 * The cookie is mirrored from the token store on sign-in and cleared on
 * logout/401; the expiry check below only decodes the JWT payload (no secret)
 * so tampered tokens still pass through to the client guard + API, which
 * enforce real authorization. Forged tokens therefore still render the shell
 * but no data loads (RequireAuth + API 401 will bounce). Admin pages also
 * have a server-component auth check as defense-in-depth.
 *
 * Additional hardening: reject tokens with obviously fake structure (wrong
 * header, missing iat, exp far in future >30 days) to reduce the window where
 * a hand-crafted JWT renders protected UI.
 */
function tokenCookieIsLive(token: string | undefined): boolean {
  if (!token) return false
  const parts = token.split(".")
  if (parts.length !== 3) return false
  try {
    const headerJson = JSON.parse(
      decodeURIComponent(
        atob(parts[0].replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (parts[0].length % 4)) % 4))
          .split("")
          .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
          .join(""),
      ),
    )
    // Reject tokens not using expected alg
    if (headerJson.alg !== "HS256") return false

    const pad = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    const json = decodeURIComponent(
      atob(pad + "=".repeat((4 - (pad.length % 4)) % 4))
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join(""),
    )
    const payload = JSON.parse(json)
    if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return false
    if (payload.exp * 1000 <= Date.now()) return false
    // Reject tokens with exp >30 days in future (likely forged; real tokens are 7d)
    const maxExp = Date.now() + 30 * 24 * 60 * 60 * 1000
    if (payload.exp * 1000 > maxExp) return false
    // sub must be a UUID-like string
    if (typeof payload.sub !== "string" || payload.sub.length < 10) return false
    return true
  } catch {
    return false
  }
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const token = req.cookies.get(TOKEN_COOKIE)?.value
  const authed = tokenCookieIsLive(token)

  const isAuthPage = pathname === "/login" || pathname === "/signup"
  const isProtected =
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/")

  if (isProtected && !authed) {
    const url = req.nextUrl.clone()
    url.pathname = "/login"
    url.searchParams.set("redirect", pathname + req.nextUrl.search)
    return NextResponse.redirect(url)
  }

  if (isAuthPage && authed) {
    return NextResponse.redirect(new URL("/dashboard", req.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ["/admin", "/admin/:path*", "/dashboard", "/dashboard/:path*", "/login", "/signup"],
}