import { IsString, IsOptional, IsArray } from 'class-validator';

export class CreateFollowUpDto {
  @IsString() orderRef: string;
  @IsOptional() @IsString() transactionId?: string;
  @IsOptional() @IsString() shopifyOrderId?: string;
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
  // Set only by the automatic shipping-issue opener; never sent by the client UI.
  @IsOptional() @IsString() autoSource?: string;
  @IsOptional() @IsString() autoTrigger?: string;
  @IsOptional() @IsString() assignSource?: string;
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
