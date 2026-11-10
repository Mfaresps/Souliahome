export const COMPLAINT_ITEM_ISSUES = {
  wrong_color: 'لون مختلف',
  wrong_size: 'مقاس غير صحيح',
  wrong_item: 'منتج مختلف',
  missing: 'المنتج لم يصل',
  damaged: 'منتج تالف أو مكسور',
  quality: 'مشكلة في الجودة',
  other: 'مشكلة أخرى',
} as const;

export const COMPLAINT_ITEM_ISSUE_TYPES = Object.keys(COMPLAINT_ITEM_ISSUES);

export function describeComplaintItems(items: any[], additionalDescription = '') {
  const lines = items.map(item => `${item.name || item.code} × ${item.qty}: ${COMPLAINT_ITEM_ISSUES[item.issueType as keyof typeof COMPLAINT_ITEM_ISSUES]} — ${item.issueDescription}`);
  if (additionalDescription.trim()) lines.push(additionalDescription.trim());
  return lines.join('\n');
}
