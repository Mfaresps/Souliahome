import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsArray,
  Min,
  IsIn,
} from 'class-validator';

export class DiscountCodeDto {
  @IsString()
  @IsOptional()
  readonly id?: string;

  @IsString()
  readonly code: string;

  @IsString()
  @IsOptional()
  readonly description?: string;

  @IsIn(['percent', 'fixed'])
  readonly type: string;

  @IsNumber()
  @Min(0)
  readonly value: number;

  @IsOptional()
  readonly startDate?: string | null;

  @IsOptional()
  readonly endDate?: string | null;

  @IsBoolean()
  @IsOptional()
  readonly active?: boolean;

  @IsString()
  @IsOptional()
  readonly createdBy?: string;
}

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

  @IsBoolean()
  @IsOptional()
  readonly staffDiscountEnabled?: boolean;

  @IsBoolean()
  @IsOptional()
  readonly printIncludePolicy?: boolean;

  @IsString()
  @IsOptional()
  readonly printPolicySales?: string;

  @IsString()
  @IsOptional()
  readonly printPolicyPurchase?: string;

  @IsNumber()
  @Min(8)
  @IsOptional()
  readonly printPolicyFontSize?: number;

  @IsString()
  @IsOptional()
  readonly printPolicyFontWeight?: string;

  @IsBoolean()
  @IsOptional()
  readonly printPolicyHighlight?: boolean;

  @IsArray()
  @IsOptional()
  readonly discountCodes?: DiscountCodeDto[];
}
