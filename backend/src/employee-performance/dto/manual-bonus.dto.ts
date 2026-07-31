import { IsString, IsNotEmpty, IsInt, NotEquals } from 'class-validator';

export class ManualBonusDto {
  @IsString()
  @IsNotEmpty()
  readonly employeeId: string;

  @IsInt()
  @NotEquals(0, { message: 'قيمة النقاط يجب ألا تساوي صفر' })
  readonly points: number;

  @IsString()
  @IsNotEmpty({ message: 'سبب التعديل مطلوب' })
  readonly reason: string;
}
