import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { CoreModule } from './core/core.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ProductsModule } from './products/products.module';
import { TransactionsModule } from './transactions/transactions.module';
import { SuppliersModule } from './suppliers/suppliers.module';
import { ExpensesModule } from './expenses/expenses.module';
import { SettingsModule } from './settings/settings.module';
import { VaultModule } from './vault/vault.module';
import { SearchModule } from './search/search.module';
import { ReturnsModule } from './returns/returns.module';
import { ComplaintsModule } from './complaints/complaints.module';
import { MentionsModule } from './mentions/mentions.module';
import { FollowUpsModule } from './followups/followups.module';
import { TagsModule } from './tags/tags.module';
import { SeedService } from './seed/seed.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRoot(
      process.env.MONGODB_URI || 'mongodb://localhost:27017/soulia',
    ),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    CoreModule,
    AuthModule,
    UsersModule,
    ProductsModule,
    TransactionsModule,
    SuppliersModule,
    ExpensesModule,
    SettingsModule,
    VaultModule,
    SearchModule,
    ReturnsModule,
    ComplaintsModule,
    MentionsModule,
    FollowUpsModule,
    TagsModule,
  ],
  providers: [SeedService],
})
export class AppModule implements OnModuleInit {
  constructor(private readonly seedService: SeedService) {}

  async onModuleInit(): Promise<void> {
    await this.seedService.seed();
  }
}
