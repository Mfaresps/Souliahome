import { parseBostaSettlementPricing, r2 } from '../shared/bosta-pricing.util';
import { resolveCarrierForRead } from '../shared/carriers.constants';

export type AuditShippingCharge = {amount:number|null;source:string;readAt:string};
const amount=(value:unknown):number|null=>value===null||value===undefined||value===''||!Number.isFinite(Number(value))||Number(value)<0?null:r2(Number(value));
export function isAuditBosta(tx:any):boolean {
  return !!(tx.bostaOrderId||tx.bostaTrackingNumber||resolveCarrierForRead(tx)==='bosta'||tx.carrierSettlement?.carrier==='bosta');
}
/** A quoted customer tariff is never evidence of a carrier charge. Zero must be explicit. */
export function auditShippingCharge(tx:any,live?:any):AuditShippingCharge {
  if(isAuditBosta(tx)) {
    const wallet=amount(live?.wallet?.bostaFees),log=amount(live?.logFees?.priceAfterVat);
    if(wallet!==null)return{amount:wallet,source:'bosta-wallet',readAt:live.fetchedAt||''};
    const raw:any=tx.bostaRawResponse?.data||tx.bostaRawResponse,settled=tx.carrierSettlement;
    const saved=amount(settled?.carrier==='bosta'?settled.fees?.priceAfterVat:null),rawWallet=amount(raw?.wallet?.cashCycle?.bosta_fees);
    if(rawWallet!==null)return{amount:rawWallet,source:'bosta-wallet',readAt:tx.bostaLastSync||''};
    if(saved!==null&&settled.phase==='wallet')return{amount:saved,source:'bosta-wallet',readAt:settled.readAt||''};
    if(log!==null)return{amount:log,source:'bosta-pricing',readAt:live.fetchedAt||''};
    const parsed=parseBostaSettlementPricing(raw);
    if(parsed&&amount(parsed.priceAfterVat)!==null)return{amount:parsed.priceAfterVat,source:'bosta-pricing',readAt:tx.bostaLastSync||''};
    if(saved!==null)return{amount:saved,source:'bosta-pricing',readAt:settled.readAt||''};
    return{amount:null,source:'unconfirmed',readAt:''};
  }
  const recorded=amount(tx.actualShipCost);
  return recorded!==null&&recorded>0?{amount:recorded,source:'recorded-actual',readAt:''}:{amount:null,source:'unconfirmed',readAt:''};
}
