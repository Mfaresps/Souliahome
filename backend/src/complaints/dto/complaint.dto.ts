import {
  IsString,
  IsOptional,
  IsNotEmpty,
  IsNumber,
  Min,
  Max,
} from 'class-validator';

export class CreateComplaintDto {
  @IsOptional()
  @IsString()
  transactionId?: string;

  @IsOptional()
  @IsString()
  transactionRef?: string;

  @IsOptional()
  @IsString()
  clientName?: string;

  @IsNotEmpty()
  @IsString()
  description: string;

  @IsOptional()
  @IsString()
  priority?: string;
}

export class ResolveComplaintDto {
  @IsNotEmpty()
  @IsString()
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
  progressStage: string;
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
