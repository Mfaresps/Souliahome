import { IsString, IsNotEmpty, IsOptional, MaxLength, Matches } from 'class-validator';

export class CreateTagDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[\w؀-ۿ\s\-]+$/, { message: 'اسم TAG يجب أن يحتوي على حروف وأرقام فقط' })
  readonly name: string;

  @IsString()
  @IsOptional()
  readonly color?: string;

  @IsString()
  @IsOptional()
  readonly bg?: string;
}

export class UpdateTagDto {
  @IsString()
  @IsOptional()
  readonly color?: string;

  @IsString()
  @IsOptional()
  readonly bg?: string;
}
