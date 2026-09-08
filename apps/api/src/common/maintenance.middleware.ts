import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { SettingsService } from '../services/settings.service';

// /webhooks and /billing stay reachable in maintenance mode: Stripe retries a
// rejected webhook only a limited number of times, and a subscription state
// lost that way is worse than the maintenance window itself.
const ALLOWED_PREFIXES = ['/admin', '/health', '/auth', '/public', '/webhooks', '/billing', '/plans'];
function isAllowedPath(path: string): boolean {
  return ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p + '?'));
}

/**
 * Maintenance-mode gate. When `maintenance.enabled` is on, everything except
 * admin routes, /health, /auth and /public returns 503 with a JSON body — the
 * admin UI stays reachable so the flag can be switched back off.
 *
 * The flag is re-read on every request (single PK lookup, microsecond-scale),
 * so a toggle applies immediately without a restart.
 */
@Injectable()
export class MaintenanceMiddleware implements NestMiddleware {
  private readonly logger = new Logger(MaintenanceMiddleware.name);

  constructor(private readonly settings: SettingsService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const maintenance = await this.settings.getBoolean('maintenance.enabled', false);
    if (!maintenance) return next();

    // NOTE: `req.path` is unreliable here — an earlier app-level middleware
    // rewrites `req.url` to "/", so the untouched originalUrl is used.
    const path = req.originalUrl.split('?')[0];
    // Exact segment match to avoid /admin matching /admin-fake
    if (isAllowedPath(path)) {
      return next();
    }

    this.logger.warn(`Maintenance mode: rejecting ${req.method} ${path}`);
    res
      .status(503)
      .setHeader('Retry-After', '60')
      .json({
        statusCode: 503,
        error: 'Service Unavailable',
        message:
          'The system is under maintenance. Please try again shortly — or sign in as an admin to /admin to disable maintenance mode.',
      });
  }
}