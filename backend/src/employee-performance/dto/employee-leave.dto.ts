import { IsString, IsNotEmpty, IsOptional, Matches } from 'class-validator';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export class CreateEmployeeLeaveDto {
  @IsString()
  @IsNotEmpty()
  readonly userId: string;

  @Matches(YMD, { message: 'fromDate يجب أن يكون بصيغة YYYY-MM-DD' })
  readonly fromDate: string;

  @Matches(YMD, { message: 'toDate يجب أن يكون بصيغة YYYY-MM-DD' })
  readonly toDate: string;

  @IsString()
  @IsOptional()
  readonly reason?: string;
}
