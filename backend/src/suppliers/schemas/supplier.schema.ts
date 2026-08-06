import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SupplierDocument = HydratedDocument<Supplier>;

export class SupplierActivityEntry {
  action: string;   // 'إنشاء مورد' | 'تعديل بيانات' | 'حذف مورد' | 'إضافة فاتورة' | 'سداد' | 'إضافة أمر شراء' | ...
  detail: string;   // تفاصيل إضافية
  by: string;       // اسم المستخدم
  at: string;       // ISO timestamp
}

@Schema({ timestamps: true })
export class Supplier {
  @Prop({ required: true })
  name: string;

  /**
   * Primary phone number. Kept as a plain string (rather than folded into `phones`) because many
   * read sites — supplier cards, purchase-order/return printouts, the purchase form's auto-fill —
   * want exactly one number to show. It always mirrors `phones[0]`.
   */
  @Prop()
  phone: string;

  /**
   * All contact numbers for the supplier, primary first. Suppliers commonly have several
   * (landline, sales rep, accounts). `phone` stays in sync with `phones[0]` so older records and
   * single-number read sites keep working without a migration.
   */
  @Prop({ type: [String], default: [] })
  phones: string[];

  @Prop()
  address: string;

  @Prop()
  email: string;

  @Prop()
  products: string;

  @Prop()
  notes: string;

  @Prop({ type: [Object], default: [] })
  activityLog: SupplierActivityEntry[];
}

export const SupplierSchema = SchemaFactory.createForClass(Supplier);
