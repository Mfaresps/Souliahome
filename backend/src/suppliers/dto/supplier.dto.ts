import { IsString, IsNotEmpty, IsOptional, IsEmail, IsArray, ArrayMaxSize, ValidateIf, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

/** Guards against an unbounded phone list being posted; no real supplier needs more. */
const MAX_SUPPLIER_PHONES = 10;

/**
 * Trims each entry and drops blanks BEFORE validation runs. Without this, an empty row from the
 * form would reach @Matches({each:true}) and fail, even though a blank number is legitimately
 * "not provided". Non-arrays pass through untouched so @IsArray still reports a wrong type.
 */
const stripBlankPhones = () =>
  Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map(v => String(v ?? '').trim()).filter(Boolean)
      : value,
  );

/** Egyptian mobile: 11 digits starting 010/011/012/015 — same rule the frontend enforces. */
const EG_PHONE = /^01[0125][0-9]{8}$/;
const PHONE_MSG = 'رقم الهاتف غير صحيح — يجب أن يكون 11 رقماً ويبدأ بـ 010 أو 011 أو 012 أو 015';

export class CreateSupplierDto {
  @IsString()
  @IsNotEmpty()
  readonly name: string;

  // A blank phone is allowed (the field is optional); a present one must be a valid EG mobile.
  @ValidateIf((o: { phone?: string }) => !!o.phone)
  @Matches(EG_PHONE, { message: PHONE_MSG })
  @IsString()
  @IsOptional()
  readonly phone?: string;

  @stripBlankPhones()
  @IsArray()
  @IsString({ each: true })
  @Matches(EG_PHONE, { each: true, message: PHONE_MSG })
  @ArrayMaxSize(MAX_SUPPLIER_PHONES)
  @IsOptional()
  readonly phones?: string[];

  @IsString()
  @IsOptional()
  readonly address?: string;

  // Email is optional. @IsOptional() alone only skips undefined/null, but the supplier form always
  // posts a string — an untouched field arrives as '' and would fail @IsEmail. ValidateIf lets a
  // blank value through while still validating a real one.
  @ValidateIf((o: { email?: string }) => o.email !== undefined && o.email !== null && o.email !== '')
  @IsEmail({}, { message: 'صيغة البريد الإلكتروني غير صحيحة' })
  @IsOptional()
  readonly email?: string;

  @IsString()
  @IsOptional()
  readonly products?: string;

  @IsString()
  @IsOptional()
  readonly notes?: string;

  @IsString()
  @IsOptional()
  readonly by?: string;
}

export class UpdateSupplierDto {
  @IsString()
  @IsOptional()
  readonly name?: string;

  // A blank phone is allowed (the field is optional); a present one must be a valid EG mobile.
  @ValidateIf((o: { phone?: string }) => !!o.phone)
  @Matches(EG_PHONE, { message: PHONE_MSG })
  @IsString()
  @IsOptional()
  readonly phone?: string;

  @stripBlankPhones()
  @IsArray()
  @IsString({ each: true })
  @Matches(EG_PHONE, { each: true, message: PHONE_MSG })
  @ArrayMaxSize(MAX_SUPPLIER_PHONES)
  @IsOptional()
  readonly phones?: string[];

  @IsString()
  @IsOptional()
  readonly address?: string;

  // Email is optional. @IsOptional() alone only skips undefined/null, but the supplier form always
  // posts a string — an untouched field arrives as '' and would fail @IsEmail. ValidateIf lets a
  // blank value through while still validating a real one.
  @ValidateIf((o: { email?: string }) => o.email !== undefined && o.email !== null && o.email !== '')
  @IsEmail({}, { message: 'صيغة البريد الإلكتروني غير صحيحة' })
  @IsOptional()
  readonly email?: string;

  @IsString()
  @IsOptional()
  readonly products?: string;

  @IsString()
  @IsOptional()
  readonly notes?: string;

  @IsString()
  @IsOptional()
  readonly by?: string;
}

export class AddSupplierLogDto {
  @IsString()
  @IsNotEmpty()
  readonly action: string;

  @IsString()
  @IsOptional()
  readonly detail?: string;

  @IsString()
  @IsOptional()
  readonly by?: string;
}
