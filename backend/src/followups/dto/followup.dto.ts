import { IsString, IsOptional, IsArray } from 'class-validator';

export class CreateFollowUpDto {
  @IsString() orderRef: string;
  @IsOptional() @IsString() transactionId?: string;
  @IsOptional() @IsString() clientName?: string;
  @IsOptional() @IsString() clientPhone?: string;
  @IsString() responsibleId: string;
  @IsString() responsibleName: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() reasonOther?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() resolution?: string;
  @IsOptional() @IsString() comment?: string;
  @IsOptional() @IsArray() tags?: string[];
}

export class UpdateFollowUpDto {
  @IsOptional() @IsString() clientName?: string;
  @IsOptional() @IsString() clientPhone?: string;
  @IsOptional() @IsString() responsibleId?: string;
  @IsOptional() @IsString() responsibleName?: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() reasonOther?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() resolution?: string;
  @IsOptional() @IsString() comment?: string;
  @IsOptional() @IsArray() tags?: string[];
}
