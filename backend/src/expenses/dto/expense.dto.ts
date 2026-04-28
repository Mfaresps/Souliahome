import { IsString, IsNotEmpty, IsNumber, IsOptional, IsArray, Min } from 'class-validator';

export class CreateExpenseDto {
  @IsString()
  @IsNotEmpty()
  readonly date: string;

  @IsString()
  @IsNotEmpty()
  readonly desc: string;

  @IsString()
  @IsNotEmpty()
  readonly category: string;

  @IsNumber()
  @Min(0)
  readonly amount: number;

  @IsString()
  @IsOptional()
  readonly employee?: string;

  @IsString()
  @IsOptional()
  readonly notes?: string;

  @IsString()
  @IsOptional()
  readonly account?: string;

  @IsString()
  @IsOptional()
  readonly expenseNo?: string;

  @IsString()
  @IsOptional()
  readonly attachment?: string;

  @IsArray()
  @IsOptional()
  readonly descItems?: string[];
}

export class UpdateExpenseDto {
  @IsString()
  @IsOptional()
  readonly date?: string;

  @IsString()
  @IsOptional()
  readonly desc?: string;

  @IsString()
  @IsOptional()
  readonly category?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly amount?: number;

  @IsString()
  @IsOptional()
  readonly employee?: string;

  @IsString()
  @IsOptional()
  readonly notes?: string;

  @IsString()
  @IsOptional()
  readonly account?: string;

  @IsString()
  @IsOptional()
  readonly attachment?: string;

  @IsArray()
  @IsOptional()
  readonly descItems?: string[];
}

export class ApproveExpenseDto {
  @IsString()
  @IsNotEmpty()
  readonly approvedBy: string;
}
