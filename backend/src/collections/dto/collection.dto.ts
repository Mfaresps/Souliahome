import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsIn,
  ArrayNotEmpty,
} from 'class-validator';

const STATUS_VALUES = ['draft', 'active', 'archived'];
const TYPE_VALUES = [
  'permanent',
  'seasonal',
  'limited',
  'clearance',
  'campaign',
];

export class CreateCollectionDto {
  @IsString()
  @IsNotEmpty()
  readonly name: string;

  @IsString()
  @IsNotEmpty()
  readonly categoryId: string;

  @IsString()
  @IsOptional()
  readonly coverImage?: string;

  @IsString()
  @IsOptional()
  readonly description?: string;

  @IsIn(STATUS_VALUES)
  @IsOptional()
  readonly status?: string;

  @IsIn(TYPE_VALUES)
  @IsOptional()
  readonly type?: string;
}

export class UpdateCollectionDto {
  /** Manager code for an edit by `categories-edit-otp` (consumed by the controller, never stored). */
  @IsString()
  @IsOptional()
  readonly otpId?: string;

  @IsString()
  @IsOptional()
  readonly name?: string;

  @IsString()
  @IsOptional()
  readonly categoryId?: string;

  @IsString()
  @IsOptional()
  readonly coverImage?: string;

  @IsString()
  @IsOptional()
  readonly description?: string;

  @IsIn(STATUS_VALUES)
  @IsOptional()
  readonly status?: string;

  @IsIn(TYPE_VALUES)
  @IsOptional()
  readonly type?: string;
}

export class AssignProductsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  readonly productIds: string[];
}

export class LinkSupplierDto {
  @IsString()
  @IsNotEmpty()
  readonly supplierId: string;
}
