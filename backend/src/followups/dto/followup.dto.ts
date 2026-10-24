import { IsString, IsOptional, IsArray, IsIn, IsISO8601, MaxLength } from 'class-validator';

export class DeferFollowUpDto {
  @IsIn(['customer_postponed', 'carrier_delay', 'awaiting_return']) reason: string;
  @IsISO8601() until: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

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
