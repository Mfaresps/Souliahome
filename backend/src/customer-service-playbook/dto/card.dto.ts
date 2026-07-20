import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsBoolean,
  IsIn,
  IsMongoId,
} from 'class-validator';

const CARD_TYPES = ['response', 'policy', 'procedure', 'warning'];

export class CreateCardDto {
  @IsMongoId()
  readonly folderId: string;

  @IsString()
  @IsNotEmpty()
  readonly title: string;

  @IsString()
  @IsOptional()
  readonly scenario?: string;

  @IsString()
  @IsOptional()
  readonly customerQuestion?: string;

  @IsString()
  @IsNotEmpty()
  readonly response: string;

  @IsString()
  @IsOptional()
  readonly internalNotes?: string;

  @IsString()
  @IsIn(CARD_TYPES)
  @IsOptional()
  readonly cardType?: string;

  @IsArray()
  @IsOptional()
  readonly tags?: string[];

  @IsBoolean()
  @IsOptional()
  readonly isActive?: boolean;
}

export class UpdateCardDto {
  @IsMongoId()
  @IsOptional()
  readonly folderId?: string;

  @IsString()
  @IsOptional()
  readonly title?: string;

  @IsString()
  @IsOptional()
  readonly scenario?: string;

  @IsString()
  @IsOptional()
  readonly customerQuestion?: string;

  @IsString()
  @IsOptional()
  readonly response?: string;

  @IsString()
  @IsOptional()
  readonly internalNotes?: string;

  @IsString()
  @IsIn(CARD_TYPES)
  @IsOptional()
  readonly cardType?: string;

  @IsArray()
  @IsOptional()
  readonly tags?: string[];

  @IsBoolean()
  @IsOptional()
  readonly isActive?: boolean;
}
