import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Model } from 'mongoose';
import { getModelToken } from '@nestjs/mongoose';
import { User } from './users/schemas/user.schema';

async function resetUsers() {
  const app = await NestFactory.create(AppModule);
  const userModel = app.get<Model<any>>(getModelToken(User.name));
  
  console.log('🗑️ Deleting all existing users...');
  const result = await userModel.deleteMany({});
  console.log(`✅ Deleted ${result.deletedCount} users`);
  
  console.log('⏳ Seeding new users automatically...');
  // البذر سيتم تطبيقه تلقائياً من onModuleInit
  
  await new Promise(resolve => setTimeout(resolve, 2000));
  console.log('✨ Users reset completed!');
  
  await app.close();
  process.exit(0);
}

resetUsers().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
