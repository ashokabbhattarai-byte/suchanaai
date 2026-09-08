import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * JWT revocation store — in-memory fast path + DB persistence.
 *
 * In-memory alone is lost on restart / multi-replica. This service writes
 * revoked token hashes to DB (via Prisma) and checks DB as fallback when
 * the in-memory map misses. The DB table should be `revoked_tokens` with
 * columns token_hash (PK) and expires_at. If the table does not exist yet
 * (pre-migration), it gracefully degrades to in-memory only.
 *
 * Pruning is lazy (on revoke/isRevoked) and via DB TTL; tokens are short-lived
 * (JWT_EXPIRES_IN), so the table stays small.
 */
@Injectable()
export class TokenRevocationService {
  private readonly logger = new Logger(TokenRevocationService.name);
  private readonly revoked = new Map<string, number>(); // sha256(token) -> exp ms
  private dbAvailable = true;

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private expiryOf(token: string): number {
    // Best-effort payload decode for the `exp` claim; fall back to 24h so a
    // malformed-but-previously-valid token still gets pruned eventually.
    try {
      const [, body] = token.split('.');
      const pad = body.replace(/-/g, '+').replace(/_/g, '/');
      const json = Buffer.from(pad + '='.repeat((4 - (pad.length % 4)) % 4), 'base64').toString('utf8');
      const exp = JSON.parse(json).exp as number | undefined;
      if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000;
    } catch {
      // ignore
    }
    return Date.now() + 24 * 60 * 60 * 1000;
  }

  constructor(private readonly prisma: PrismaService) {}

  /** Mark a token unusable from now on. */
  async revoke(token: string): Promise<void> {
    const at = Date.now();
    this.prune(at);
    const hash = this.hash(token);
    const exp = this.expiryOf(token);
    this.revoked.set(hash, exp);

    // Persist to DB for cross-restart / multi-replica safety (best-effort)
    if (this.dbAvailable && this.prisma) {
      try {
        // Use raw SQL to avoid requiring a Prisma model until migration runs
        await this.prisma.$executeRaw`INSERT INTO revoked_tokens (token_hash, expires_at) VALUES (${hash}, to_timestamp(${exp / 1000})) ON CONFLICT (token_hash) DO NOTHING`;
      } catch (e: any) {
        // Table may not exist yet — disable DB persistence silently
        if (e?.code === '42P01' || e?.message?.includes('does not exist')) {
          this.dbAvailable = false;
        } else {
          this.logger.warn(`Failed to persist revoked token: ${e.message}`);
        }
      }
    }
  }

  isRevoked(token: string): boolean | Promise<boolean> {
    // Opportunistically prune expired entries on every check (not just on revoke)
    if (this.revoked.size > 100 && Math.random() < 0.05) this.prune(Date.now());
    const hash = this.hash(token!);
    const exp = this.revoked.get(hash);
    if (exp) {
      if (exp <= Date.now()) {
        this.revoked.delete(hash);
      } else {
        return true;
      }
    }
    // Fallback to DB (covers restart / other replica) — async path
    if (this.dbAvailable && this.prisma) {
      return (async () => {
        try {
          const rows: any[] = await this.prisma.$queryRaw`SELECT 1 FROM revoked_tokens WHERE token_hash = ${hash} AND expires_at > NOW() LIMIT 1`;
          if (rows.length > 0) {
            this.revoked.set(hash, Date.now() + 60_000);
            return true;
          }
        } catch (e: any) {
          if (e?.code === '42P01' || e?.message?.includes('does not exist')) {
            this.dbAvailable = false;
          }
        }
        return false;
      })();
    }
    return false;
  }

  /** Async version for guards that can await */
  async isRevokedAsync(token: string): Promise<boolean> {
    const result = this.isRevoked(token);
    return result instanceof Promise ? result : Promise.resolve(result);
  }

  private prune(now: number): void {
    for (const [key, exp] of this.revoked) {
      if (exp <= now) this.revoked.delete(key);
    }
  }

  /** Number of live revoked tokens (diagnostics only). */
  size(): number {
    return this.revoked.size;
  }
}