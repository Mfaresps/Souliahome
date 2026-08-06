import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CollectionDocument = HydratedDocument<Collection>;

export type CollectionStatus = 'draft' | 'active' | 'archived';
export type CollectionType =
  | 'permanent'
  | 'seasonal'
  | 'limited'
  | 'clearance'
  | 'campaign';

export class CollectionActivityEntry {
  action: string;
  detail: string;
  by: string; // اسم المستخدم
  at: string; // ISO timestamp
}

@Schema({ timestamps: true })
export class Collection {
  @Prop({ required: true, unique: true })
  name: string;

  @Prop({ required: true, unique: true })
  code: string;

  @Prop({ type: String, default: null })
  categoryId: string | null;

  @Prop({ default: '' })
  coverImage: string;

  @Prop({ default: '' })
  description: string;

  @Prop({ enum: ['draft', 'active', 'archived'], default: 'draft' })
  status: CollectionStatus;

  @Prop({
    enum: ['permanent', 'seasonal', 'limited', 'clearance', 'campaign'],
    default: 'permanent',
  })
  type: CollectionType;

  @Prop({ type: [String], default: [] })
  supplierIds: string[];

  @Prop({ type: [String], default: [] })
  tagIds: string[];

  @Prop({ type: [Object], default: [] })
  activityLog: CollectionActivityEntry[];
}

export const CollectionSchema = SchemaFactory.createForClass(Collection);
