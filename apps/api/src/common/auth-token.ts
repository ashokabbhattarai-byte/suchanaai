import { Request } from 'express';

/**
 * Shared session-cookie + header conventions between the JWT strategy, the
 * guards and the logout endpoint. The `pnm_token` cookie is minted httpOnly by
 * Nest at login and mirrored (non-httpOnly) on the web origin for the edge
 * middleware (see apps/web/lib/api.ts).
 */
export const SESSION_COOKIE = 'pnm_token';

/** Minimal cookie header parser — no middleware-order dependency. */
function rawCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    try {
      out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    } catch {
      out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  return out;
}

/** Bearer header first, then the session cookie — both are valid carriers. */
export function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  const cookie = rawCookies(req)[SESSION_COOKIE];
  return cookie && cookie.length ? cookie : null;
}