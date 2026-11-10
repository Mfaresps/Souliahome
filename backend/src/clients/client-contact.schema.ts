import { Schema } from 'mongoose';

export const ClientContactSchema = new Schema({
  key: { type: String, required: true, unique: true },
  email: { type: String, default: '' },
  updatedBy: String,
}, { timestamps: true });
