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
    | 'after_sales'
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
  readonly bostaStatus?: string;
  readonly hasShipment?: boolean;
  readonly pickupStatus?: string;
  readonly deliverySource?: string;
  /** عدد مرات الشحن السابقة — الواجهة بتعرض «بانتظار شحنة N» بدل «لم تُشحن». */
  readonly shipmentAttempts?: number;
  /**
   * حالة الإلغاء لحركة عادية (مش شوبيفاي). الحركة الملغاة بتظهر في البحث
   * وبتترسم بادج «ملغي» أحمر — إخفاؤها كان بيخلي البحث برقم الأوردر يقول
   * «لم يتم العثور على نتائج»، وده بيتقري إن الأوردر مش موجود مش إنه اتلغى.
   */
  readonly cancelled?: boolean;
  readonly cancelledAt?: string;
  readonly cancelReason?: string;
  readonly shopifyStatus?: string;
  readonly shopifyCancelled?: boolean;
  /** Minimal workflow data for the shared order-state renderer. */
  readonly orderState?: Record<string, unknown>;
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
