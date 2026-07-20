import { IsString, IsNotEmpty, IsOptional, IsNumber, IsBoolean } from 'class-validator';

export class CreateFolderDto {
  @IsString()
  @IsNotEmpty()
  readonly name: string;

  @IsString()
  @IsOptional()
  readonly description?: string;

  @IsString()
  @IsOptional()
  readonly icon?: string;

  @IsNumber()
  @IsOptional()
  readonly order?: number;

  @IsBoolean()
  @IsOptional()
  readonly isActive?: boolean;
}

export class UpdateFolderDto {
  @IsString()
  @IsOptional()
  readonly name?: string;

  @IsString()
  @IsOptional()
  readonly description?: string;

  @IsString()
  @IsOptional()
  readonly icon?: string;

  @IsNumber()
  @IsOptional()
  readonly order?: number;

  @IsBoolean()
  @IsOptional()
  readonly isActive?: boolean;
}
