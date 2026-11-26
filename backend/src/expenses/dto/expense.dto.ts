import { IsString, IsNotEmpty, IsNumber, IsOptional, IsArray, IsBoolean, IsObject, Min, MaxLength } from 'class-validator';

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

  /** Saved party (ads agency / employee / subscription). Name is copied by the server. */
  @IsString()
  @IsOptional()
  readonly payeeId?: string;

  @IsString()
  @IsOptional()
  readonly periodFrom?: string;

  @IsString()
  @IsOptional()
  readonly periodTo?: string;

  /** Also store this amount as the payee's default (salary: admin only). Never persisted on the expense. */
  @IsBoolean()
  @IsOptional()
  readonly updatePayeeAmount?: boolean;

  /** Salary breakdown — the server recomputes the bonus and the net; amount becomes the net. */
  @IsObject()
  @IsOptional()
  readonly salary?: Record<string, any>;
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

  @IsString()
  @IsOptional()
  readonly payeeId?: string;

  @IsString()
  @IsOptional()
  readonly periodFrom?: string;

  @IsString()
  @IsOptional()
  readonly periodTo?: string;

  @IsBoolean()
  @IsOptional()
  readonly updatePayeeAmount?: boolean;

  /** Salary breakdown — the server recomputes the bonus and the net; amount becomes the net. */
  @IsObject()
  @IsOptional()
  readonly salary?: Record<string, any>;
}

export class ApproveExpenseDto {
  @IsString()
  @IsNotEmpty()
  readonly approvedBy: string;
}

export class ExpensePayeeDto {
  @IsString()
  @IsOptional()
  readonly kind?: string;

  @IsString()
  @IsOptional()
  @MaxLength(80)
  readonly name?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly amount?: number;

  @IsString()
  @IsOptional()
  readonly account?: string;

  @IsString()
  @IsOptional()
  readonly platform?: string;

  @IsString()
  @IsOptional()
  readonly billingCycle?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly pointValue?: number;

  @IsString()
  @IsOptional()
  readonly userId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  readonly notes?: string;

  @IsBoolean()
  @IsOptional()
  readonly active?: boolean;
}
