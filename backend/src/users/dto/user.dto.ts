import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsIn,
} from 'class-validator';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  readonly username: string;

  @IsString()
  @IsNotEmpty()
  readonly password: string;

  @IsString()
  @IsNotEmpty()
  readonly name: string;

  @IsString()
  @IsIn(['admin', 'staff', 'viewer'])
  readonly role: string;

  @IsString()
  @IsOptional()
  readonly phone?: string;

  @IsString()
  @IsOptional()
  readonly avatar?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  readonly perms?: string[];
}

export class UpdateUserDto {
  @IsString()
  @IsOptional()
  readonly username?: string;

  @IsString()
  @IsOptional()
  readonly password?: string;

  @IsString()
  @IsOptional()
  readonly name?: string;

  @IsString()
  @IsIn(['admin', 'staff', 'viewer'])
  @IsOptional()
  readonly role?: string;

  @IsString()
  @IsOptional()
  readonly phone?: string;

  @IsString()
  @IsOptional()
  readonly avatar?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  readonly perms?: string[];
}
