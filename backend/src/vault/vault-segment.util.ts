export type VaultBalanceSegment = 'cash' | 'vodafone' | 'instapay' | 'bank';

/**
 * Maps UI / transaction payment labels to the vault segment used in settings + ledger.
 * Handles spacing, Arabic ي/ى variants, and common aliases so خصم المرتجع يخصم من القسم الصحيح.
 */
export function resolveVaultSegmentFromPaymentMethod(
  raw: string | undefined | null,
): VaultBalanceSegment {
  const trimmed = String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!trimmed) {
    return 'cash';
  }
  const ascii = trimmed.toLowerCase();
  if (ascii === 'cash') {
    return 'cash';
  }
  if (ascii === 'vodafone') {
    return 'vodafone';
  }
  if (ascii === 'instapay') {
    return 'instapay';
  }
  if (ascii === 'bank') {
    return 'bank';
  }
  const ar = trimmed
    .replace(/\u0640/g, '')
    .replace(/[\u0622\u0623\u0625]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .trim();
  const arNorm = ar.replace(/\s+/g, ' ');
  if (arNorm === 'كاش') {
    return 'cash';
  }
  if (arNorm === 'فودافون كاش' || arNorm.startsWith('فودافون ')) {
    return 'vodafone';
  }
  if (arNorm === 'Instapay' || ar.toLowerCase() === 'instapay') {
    return 'instapay';
  }
  if (arNorm === 'تحويل بنكي' || arNorm === 'تحويل بنكى') {
    return 'bank';
  }
  if (arNorm.includes('تحويل') && arNorm.includes('بنك')) {
    return 'bank';
  }
  if (arNorm.includes('بنكي') || arNorm.includes('بنكى')) {
    return 'bank';
  }
  if (arNorm.includes('فودافون')) {
    return 'vodafone';
  }
  return 'cash';
}
