import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response, Request } from 'express';

interface ExceptionResponseBody {
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isCastError =
      exception instanceof Error && exception.name === 'CastError';
    const isDuplicateKey =
      exception instanceof Error &&
      'code' in (exception as unknown as Record<string, unknown>) &&
      (exception as unknown as Record<string, unknown>).code === 11000;

    let status: number;
    let message: string | string[];
    let errorName: string;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      message =
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : ((exceptionResponse as Record<string, unknown>)?.message as
              | string
              | string[]) || 'حدث خطأ';
      errorName = exception.name;
    } else if (isCastError) {
      status = HttpStatus.BAD_REQUEST;
      message = 'معرّف غير صالح';
      errorName = 'BadRequestException';
    } else if (isDuplicateKey) {
      status = HttpStatus.CONFLICT;
      message = 'البيانات موجودة مسبقاً';
      errorName = 'ConflictException';
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
      errorName = 'InternalServerError';
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ExceptionResponseBody = {
      statusCode: status,
      message,
      error: errorName,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    response.status(status).json(body);
  }
}
