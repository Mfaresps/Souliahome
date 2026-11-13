import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsIn,
  Matches,
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

  // Ignored: access comes from `roleId` (kept optional so an older client still validates).
  @IsString()
  @IsIn(['admin', 'staff', 'viewer'])
  @IsOptional()
  readonly role?: string;

  @IsString()
  @IsOptional()
  readonly roleId?: string;

  @IsString()
  @IsOptional()
  readonly phone?: string;

  @IsString()
  @IsOptional()
  @Matches(/^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/)
  readonly email?: string;

  @IsString()
  @IsOptional()
  readonly avatar?: string;

  @IsString()
  @IsOptional()
  readonly jobTitle?: string;

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
  @Matches(/^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/)
  readonly email?: string;

  @IsString()
  @IsOptional()
  readonly avatar?: string;

  @IsString()
  @IsOptional()
  readonly jobTitle?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  readonly perms?: string[];
}
