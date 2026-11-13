import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HttpExceptionFilter } from '../../src/core/filters/http-exception.filter';

export {};
function run(ex: unknown) {
  let body: any;
  const res = { status: () => ({ json: (b: any) => { body = b; } }) };
  new HttpExceptionFilter().catch(ex, {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ url: '/x', method: 'PATCH' }) }),
  } as any);
  return body;
}

describe('HttpExceptionFilter — coded errors keep their details', () => {
  it('passes the divergence the confirm dialog needs', () => {
    const body = run(new BadRequestException({
      code: 'SHOPIFY_DIVERGENCE_ACK_REQUIRED', divergence: { erpTotal: 3582, shopifyTotal: 5132, diff: -1550 }, message: 'm',
    }));
    expect(body.code).toBe('SHOPIFY_DIVERGENCE_ACK_REQUIRED');
    expect(body.divergence).toEqual({ erpTotal: 3582, shopifyTotal: 5132, diff: -1550 });
    expect(body.message).toBe('m');
    expect(body.statusCode).toBe(400);
  });
  it('a coded error cannot overwrite the standard fields', () => {
    const body = run(new BadRequestException({ code: 'X', statusCode: 200, error: 'nope', message: 'm' }));
    expect(body.statusCode).toBe(400);
    expect(body.error).toBe('BadRequestException');
  });
  it('an uncoded error adds nothing', () => {
    const body = run(new NotFoundException('غير موجود'));
    expect(Object.keys(body).sort()).toEqual(['error', 'message', 'path', 'statusCode', 'timestamp']);
  });
});
