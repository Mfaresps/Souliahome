import { IsString, IsNotEmpty, IsNumber, IsOptional, IsEnum, IsBoolean } from 'class-validator';

export class CreateVaultEntryDto {
  @IsNumber()
  readonly amount: number;

  @IsString()
  @IsNotEmpty()
  readonly seg: string;

  @IsString()
  @IsOptional()
  readonly method?: string;

  @IsString()
  @IsOptional()
  readonly desc?: string;

  @IsString()
  @IsOptional()
  readonly date?: string;

  @IsString()
  @IsOptional()
  readonly employee?: string;

  @IsEnum(['completed', 'pending', 'frozen', 'cancelled'])
  @IsOptional()
  readonly status?: string;

  @IsString()
  @IsOptional()
  readonly transactionType?: string;

  @IsString()
  @IsOptional()
  readonly customer?: string;

  @IsString()
  @IsOptional()
  readonly supplier?: string;

  @IsString()
  @IsOptional()
  readonly notes?: string;

  @IsString()
  @IsOptional()
  readonly accountingJustification?: string;

  @IsString()
  @IsOptional()
  readonly entityLabel?: string;

  @IsString()
  @IsOptional()
  readonly ref?: string;

  @IsBoolean()
  @IsOptional()
  readonly requiresApproval?: boolean;
}

export class UpdateVaultEntryDto {
  @IsString()
  @IsOptional()
  readonly desc?: string;

  @IsNumber()
  @IsOptional()
  readonly amount?: number;

  @IsEnum(['completed', 'pending', 'frozen', 'cancelled'])
  @IsOptional()
  readonly status?: string;

  @IsString()
  @IsOptional()
  readonly notes?: string;

  @IsString()
  @IsOptional()
  readonly accountingJustification?: string;

  @IsString()
  @IsOptional()
  readonly frozenReason?: string;

  @IsBoolean()
  @IsOptional()
  readonly isApproved?: boolean;
}

export class VerifyPasswordDto {
  @IsString()
  @IsNotEmpty()
  readonly password: string;
}
