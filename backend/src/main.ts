import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './core/filters/http-exception.filter';
import { NextFunction, Request, Response } from 'express';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    rawBody: true, // مطلوب للتحقق من Shopify webhook signature
  });

  // Strip trailing whitespace/newlines from URL (Shopify sometimes sends %0A)
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.url = req.url.replace(/(\r\n|\r|\n|%0D%0A|%0A|%0D)+$/gi, '');
    next();
  });

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Soulia-Vault-Refund',
      'X-Soulia-Vault-Collect',
    ],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`Soulia backend running on port ${port}`);
}

bootstrap();
