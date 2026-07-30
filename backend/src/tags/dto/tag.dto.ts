import { IsString, IsNotEmpty, IsOptional, MaxLength, Matches, IsIn } from 'class-validator';

const TAG_CATEGORIES = ['operational', 'risk', 'system'] as const;

export class CreateTagDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[\w؀-ۿ\s\-]+$/, { message: 'اسم TAG يجب أن يحتوي على حروف وأرقام فقط' })
  readonly name: string;

  @IsString()
  @IsOptional()
  readonly color?: string;

  @IsString()
  @IsOptional()
  readonly bg?: string;

  @IsIn(TAG_CATEGORIES)
  @IsOptional()
  readonly category?: 'operational' | 'risk' | 'system';
}

export class UpdateTagDto {
  @IsString()
  @IsOptional()
  readonly color?: string;

  @IsString()
  @IsOptional()
  readonly bg?: string;

  @IsIn([...TAG_CATEGORIES, null])
  @IsOptional()
  readonly category?: 'operational' | 'risk' | 'system' | null;
}
