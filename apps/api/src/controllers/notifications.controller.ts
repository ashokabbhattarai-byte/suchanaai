import { Controller, Get, Post, Patch, Delete, Body, UseGuards } from '@nestjs/common';
import { User } from '@prisma/client';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { CurrentUser } from '../decorators/current-user.decorator';
import { NotificationsService } from '../services/notifications.service';
import { RequestWhatsappOtpDto } from '../dto/request-whatsapp-otp.dto';
import { VerifyWhatsappOtpDto } from '../dto/verify-whatsapp-otp.dto';
import { ToggleWhatsappAlertsDto } from '../dto/toggle-whatsapp-alerts.dto';
import { ToggleEmailAlertsDto } from '../dto/toggle-email-alerts.dto';
import { SetDigestFrequencyDto } from '../dto/set-digest-frequency.dto';

@Controller('notifications/whatsapp')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('status')
  status(@CurrentUser() user: User) {
    return this.notificationsService.getStatus(user.id);
  }

  @Post('request-otp')
  requestOtp(@CurrentUser() user: User, @Body() dto: RequestWhatsappOtpDto) {
    return this.notificationsService.requestOtp(user.id, dto.phoneNumber);
  }

  @Post('verify-otp')
  verifyOtp(@CurrentUser() user: User, @Body() dto: VerifyWhatsappOtpDto) {
    return this.notificationsService.verifyOtp(user.id, dto.code);
  }

  @Patch('toggle')
  toggle(@CurrentUser() user: User, @Body() dto: ToggleWhatsappAlertsDto) {
    return this.notificationsService.toggleAlerts(user.id, dto.enabled);
  }

  @Patch('digest-frequency')
  setDigestFrequency(@CurrentUser() user: User, @Body() dto: SetDigestFrequencyDto) {
    return this.notificationsService.setDigestFrequency(user.id, dto.digestFrequency);
  }

  @Delete()
  disconnect(@CurrentUser() user: User) {
    return this.notificationsService.disconnect(user.id);
  }
}

/**
 * The email alert channel for the signed-in user. Nothing to verify — alerts
 * go to the account email — so this is only an on/off switch plus whether the
 * admin has SMTP configured at all.
 */
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class AlertChannelStatusController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('channels')
  channels(@CurrentUser() user: User) {
    return this.notificationsService.getChannels(user.id);
  }

  @Patch('email/toggle')
  toggleEmail(@CurrentUser() user: User, @Body() dto: ToggleEmailAlertsDto) {
    return this.notificationsService.toggleEmailAlerts(user.id, dto.enabled);
  }
}
