import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsArray,
  IsObject,
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

export class DiscountBundleDto {
  @IsString()
  @IsOptional()
  readonly id?: string;

  @IsString()
  readonly name: string;

  @IsString()
  @IsOptional()
  readonly description?: string;

  @IsArray()
  readonly productIds: string[];

  @IsString()
  readonly discountCodeId: string;

  @IsBoolean()
  @IsOptional()
  readonly active?: boolean;

  @IsBoolean()
  @IsOptional()
  readonly allowPartial?: boolean;

  @IsString()
  @IsOptional()
  readonly partialDiscountCodeId?: string | null;

  @IsNumber()
  @IsOptional()
  readonly priority?: number;

  @IsNumber()
  @Min(1)
  @IsOptional()
  readonly minQty?: number;

  @IsObject()
  @IsOptional()
  readonly productMinQtys?: Record<string, number>;
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
  readonly shipCos?: { code?: string; name: string; cairo: number; gov: number }[];

  /**
   * ⚠ لازم يتعرّف هنا وإلا الـ whitelist pipe بيشيله بصمت عند الحفظ — نفس الفخ
   * اللي وقعت فيه حقول هوية الشركة. القيمة بتتخزن كما هي (Object) لأن شكل القالب
   * متداخل، والتحقق من محتواه بيتم في الواجهة قبل الحفظ.
   */
  @IsArray()
  @IsOptional()
  readonly shiftRotas?: Record<string, unknown>[];

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
  readonly otpEnabled?: boolean;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly highValueDiscountLimit?: number;

  @IsNumber()
  @Min(1)
  @IsOptional()
  readonly highValueDiscountOtpTtlMin?: number;

  @IsBoolean()
  @IsOptional()
  readonly purchaseOtpEnabled?: boolean;

  @IsBoolean()
  @IsOptional()
  readonly printIncludePolicy?: boolean;

  @IsString()
  @IsOptional()
  readonly defaultPayMethod?: string;

  @IsString()
  @IsOptional()
  readonly defaultDepMethod?: string;

  @IsString()
  @IsOptional()
  readonly defaultShipCo?: string;

  /** Carrier code pre-selected in the order-entry forms. Validated in SettingsService. */
  @IsString()
  @IsOptional()
  readonly defaultCarrierCode?: string;

  /* Company identity — the issuer block on the printed invoice. All optional:
   * the print layout omits any line left empty. */
  @IsString()
  @IsOptional()
  readonly companyLegalName?: string;

  @IsString()
  @IsOptional()
  readonly companyAddress?: string;

  @IsString()
  @IsOptional()
  readonly companyPhone?: string;

  @IsString()
  @IsOptional()
  readonly companyEmail?: string;

  @IsString()
  @IsOptional()
  readonly companyWebsite?: string;

  @IsString()
  @IsOptional()
  readonly companyTaxNumber?: string;

  @IsString()
  @IsOptional()
  readonly companyCommercialReg?: string;

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

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly codCollectionThreshold?: number;

  // ⚠ Declared here or the whitelist pipe silently strips them at save.
  @IsBoolean()
  @IsOptional()
  readonly autoSettleEnabled?: boolean;

  @IsString()
  @IsOptional()
  readonly autoSettleSince?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly autoSettleReviewLimit?: number;

  @IsString()
  @IsOptional()
  readonly autoSettleVaultMethod?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly autoSettleReadDelaySec?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly carrierTransferFee?: number;

  @IsObject()
  @IsOptional()
  readonly performanceConfig?: {
    deliveryPoints?: number;
    depositFullPoints?: number;
    depositPartial50Points?: number;
    depositPartialLowPoints?: number;
    depositNonePoints?: number;
  };
}
