// MUST be the first import: it patches axios.create before AppModule loads,
// so every HttpService instance (created at module-load time via
// HttpModule.register) gets the correlation-id interceptor.
import './common/http/axios-correlation';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
// The compression CJS export is the middleware function itself; `import compression
// from` would desugar to `.default`, which the package doesn't provide.
import compression = require('compression');
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { CorrelationMiddleware, StructuredLogger } from './common/logger';

async function bootstrap() {
  // Override before the app is created so every `new Logger()` in modules uses
  // the structured JSON logger (Nest 11 supports Logger.overrideLogger).
  Logger.overrideLogger(new StructuredLogger());

  // rawBody: Stripe signs the exact bytes it sent, so the webhook handler must
  // see the untouched body. Nest keeps `req.rawBody` alongside the parsed one.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  app.set('trust proxy', 1);

  app.useLogger(new StructuredLogger());

  // Security hardening: sensible default headers (HSTS, X-Content-Type-Options…).
  app.use(helmet());

  // Wire each request to a correlation id, exposed via x-request-id.
  app.use(new CorrelationMiddleware().use);

  // gzip/brotli response compression — biggest single win for JSON payloads.
  app.use(compression({ threshold: 1024 }));

  // CSRF hardening: state-changing requests must carry Origin/Referer from an allowed web origin.
  // Cookie-authenticated POST/PUT/PATCH/DELETE without a valid Origin is likely a cross-site form submission.
  // Bearer-token requests (Authorization header) are exempt — they require JS and are not auto-sent by browsers.
  app.use((req: any, res: any, next: any) => {
    const method = req.method?.toUpperCase();
    const needsCsrfCheck = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    const hasBearer = !!req.headers.authorization?.startsWith('Bearer ');
    const hasCookie = !!req.headers.cookie?.includes('pnm_token');
    if (needsCsrfCheck && hasCookie && !hasBearer) {
      const origin = req.headers.origin || req.headers.referer || '';
      let allowed = false;
      if (origin) {
        try {
          const originHost = new URL(origin).origin;
          allowed = filteredOrigins.some((o) => {
            try { return new URL(o).origin === originHost; } catch { return o === origin; }
          });
        } catch {
          allowed = filteredOrigins.includes(origin);
        }
      }
      if (!allowed) {
        return res.status(403).json({ statusCode: 403, message: 'CSRF check failed: invalid origin', error: 'Forbidden' });
      }
    }
    next();
  });

  // Strict CORS: only the configured web origins may call the API, with
  // credentials (cookies) and the headers the app actually uses. Origins are
  // taken from WEB_ORIGIN (comma-separated) so production can list the real
  // domain alongside localhost without a code change.
  // The live production domains are always allowed so a missing/stale
  // WEB_ORIGIN in the deployed env can't break the browser app.
  const productionOrigins = ['https://suchanaai.tech', 'https://www.suchanaai.tech'];
  const isProd = process.env.NODE_ENV === 'production';

  const webOrigins = Array.from(
    new Set(
      (process.env.WEB_ORIGIN ?? (isProd ? '' : 'http://localhost:3535'))
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
        .concat(productionOrigins),
    ),
  );
  // In production, localhost should never be an allowed origin unless explicitly set
  const filteredOrigins = isProd
    ? webOrigins.filter((o) => !o.includes('localhost') || (process.env.WEB_ORIGIN ?? '').includes('localhost'))
    : webOrigins;

  app.enableCors({
    origin: filteredOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86400, // cache preflight for 24h so OPTIONS isn't sent per request
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Backstop for anything a controller/service doesn't catch itself (raw
  // Prisma errors, unexpected bugs) — normalizes the response envelope and
  // stops internal error details from leaking to clients.
  app.useGlobalFilters(new AllExceptionsFilter());

  const config = new DocumentBuilder()
    .setTitle('Public Notice Management API')
    .setDescription('API documentation for Public Notice Management')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  // Graceful shutdown: close DB connections and in-flight work on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT) || 5005;
  await app.listen(port);
  const appLogger = app.get(StructuredLogger);
  appLogger.log(`API listening on http://localhost:${port}`, 'Bootstrap', {
    env: process.env.NODE_ENV ?? 'development',
  });
}

void bootstrap();
