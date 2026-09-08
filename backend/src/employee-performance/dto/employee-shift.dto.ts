import { IsString, IsNotEmpty, IsOptional, IsBoolean, IsArray, ArrayNotEmpty, IsInt, Min, Max, Matches } from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class CreateEmployeeShiftDto {
  @IsString()
  @IsNotEmpty()
  readonly userId: string;

  @Matches(HHMM, { message: 'shiftStart يجب أن يكون بصيغة HH:mm' })
  readonly shiftStart: string;

  @Matches(HHMM, { message: 'shiftEnd يجب أن يكون بصيغة HH:mm' })
  readonly shiftEnd: string;

  /** 0=Sunday … 6=Saturday. Optional — omitting it means "every day", matching legacy rows. */
  @IsArray()
  @ArrayNotEmpty({ message: 'اختر يوماً واحداً على الأقل' })
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  @IsOptional()
  readonly daysOfWeek?: number[];

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

  @IsArray()
  @ArrayNotEmpty({ message: 'اختر يوماً واحداً على الأقل' })
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  @IsOptional()
  readonly daysOfWeek?: number[];

  @IsBoolean()
  @IsOptional()
  readonly isActive?: boolean;

  @IsBoolean()
  @IsOptional()
  readonly isOnCall?: boolean;
}
