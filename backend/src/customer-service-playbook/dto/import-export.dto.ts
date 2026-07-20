import { IsArray, IsIn, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import { CardType } from '../schemas/knowledge-card.schema';

export interface ParsedFolderRow {
  row: number;
  name: string;
  description: string;
  icon: string;
  order: number;
  isActive: boolean;
}

export interface ParsedCardRow {
  row: number;
  folderName: string;
  title: string;
  cardType: CardType;
  scenario: string;
  customerQuestion: string;
  response: string;
  internalNotes: string;
  tags: string[];
  isActive: boolean;
}

export interface ImportPreviewError {
  row: number;
  message: string;
}

export interface DuplicateCardPreview {
  key: string;
  existingId: string;
  folderName: string;
  existing: ParsedCardRow;
  incoming: ParsedCardRow;
}

export interface ImportPreviewResult {
  newFolders: ParsedFolderRow[];
  newCards: ParsedCardRow[];
  duplicateCards: DuplicateCardPreview[];
  errors: ImportPreviewError[];
}

export type DuplicateDecision = 'skip' | 'update' | 'duplicate';

export class ConfirmImportDto {
  @IsString()
  @IsNotEmpty()
  readonly filename: string;

  @IsArray()
  readonly newFolders: ParsedFolderRow[];

  @IsArray()
  readonly newCards: ParsedCardRow[];

  @IsArray()
  readonly duplicateCards: DuplicateCardPreview[];

  @IsOptional()
  @IsArray()
  readonly errors?: ImportPreviewError[];

  @IsObject()
  readonly decisions: Record<string, DuplicateDecision>;
}

export class ExportQueryDto {
  @IsString()
  @IsIn(['excel', 'json'])
  @IsOptional()
  readonly format?: string;
}
