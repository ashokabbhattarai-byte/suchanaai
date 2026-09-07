import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ScrapingController } from '../controllers/scraping.controller';
import { InternalScrapingController } from '../controllers/internal-scraping.controller';
import { ScrapingService } from '../services/scraping.service';
import { ScrapingSchedulerService } from '../services/scraping-scheduler.service';
import { SettingsModule } from './settings.module';
import { TokenRevocationModule } from '../common/token-revocation.module';
import { NoticesModule } from './notices.module';
import { AlertsModule } from './alerts.module';

@Module({
  imports: [
    HttpModule.register({
      timeout: 300000,
    }),
    SettingsModule,
    // ScrapingController is guarded by JwtAuthGuard, which is instantiated in
    // this module's injector and needs TokenRevocationService in scope.
    TokenRevocationModule,
    // For the admin re-extract endpoints.
    NoticesModule,
    // For AlertMatchingService, called after each new ScrapedItem is saved.
    AlertsModule,
  ],
  controllers: [ScrapingController, InternalScrapingController],
  providers: [ScrapingService, ScrapingSchedulerService],
  exports: [ScrapingService, ScrapingSchedulerService],
})
export class ScrapingModule {}
