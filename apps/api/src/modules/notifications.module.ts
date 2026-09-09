import { Module } from '@nestjs/common';
import {
  AlertChannelStatusController,
  NotificationsController,
} from '../controllers/notifications.controller';
import { AdminWhatsappController } from '../controllers/admin-whatsapp.controller';
import { AlertChannelsController } from '../controllers/alert-channels.controller';
import { NotificationsService } from '../services/notifications.service';
import { EmailChannelService } from '../services/email-channel.service';
import { TokenRevocationModule } from '../common/token-revocation.module';

@Module({
  // NotificationsController/AdminWhatsappController/AlertChannelsController
  // use JwtAuthGuard (+ RolesGuard for admin).
  imports: [TokenRevocationModule],
  controllers: [
    NotificationsController,
    AlertChannelStatusController,
    AdminWhatsappController,
    AlertChannelsController,
  ],
  providers: [NotificationsService, EmailChannelService],
  // Exported so the alert pipeline can deliver over SMTP with the same
  // admin-managed credentials, without a second copy of the config.
  exports: [EmailChannelService],
})
export class NotificationsModule {}
