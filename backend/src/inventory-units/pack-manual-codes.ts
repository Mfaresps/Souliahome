import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ClientSession, Connection, Types } from 'mongoose';

const counterId = new Types.ObjectId('000000000000000000000002');
function check(body: string) {
  let sum = 0;
  for (let i = body.length - 1, twice = true; i >= 0; i--, twice = !twice) {
    let digit = Number(body[i]); if (twice) { digit *= 2; if (digit > 9) digit -= 9; } sum += digit;
  }
  return String((10 - sum % 10) % 10);
}
export function normalizePackCode(value: string) {
  const raw = String(value || '').trim().replace(/[٠-٩۰-۹]/g, c => String(c.charCodeAt(0) - (c <= '٩' ? 0x660 : 0x6f0))).toUpperCase();
  const compact = raw.replace(/^PK/, '').replace(/[\s-]/g, '');
  if (!/^\d{7}$/.test(compact)) return raw;
  if (check(compact.slice(0,6)) !== compact[6]) throw new BadRequestException('Invalid pack code; check the final verification digit');
  return `PK-${compact.slice(0,6)}-${compact[6]}`;
}
export function packCodeFilter(value: string) {
  const code = normalizePackCode(value);
  return /^PK-\d{6}-\d$/.test(code) ? {manualCode:code} : {barcode:code};
}
export async function initPackCodes(connection: Connection) {
  await connection.collection('inventorypacks').createIndex({manualCode:1},{unique:true,partialFilterExpression:{manualCode:{$type:'string'}},name:'inventory_pack_manual_code_unique'});
  const highest = await connection.collection('inventorypacks').find({manualCode:{$regex:'^PK-[0-9]{6}-[0-9]$'}},{projection:{manualCode:1}}).sort({manualCode:-1}).limit(1).next();
  await connection.collection('inventoryunitcodecounters').updateOne({_id:counterId},{$max:{sequence:highest ? Number(highest.manualCode.slice(3,9)) : 0}},{upsert:true});
}
export async function nextPackCode(connection: Connection, session?: ClientSession) {
  const counter:any = await connection.collection('inventoryunitcodecounters').findOneAndUpdate({_id:counterId},{$inc:{sequence:1}},{session,upsert:true,returnDocument:'after',includeResultMetadata:false});
  if (!Number.isSafeInteger(counter?.sequence) || counter.sequence < 1 || counter.sequence > 999999) throw new ServiceUnavailableException('Manual pack code counter requires review');
  const body = String(counter.sequence).padStart(6,'0');
  return `PK-${body}-${check(body)}`;
}
export async function manualPackCode(connection: Connection, pack: any, session?: ClientSession): Promise<string> {
  if (pack.manualCode) return pack.manualCode;
  const manualCode = await nextPackCode(connection,session);
  const saved = await connection.collection('inventorypacks').findOneAndUpdate({_id:pack._id,manualCode:{$exists:false}},{$set:{manualCode}},{session,returnDocument:'after',includeResultMetadata:false});
  return saved?.manualCode || (await connection.collection('inventorypacks').findOne({_id:pack._id},{session}))?.manualCode || manualCode;
}
