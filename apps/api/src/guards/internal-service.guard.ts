import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Service-to-service auth for routes the AI service (apps/ai) calls
 * directly: a shared secret in a header, not a user JWT — the caller has no
 * user identity to present. Fails closed on both ends: if the server has no
 * secret configured at all, the route is treated as disabled (503) rather
 * than silently open; any mismatch is a plain 403 with no detail about which
 * part was wrong.
 *
 * Originally lived only in settings.controller.ts (InternalAiConfigController,
 * the API -> AI direction); extracted here so the AI -> API direction (scrape
 * run item streaming) can reuse the same guard instead of a second copy.
 */
@Injectable()
export class InternalServiceGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('INTERNAL_SERVICE_SECRET');
    if (!expected) {
      throw new ServiceUnavailableException(
        'INTERNAL_SERVICE_SECRET is not configured on this server.',
      );
    }
    const request = context.switchToHttp().getRequest();
    const provided = request.headers['x-internal-secret'];
    if (typeof provided !== 'string' || provided !== expected) {
      throw new ForbiddenException('Invalid internal service secret.');
    }
    return true;
  }
}
