import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { HttpModule } from '@nestjs/axios';
import { AuthModule } from './modules/auth.module';
import { UsersModule } from './modules/users.module';
import { NoticesModule } from './modules/notices.module';
import { DocumentsModule } from './modules/documents.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { PrismaModule } from './prisma/prisma.module';
import { RagModule } from './modules/rag.module';
import { ScrapingModule } from './modules/scraping.module';
import { SettingsModule } from './modules/settings.module';
import { BillingModule } from './modules/billing.module';
import { EvolutionApiModule } from './integrations/evolution/evolution-api.module';
import { AlertsModule } from './modules/alerts.module';
import { NotificationsModule } from './modules/notifications.module';
import { ContactModule } from './modules/contact.module';
import { SettingsController, PublicSettingsController, InternalAiConfigController, AdminAiHealthController } from './controllers/settings.controller';
import { HealthController } from './controllers/health.controller';
import { MaintenanceMiddleware } from './common/maintenance.middleware';
import { LoggerModule } from './common/logger';
import { TokenRevocationModule } from './common/token-revocation.module';
import { StorageModule } from './common/storage/storage.module';
import { CryptoModule } from './common/crypto/crypto.module';
import { AiProvidersService } from './services/ai-providers.service';
import { AiProvidersController } from './controllers/ai-providers.controller';
import { InternalAiProvidersController } from './controllers/internal-ai-providers.controller';
import { AdminUsersController } from './controllers/admin-users.controller';
import { AdminSystemController } from './controllers/admin-system.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),
    // Global axios default. Per-route overrides (notices search/ask 120s) handle slow LLM legs; keep global above those but below nginx 300s so the AI, not the proxy, owns the timeout message. Was 45s — too short for Ollama 1.5b cold fallbacks and caused "(canceled)" in tandem with the frontend's 20s timer.
    HttpModule.register({ timeout: 120000 }),
    LoggerModule,
    // SettingsController is registered here and is guarded by JwtAuthGuard.
    TokenRevocationModule,
    PrismaModule,
    StorageModule,
    CryptoModule,
    SettingsModule,
    EvolutionApiModule,
    UsersModule,
    AuthModule,
    NoticesModule,
    DocumentsModule,
    WebhooksModule,
    RagModule,
    ScrapingModule,
    AlertsModule,
    NotificationsModule,
    ContactModule,
    BillingModule,
  ],
  controllers: [
    HealthController,
    SettingsController,
    PublicSettingsController,
    InternalAiConfigController,
    InternalAiProvidersController,
    AdminAiHealthController,
    AiProvidersController,
    AdminUsersController,
    AdminSystemController,
  ],
  providers: [AiProvidersService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MaintenanceMiddleware).forRoutes('*');
  }
}