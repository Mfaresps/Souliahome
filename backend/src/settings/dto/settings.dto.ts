import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsArray,
  Min,
} from 'class-validator';

export class UpdateSettingsDto {
  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly cairoPrice?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly govPrice?: number;

  @IsArray()
  @IsOptional()
  readonly shipCos?: { name: string; cairo: number; gov: number }[];

  @IsString()
  @IsOptional()
  readonly vaultPass?: string;

  @IsNumber()
  @IsOptional()
  readonly vaultBalance?: number;

  @IsNumber()
  @IsOptional()
  readonly vaultCash?: number;

  @IsNumber()
  @IsOptional()
  readonly vaultVodafone?: number;

  @IsNumber()
  @IsOptional()
  readonly vaultInstapay?: number;

  @IsNumber()
  @IsOptional()
  readonly vaultBank?: number;

  @IsString()
  @IsOptional()
  readonly lang?: string;

  @IsBoolean()
  @IsOptional()
  readonly langEnabled?: boolean;

  @IsBoolean()
  @IsOptional()
  readonly darkMode?: boolean;
}
