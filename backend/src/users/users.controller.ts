import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UsersService } from './users.service';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { Transaction, TransactionDocument } from '../transactions/schemas/transaction.schema';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    @InjectModel(Transaction.name) private readonly txModel: Model<TransactionDocument>,
  ) {}

  @Get('me/stats')
  async getMyStats(@Req() req: { user: { userId?: string; sub?: string; username: string; name: string } }) {
    const empName = req.user?.name || req.user?.username || '';
    const [sales, purchases, returns] = await Promise.all([
      this.txModel.find({ employee: empName, type: 'مبيعات', cancelled: { $ne: true } }).select('total').lean(),
      this.txModel.find({ employee: empName, type: 'مشتريات', cancelled: { $ne: true } }).select('total').lean(),
      this.txModel.find({ employee: empName, type: { $in: ['مرتجع مبيعات', 'مرتجع مشتريات', 'مرتجع'] }, cancelled: { $ne: true } }).select('total').lean(),
    ]);
    return {
      salesCount: sales.length,
      salesTotal: sales.reduce((s, t) => s + (t.total || 0), 0),
      purchasesCount: purchases.length,
      purchasesTotal: purchases.reduce((s, t) => s + (t.total || 0), 0),
      returnsCount: returns.length,
      txCount: sales.length + purchases.length + returns.length,
    };
  }

  @Put('me')
  async updateSelf(
    @Req() req: { user: { userId?: string; sub?: string; username: string } },
    @Body() dto: UpdateUserDto,
  ) {
    const userId = (req.user?.userId || req.user?.sub) as string;
    if (!userId) throw new BadRequestException('تعذر تحديد هوية المستخدم');
    // Non-admins cannot change role or perms
    const safeDto: UpdateUserDto = { phone: dto.phone, avatar: dto.avatar, password: dto.password };
    return this.usersService.updateUser(userId, safeDto);
  }

  @Get('mentionable')
  async mentionable() {
    return this.usersService.findMentionable();
  }

  @Roles('admin')
  @Get()
  async findAll() {
    return this.usersService.findAll();
  }

  @Roles('admin')
  @Post()
  async create(@Body() dto: CreateUserDto) {
    const user = await this.usersService.createUser(dto);
    return this.usersService.findAll().then((users) =>
      users.find((u) => u._id.toString() === user._id.toString()),
    );
  }

  @Roles('admin')
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: { user: { username: string } },
  ) {
    const target = await this.usersService.findById(id);
    // Only the super admin can edit the super admin account
    if (target && target.username === 'admin' && req.user?.username !== 'admin') {
      throw new ForbiddenException('لا يمكن تعديل حساب السوبر أدمن');
    }
    // Prevent demoting the super admin
    if (target && target.username === 'admin' && dto.role && dto.role !== 'admin') {
      throw new ForbiddenException('لا يمكن تغيير دور السوبر أدمن');
    }
    return this.usersService.updateUser(id, dto);
  }

  @Roles('admin')
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Req() req: { user: { username: string } },
  ) {
    const user = await this.usersService.findById(id);
    if (user && user.username === 'admin') {
      throw new ForbiddenException('لا يمكن حذف المدير الرئيسي');
    }
    if (user && user.username === req.user?.username) {
      throw new ForbiddenException('لا يمكنك حذف حسابك الخاص');
    }
    await this.usersService.removeUser(id);
    return { message: 'تم حذف المستخدم' };
  }

  @Roles('admin')
  @Post(':id/activate')
  async activate(
    @Param('id') id: string,
    @Req() req: { user: { username: string } },
  ) {
    const user = await this.usersService.findById(id);
    if (!user) throw new BadRequestException('المستخدم غير موجود');
    if (user.username === 'admin') throw new ForbiddenException('لا يمكن تعديل المدير الرئيسي');
    return this.usersService.toggleActive(id, true);
  }

  @Roles('admin')
  @Post(':id/deactivate')
  async deactivate(
    @Param('id') id: string,
    @Req() req: { user: { username: string } },
  ) {
    const user = await this.usersService.findById(id);
    if (!user) throw new BadRequestException('المستخدم غير موجود');
    if (user.username === 'admin') throw new ForbiddenException('لا يمكن تعطيل المدير الرئيسي');
    if (user.username === req.user?.username) throw new ForbiddenException('لا يمكنك تعطيل حسابك الخاص');
    return this.usersService.toggleActive(id, false);
  }
}
