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
