import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection, ClientSession } from 'mongoose';
import { VaultBalance, VaultBalanceDocument } from './schemas/vault-balance.schema';

@Injectable()
export class VaultBalanceService {
  private readonly logger = new Logger(VaultBalanceService.name);

  constructor(
    @InjectModel(VaultBalance.name)
    private readonly vaultBalanceModel: Model<VaultBalanceDocument>,
    @InjectConnection()
    private readonly connection: Connection,
  ) {}

  async initializeSegments(): Promise<void> {
    const segments = ['cash', 'vodafone', 'instapay', 'bank'];
    
    for (const segment of segments) {
      const exists = await this.vaultBalanceModel.findOne({ segment }).exec();
      if (!exists) {
        await this.vaultBalanceModel.create({
          segment,
          balance: 0,
          version: 0,
          lastUpdated: new Date(),
          metadata: {
            totalDeposits: 0,
            totalWithdrawals: 0,
            transactionCount: 0,
          },
        });
        this.logger.log(`Initialized vault segment: ${segment}`);
      }
    }
  }

  async getSegmentBalance(segment: string): Promise<number> {
    const vaultSegment = await this.vaultBalanceModel
      .findOne({ segment })
      .exec();
    
    if (!vaultSegment) {
      // Auto-initialize if missing
      await this.initializeSegments();
      return 0;
    }
    
    return vaultSegment.balance || 0;
  }

  async getAllBalances(): Promise<{
    cash: number;
    vodafone: number;
    instapay: number;
    bank: number;
    total: number;
  }> {
    const segments = await this.vaultBalanceModel.find().exec();
    
    const balances = {
      cash: 0,
      vodafone: 0,
      instapay: 0,
      bank: 0,
      total: 0,
    };

    segments.forEach((seg) => {
      if (seg.segment === 'cash') balances.cash = seg.balance;
      else if (seg.segment === 'vodafone') balances.vodafone = seg.balance;
      else if (seg.segment === 'instapay') balances.instapay = seg.balance;
      else if (seg.segment === 'bank') balances.bank = seg.balance;
    });

    balances.total = balances.cash + balances.vodafone + balances.instapay + balances.bank;

    return balances;
  }

  async adjustBalance(
    segment: string,
    amount: number,
    transactionRef: string,
    updatedBy: string,
    session?: ClientSession,
  ): Promise<VaultBalanceDocument> {
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        // Get current balance with version for optimistic locking
        const currentSegment = await this.vaultBalanceModel
          .findOne({ segment })
          .session(session || null)
          .exec();

        if (!currentSegment) {
          throw new BadRequestException(`Vault segment '${segment}' not found`);
        }

        const currentVersion = currentSegment.version;
        const newBalance = currentSegment.balance + amount;

        // Prevent negative balance
        if (newBalance < 0) {
          const segLabel: Record<string, string> = {
            cash: 'كاش',
            vodafone: 'فودافون كاش',
            instapay: 'Instapay',
            bank: 'تحويل بنكي',
          };
          throw new BadRequestException(
            `رصيد ${segLabel[segment] || segment} غير كافٍ — الرصيد الحالي: ${currentSegment.balance} ج والمطلوب: ${Math.abs(amount)} ج`
          );
        }

        // Update metadata
        const metadata = currentSegment.metadata || {
          totalDeposits: 0,
          totalWithdrawals: 0,
          transactionCount: 0,
        };

        if (amount > 0) {
          metadata.totalDeposits = (metadata.totalDeposits || 0) + amount;
        } else {
          metadata.totalWithdrawals = (metadata.totalWithdrawals || 0) + Math.abs(amount);
        }
        metadata.transactionCount = (metadata.transactionCount || 0) + 1;

        // Atomic update with version check (optimistic locking)
        const updated = await this.vaultBalanceModel
          .findOneAndUpdate(
            {
              segment,
              version: currentVersion, // Only update if version matches
            },
            {
              $set: {
                balance: newBalance,
                version: currentVersion + 1,
                lastUpdated: new Date(),
                lastUpdatedBy: updatedBy,
                lastTransactionRef: transactionRef,
                metadata,
              },
            },
            {
              new: true,
              session: session || null,
            }
          )
          .exec();

        if (!updated) {
          // Version conflict - another transaction updated this segment
          attempt++;
          this.logger.warn(
            `Optimistic lock conflict on segment ${segment}, retry ${attempt}/${maxRetries}`
          );
          
          if (attempt >= maxRetries) {
            throw new BadRequestException(
              'فشل تحديث الخزنة بسبب تعارض - يرجى المحاولة مرة أخرى'
            );
          }
          
          // Wait a bit before retry
          await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
          continue;
        }

        this.logger.log(
          `Vault balance adjusted: ${segment} ${amount > 0 ? '+' : ''}${amount} → ${newBalance} (ref: ${transactionRef})`
        );

        return updated;
      } catch (error) {
        if (attempt >= maxRetries - 1) {
          throw error;
        }
        attempt++;
      }
    }

    throw new BadRequestException('فشل تحديث رصيد الخزنة');
  }

  async recalculateBalances(): Promise<{
    success: boolean;
    balances: any;
    message: string;
  }> {
    const session = await this.connection.startSession();
    session.startTransaction();

    try {
      // Get all vault entries with status 'completed'
      const vaultEntries = await this.connection
        .collection('vaultentries')
        .find({ status: 'completed' })
        .sort({ createdAt: 1 })
        .toArray();

      // Reset all balances to 0
      await this.vaultBalanceModel.updateMany(
        {},
        {
          $set: {
            balance: 0,
            version: 0,
            metadata: {
              totalDeposits: 0,
              totalWithdrawals: 0,
              transactionCount: 0,
            },
          },
        },
        { session }
      );

      // Recalculate from vault entries
      const balanceMap: Record<string, number> = {
        cash: 0,
        vodafone: 0,
        instapay: 0,
        bank: 0,
      };

      for (const entry of vaultEntries) {
        const seg = entry.seg || 'cash';
        balanceMap[seg] = (balanceMap[seg] || 0) + (entry.amount || 0);
      }

      // Update each segment
      for (const [segment, balance] of Object.entries(balanceMap)) {
        await this.vaultBalanceModel.findOneAndUpdate(
          { segment },
          {
            $set: {
              balance,
              lastUpdated: new Date(),
              lastUpdatedBy: 'system-recalculation',
            },
          },
          { session }
        );
      }

      await session.commitTransaction();

      const finalBalances = await this.getAllBalances();

      this.logger.log(`Vault balances recalculated successfully: ${JSON.stringify(finalBalances)}`);

      return {
        success: true,
        balances: finalBalances,
        message: '✓ تم إعادة حساب أرصدة الخزنة بنجاح من سجل المعاملات',
      };
    } catch (error) {
      await session.abortTransaction();
      this.logger.error('Failed to recalculate balances', error);
      throw new BadRequestException('فشل إعادة حساب الأرصدة');
    } finally {
      session.endSession();
    }
  }

  async getBalanceHistory(segment: string, days = 30): Promise<any[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const entries = await this.connection
      .collection('vaultentries')
      .find({
        seg: segment,
        status: 'completed',
        createdAt: { $gte: startDate },
      })
      .sort({ createdAt: 1 })
      .toArray();

    let runningBalance = 0;
    return entries.map((entry) => {
      runningBalance += entry.amount || 0;
      return {
        date: entry.date,
        amount: entry.amount,
        balance: runningBalance,
        ref: entry.ref,
        source: entry.source,
      };
    });
  }
}
