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

  @Prop()
  phone: string;

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
