import { IsString, IsOptional } from 'class-validator';

export class CreateFollowUpDto {
  @IsString() orderRef: string;
  @IsOptional() @IsString() transactionId?: string;
  @IsOptional() @IsString() clientName?: string;
  @IsOptional() @IsString() clientPhone?: string;
  @IsString() responsibleId: string;
  @IsString() responsibleName: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() comment?: string;
}

export class UpdateFollowUpDto {
  @IsOptional() @IsString() responsibleId?: string;
  @IsOptional() @IsString() responsibleName?: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() comment?: string;
}
