import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

export class CreateContactMessageDto {
  @IsString()
  @Length(2, 100)
  name: string;

  @IsEmail()
  @MaxLength(255)
  email: string;

  @IsString()
  @Length(5, 200)
  subject: string;

  @IsString()
  @Length(10, 5000)
  message: string;

  /**
   * Honeypot — must be empty. Humans never fill it (hidden field), bots do.
   * If non-empty we treat it as spam and silently archive instead of notifying.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  website?: string;

  /**
   * Optional client-side timestamp to detect instant-bot submissions
   * (submitted < 2s after page load). Not trusted, just a heuristic.
   */
  @IsOptional()
  @IsString()
  hpTimestamp?: string;

  /**
   * Google reCAPTCHA v2 checkbox token (g-recaptcha-response).
   * Required when RECAPTCHA_SECRET_KEY is configured server-side.
   * When the server has no secret configured, this may be omitted (dev mode).
   *
   * Google does not document a token length and has grown it over time — real
   * tokens already exceed the 2048 this used to cap, which rejected a valid
   * submission as a malformed one. The bound only exists to stop an unbounded
   * body reaching the verify call, so it is set well clear of any real token.
   */
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  recaptchaToken?: string;
}
