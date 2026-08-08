import { IsString, MinLength } from 'class-validator';

export class SearchQueryDto {
  @IsString()
  @MinLength(1)
  q: string;
}

export interface SearchResultItem {
  readonly id: string;
  readonly type:
    | 'product'
    | 'order'
    | 'customer'
    | 'supplier'
    | 'complaint'
    | 'shopify_order';
  readonly title: string;
  readonly subtitle: string;
  readonly icon: string;
  readonly meta?: string;
  readonly imageUrl?: string;
  readonly total?: number;
  readonly itemsCount?: number;
  readonly createdAt?: string;
  readonly payStatus?: string;
  readonly bostaStatusLabel?: string;
  readonly shopifyStatus?: string;
  readonly shopifyCancelled?: boolean;
  /**
   * درجة الصلة (relevance). الواجهة ترتّب بها العناصر داخل كل قسم، وترتّب
   * الأقسام بأعلى درجة داخلها — بدلاً من قائمة أولويات ثابتة.
   */
  readonly score?: number;
}

export interface SearchResponse {
  readonly results: SearchResultItem[];
  readonly total: number;
}
