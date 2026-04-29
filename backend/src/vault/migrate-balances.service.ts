import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { VaultBalanceService } from './vault-balance.service';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class MigrateBalancesService {
  private readonly logger = new Logger(MigrateBalancesService.name);

  constructor(
    private readonly vaultBalanceService: VaultBalanceService,
    private readonly settingsService: SettingsService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async migrateFromSettings(): Promise<{
    success: boolean;
    message: string;
    oldBalances: any;
    newBalances: any;
  }> {
    try {
      this.logger.log('Starting migration: Settings → VaultBalance collection');

      // Step 1: Get current balances from settings
      const settings = await this.settingsService.getSettings();
      const oldBalances = {
        cash: settings.vaultCash || 0,
        vodafone: settings.vaultVodafone || 0,
        instapay: settings.vaultInstapay || 0,
        bank: settings.vaultBank || 0,
      };

      this.logger.log(`Old balances from settings: ${JSON.stringify(oldBalances)}`);

      // Step 2: Initialize vault balance segments
      await this.vaultBalanceService.initializeSegments();

      // Step 3: Recalculate balances from vault entries (source of truth)
      const recalculationResult = await this.vaultBalanceService.recalculateBalances();

      // Step 4: Get new balances
      const newBalances = await this.vaultBalanceService.getAllBalances();

      this.logger.log(`New balances from VaultBalance collection: ${JSON.stringify(newBalances)}`);

      // Step 5: Compare and log discrepancies
      const discrepancies: any[] = [];
      Object.keys(oldBalances).forEach((segment) => {
        const oldValue = oldBalances[segment as keyof typeof oldBalances];
        const newValue = newBalances[segment as keyof typeof newBalances];
        if (Math.abs(oldValue - newValue) > 0.01) {
          discrepancies.push({
            segment,
            oldValue,
            newValue,
            difference: newValue - oldValue,
          });
        }
      });

      if (discrepancies.length > 0) {
        this.logger.warn('⚠️ Discrepancies found during migration:');
        discrepancies.forEach((d) => {
          this.logger.warn(
            `  ${d.segment}: ${d.oldValue} → ${d.newValue} (diff: ${d.difference > 0 ? '+' : ''}${d.difference})`
          );
        });
      }

      return {
        success: true,
        message: '✓ تم نقل الأرصدة بنجاح من Settings إلى VaultBalance collection',
        oldBalances,
        newBalances,
      };
    } catch (error) {
      this.logger.error('Migration failed', error);
      return {
        success: false,
        message: `❌ فشل النقل: ${error instanceof Error ? error.message : 'خطأ غير معروف'}`,
        oldBalances: null,
        newBalances: null,
      };
    }
  }

  async verifyIntegrity(): Promise<{
    success: boolean;
    message: string;
    details: any;
  }> {
    try {
      // Get balances from VaultBalance collection
      const balances = await this.vaultBalanceService.getAllBalances();

      // Recalculate from vault entries
      const vaultEntries = await this.connection
        .collection('vaultentries')
        .find({ status: 'completed' })
        .toArray();

      const calculatedBalances: Record<string, number> = {
        cash: 0,
        vodafone: 0,
        instapay: 0,
        bank: 0,
      };

      vaultEntries.forEach((entry) => {
        const seg = entry.seg || 'cash';
        calculatedBalances[seg] = (calculatedBalances[seg] || 0) + (entry.amount || 0);
      });

      const calculatedTotal =
        calculatedBalances.cash +
        calculatedBalances.vodafone +
        calculatedBalances.instapay +
        calculatedBalances.bank;

      // Compare
      const discrepancies: any[] = [];
      Object.keys(calculatedBalances).forEach((segment) => {
        const stored = balances[segment as keyof typeof balances];
        const calculated = calculatedBalances[segment];
        if (Math.abs(stored - calculated) > 0.01) {
          discrepancies.push({
            segment,
            stored,
            calculated,
            difference: calculated - stored,
          });
        }
      });

      if (discrepancies.length > 0) {
        return {
          success: false,
          message: '⚠️ تم العثور على اختلافات بين الأرصدة المحفوظة والمحسوبة',
          details: {
            balances,
            calculatedBalances,
            calculatedTotal,
            discrepancies,
          },
        };
      }

      return {
        success: true,
        message: '✓ الأرصدة صحيحة ومتطابقة مع سجل المعاملات',
        details: {
          balances,
          calculatedBalances,
          calculatedTotal,
          totalEntries: vaultEntries.length,
        },
      };
    } catch (error) {
      this.logger.error('Integrity verification failed', error);
      return {
        success: false,
        message: `❌ فشل التحقق: ${error instanceof Error ? error.message : 'خطأ غير معروف'}`,
        details: null,
      };
    }
  }
}
