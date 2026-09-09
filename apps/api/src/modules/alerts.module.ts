import { Module } from '@nestjs/common';
import { AlertsController } from '../controllers/alerts.controller';
import { AdminAlertTemplateController } from '../controllers/admin-alert-template.controller';
import { AlertsService } from '../services/alerts.service';
import { AlertMatchingService } from '../services/alert-matching.service';
import { AlertDigestService } from '../services/alert-digest.service';
import { TokenRevocationModule } from '../common/token-revocation.module';
import { NotificationsModule } from './notifications.module';

@Module({
  // AlertsController and AdminAlertTemplateController both use JwtAuthGuard.
  // NotificationsModule provides EmailChannelService, the second delivery
  // channel alongside the (globally provided) Evolution API sender.
  imports: [TokenRevocationModule, NotificationsModule],
  controllers: [AlertsController, AdminAlertTemplateController],
  providers: [AlertsService, AlertMatchingService, AlertDigestService],
  exports: [AlertMatchingService],
})
export class AlertsModule {}
