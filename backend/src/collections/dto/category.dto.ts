import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty()
  readonly name: string;

  @IsString()
  @IsOptional()
  readonly parentId?: string;

  @IsBoolean()
  @IsOptional()
  readonly isActive?: boolean;

  @IsString()
  @IsOptional()
  readonly description?: string;
}

export class UpdateCategoryDto {
  /** Manager code for an edit by `categories-edit-otp` (consumed by the controller, never stored). */
  @IsString()
  @IsOptional()
  readonly otpId?: string;

  @IsString()
  @IsOptional()
  readonly name?: string;

  @IsString()
  @IsOptional()
  readonly parentId?: string;

  @IsBoolean()
  @IsOptional()
  readonly isActive?: boolean;

  @IsString()
  @IsOptional()
  readonly description?: string;
}
