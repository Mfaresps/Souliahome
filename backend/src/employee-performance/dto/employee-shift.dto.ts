import { IsString, IsNotEmpty, IsOptional, IsBoolean, Matches } from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class CreateEmployeeShiftDto {
  @IsString()
  @IsNotEmpty()
  readonly userId: string;

  @Matches(HHMM, { message: 'shiftStart يجب أن يكون بصيغة HH:mm' })
  readonly shiftStart: string;

  @Matches(HHMM, { message: 'shiftEnd يجب أن يكون بصيغة HH:mm' })
  readonly shiftEnd: string;

  @IsBoolean()
  @IsOptional()
  readonly isActive?: boolean;

  @IsBoolean()
  @IsOptional()
  readonly isOnCall?: boolean;
}

export class UpdateEmployeeShiftDto {
  @Matches(HHMM, { message: 'shiftStart يجب أن يكون بصيغة HH:mm' })
  @IsOptional()
  readonly shiftStart?: string;

  @Matches(HHMM, { message: 'shiftEnd يجب أن يكون بصيغة HH:mm' })
  @IsOptional()
  readonly shiftEnd?: string;

  @IsBoolean()
  @IsOptional()
  readonly isActive?: boolean;

  @IsBoolean()
  @IsOptional()
  readonly isOnCall?: boolean;
}
