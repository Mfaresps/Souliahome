/**
 * Inventory Balance Calculator
 * Real-time balance calculation module for treasury/inventory system
 *
 * Formula: Current Balance = Opening Balance + Purchases + Returns - Sales
 */

export interface BalanceInput {
  openingBalance: number;    // الرصيد الافتتاحي
  purchases: number;         // المشتريات (من المورد)
  returnsToStock: number;    // إرجاع للمخزن (الكميات المعادة)
  sales: number;             // المبيعات (الكميات المباعة)
  minStock?: number;         // الحد الأدنى للمخزون
}

export interface BalanceOutput {
  currentBalance: number;    // الرصيد الحالي
  status: 'متوفر' | 'منخفض' | 'نفد';  // الحالة
  statusAr: string;          // وصف الحالة بالعربية
  isAvailable: boolean;      // هل الصنف متوفر
  stockPercentage: number;   // نسبة المخزون من الحد الأدنى
  movements: {               // تفاصيل الحركات
    inbound: number;         // الإدخالات (مشتريات + إرجاعات)
    outbound: number;        // الإخراجات (مبيعات)
    net: number;             // صافي الحركة
  };
}

/**
 * Calculate current inventory balance
 * @param input - Balance calculation inputs
 * @returns BalanceOutput with status and descriptive data
 */
export function calculateInventoryBalance(input: BalanceInput): BalanceOutput {
  const {
    openingBalance,
    purchases,
    returnsToStock,
    sales,
    minStock = 10,
  } = input;

  // Validate inputs
  const validatedInput = {
    opening: Math.max(0, Math.floor(openingBalance)),
    purchases: Math.max(0, Math.floor(purchases)),
    returns: Math.max(0, Math.floor(returnsToStock)),
    sales: Math.max(0, Math.floor(sales)),
  };

  // Calculate movements
  const inbound = validatedInput.purchases + validatedInput.returns;
  const outbound = validatedInput.sales;
  const netMovement = inbound - outbound;

  // Calculate current balance
  const currentBalance = validatedInput.opening + inbound - outbound;

  // Determine status
  let status: 'متوفر' | 'منخفض' | 'نفد';
  let statusAr: string;

  if (currentBalance <= 0) {
    status = 'نفد';
    statusAr = 'الصنف انتهى من المخزن';
  } else if (currentBalance <= minStock) {
    status = 'منخفض';
    statusAr = `المخزون منخفض (أقل من أو يساوي ${minStock})`;
  } else {
    status = 'متوفر';
    statusAr = 'الصنف متوفر في المخزن';
  }

  // Calculate stock percentage
  const stockPercentage = minStock > 0 ? (currentBalance / minStock) * 100 : 100;

  return {
    currentBalance,
    status,
    statusAr,
    isAvailable: currentBalance > minStock,
    stockPercentage: Math.round(stockPercentage * 100) / 100,
    movements: {
      inbound,
      outbound,
      net: netMovement,
    },
  };
}

/**
 * Calculate impact of a transaction on inventory balance
 * @param currentBalance - Current inventory balance
 * @param transactionType - Type of transaction
 * @param quantity - Transaction quantity
 * @returns New balance after transaction
 */
export function calculateBalanceAfterTransaction(
  currentBalance: number,
  transactionType: 'sale' | 'purchase' | 'return',
  quantity: number,
): number {
  const validQty = Math.max(0, Math.floor(quantity));

  switch (transactionType) {
    case 'sale':
      return currentBalance - validQty;  // Sales reduce inventory
    case 'purchase':
      return currentBalance + validQty;  // Purchases increase inventory
    case 'return':
      return currentBalance + validQty;  // Returns increase inventory
    default:
      return currentBalance;
  }
}

/**
 * Format balance status for dashboard display
 */
export function formatBalanceStatus(output: BalanceOutput): string {
  return `${output.status} | الرصيد: ${output.currentBalance} | ${output.statusAr}`;
}

/**
 * Check if sufficient stock exists for transaction
 */
export function checkSufficientStock(
  currentBalance: number,
  requiredQuantity: number,
): { sufficient: boolean; shortage?: number } {
  const validQty = Math.max(0, Math.floor(requiredQuantity));

  if (currentBalance >= validQty) {
    return { sufficient: true };
  }

  return {
    sufficient: false,
    shortage: validQty - currentBalance,
  };
}
