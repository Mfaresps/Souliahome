import { IsString, MinLength } from 'class-validator';

export class SearchQueryDto {
  @IsString()
  @MinLength(1)
  q: string;
}

export interface SearchResultItem {
  readonly id: string;
  readonly type: 'product' | 'order' | 'customer' | 'supplier';
  readonly title: string;
  readonly subtitle: string;
  readonly icon: string;
  readonly meta?: string;
}

export interface SearchResponse {
  readonly results: SearchResultItem[];
  readonly total: number;
}
