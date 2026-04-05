import { IsString, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';

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
}

export class VerifyPasswordDto {
  @IsString()
  @IsNotEmpty()
  readonly password: string;
}
