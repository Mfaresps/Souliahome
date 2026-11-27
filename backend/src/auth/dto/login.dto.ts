import { IsNotEmpty, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  readonly username: string;

  @IsString()
  @IsNotEmpty()
  readonly password: string;

  // ⚠ This device's trusted-device token. It was missing here, so the global whitelist pipe
  // dropped it from every sign-in and «تذكّر هذا الجهاز» never worked (fixed Nov 27, 2026).
  @IsOptional()
  @IsString()
  @MaxLength(128)
  readonly deviceToken?: string;

  // «لست برنامجًا آليًا»: the solved proof-of-work challenge, required after repeated failures.
  @IsOptional()
  @IsObject()
  readonly pow?: { challenge?: string; nonce?: string };

  // «لست برنامجًا آليًا» by Cloudflare Turnstile: the widget's token. Used instead of the proof of
  // work when TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY are set (login-guard.service.ts).
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  readonly captcha?: string;
}
