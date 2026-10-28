import {
  IsString,
  IsOptional,
  IsNotEmpty,
  IsNumber,
  Min,
  Max,
  IsIn, IsArray, IsInt, IsBoolean, MaxLength,
} from 'class-validator';

export class CreateComplaintDto {
  @IsOptional() @IsString()
  ownerId?: string;
  @IsOptional() @IsString() @MaxLength(120)
  operationKey?: string;
  @IsOptional() @IsArray()
  items?: any[];
  @IsOptional()
  @IsString()
  transactionId?: string;

  @IsOptional()
  @IsString()
  transactionRef?: string;

  @IsOptional()
  @IsString()
  clientName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsString()
  productCode?: string;

  @IsOptional()
  @IsString()
  productName?: string;

  @IsOptional()
  @IsString()
  productImageUrl?: string;

  @IsOptional()
  @IsNumber()
  productQty?: number;

  @IsOptional()
  @IsString()
  variantDetail?: string;

  @IsOptional()
  @IsString()
  categoryGroup?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsNotEmpty()
  @IsString()
  description: string;

  @IsOptional()
  @IsString()
  priority?: string;
}

/** Admin edit of an existing complaint. Every field optional — only what is sent gets written. */
export class UpdateComplaintDto {
  @IsOptional()
  @IsString()
  clientName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  variantDetail?: string;

  @IsOptional()
  @IsString()
  categoryGroup?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsNotEmpty()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  priority?: string;
}

export class ResolveComplaintDto {
  @IsNotEmpty()
  @IsString()
  @IsIn(['مقبول', 'مرفوض'])
  status: string; // مقبول | مرفوض

  @IsOptional()
  @IsString()
  managerAction?: string;

  @IsOptional()
  @IsString()
  actionNote?: string;
}

export class SurveyResponseDto {
  @IsNumber()
  @Min(1)
  @Max(5)
  rating: number;

  @IsOptional()
  @IsString()
  comment?: string;
}

export class UpdateProgressStageDto {
  @IsString()
  @IsIn(['', 'جاري المراجعة', 'جاري العمل على حل المشكلة', 'بانتظار رد العميل', 'تم حل المشكلة بنجاح'])
  progressStage: string;
}

export class ComplaintWorkflowDto {
  @IsString() @IsNotEmpty() @MaxLength(120) operationKey: string;
  @IsInt() @Min(0) expectedRevision: number;
  @IsIn(['assign','review','wait','resume','plan','link','unlink','fulfill','payment','contact','close','reopen','archive','items','comment']) action: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsString() ownerId?: string;
  @IsOptional() @IsString() dueAt?: string;
  @IsOptional() @IsIn(['customer','warehouse','carrier','stock','manager','payment']) waitingFor?: string;
  @IsOptional() @IsIn(['exchange','return','support','delivery','compensation','refund_without_return']) solution?: string;
  @IsOptional() @IsString() caseId?: string;
  @IsOptional() @IsIn(['resolved','rejected','withdrawn','duplicate','unreachable','partial_agreement']) outcome?: string;
  @IsOptional() @IsString() duplicateId?: string;
  @IsOptional() @IsBoolean() customerConfirmed?: boolean;
  @IsOptional() @IsBoolean() confirmed?: boolean;
  @IsOptional() @IsString() @MaxLength(500) customerMessage?: string;
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() method?: string;
  @IsOptional() @IsNumber() @Min(0.01) @Max(1000000) amount?: number;
  @IsOptional() @IsIn(['phone','whatsapp','email','other']) channel?: string;
  @IsOptional() @IsIn(['reached','no_answer','confirmed','disputed']) contactResult?: string;
  @IsOptional() @IsArray() items?: any[];
  @IsOptional() @IsString() transactionId?: string;
}

export class CreateNoteDto {
  @IsNotEmpty()
  @IsString()
  text: string;
}

export class UpdateNoteDto {
  @IsNotEmpty()
  @IsString()
  text: string;
}
