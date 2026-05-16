import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { SuppliersService } from './suppliers.service';
import { CreateSupplierDto, UpdateSupplierDto } from './dto/supplier.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { DiscountOtpService } from '../discount-otp/discount-otp.service';

@UseGuards(JwtAuthGuard)
@Controller('suppliers')
export class SuppliersController {
  constructor(
    private readonly suppliersService: SuppliersService,
    private readonly otpService: DiscountOtpService,
  ) {}

  @Get()
  async findAll() {
    return this.suppliersService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.suppliersService.findById(id);
  }

  @Post()
  async create(@Body() dto: CreateSupplierDto) {
    return this.suppliersService.create(dto);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliersService.update(id, dto);
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Body() body: { otpId?: string },
    @Req() req: any,
  ) {
    const user = req.user || {};
    const isAdmin = user.role === 'admin';

    if (!isAdmin) {
      // Non-admin users must provide a validated OTP
      if (!body?.otpId) {
        throw new ForbiddenException('يلزم كود تحقق لحذف المورد');
      }
      await this.otpService.assertDeleteSupplierOtp(body.otpId);
    }

    await this.suppliersService.remove(id);
    return { message: 'تم حذف المورد' };
  }
}
