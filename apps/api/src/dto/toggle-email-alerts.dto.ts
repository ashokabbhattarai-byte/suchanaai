import { IsBoolean } from 'class-validator';

export class ToggleEmailAlertsDto {
  @IsBoolean()
  enabled: boolean;
}
