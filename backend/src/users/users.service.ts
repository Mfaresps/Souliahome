import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './schemas/user.schema';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {}

  async findAll(): Promise<UserDocument[]> {
    return this.userModel.find().select('-password').sort({ role: 1, createdAt: 1 }).exec();
  }

  async findMentionable(): Promise<{ _id: string; name: string; username: string; role: string; active: boolean }[]> {
    const docs = await this.userModel.find({ isActive: { $ne: false } }).select('_id name username role isActive').lean().exec();
    return docs.map(u => ({
      _id: String(u._id),
      name: u.name || '',
      username: u.username || '',
      role: u.role || 'staff',
      active: u.isActive !== false,
    }));
  }

  async findByUsername(username: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ username }).exec();
  }

  async findById(id: string): Promise<UserDocument | null> {
    return this.userModel.findById(id).exec();
  }

  async createUser(data: CreateUserDto | { username: string; password: string; name: string; role: string; phone?: string; perms?: string[] }): Promise<UserDocument> {
    const existing = await this.findByUsername(data.username);
    if (existing) {
      throw new ConflictException('اسم المستخدم موجود مسبقاً');
    }
    const hashed = await bcrypt.hash(data.password, 10);
    return this.userModel.create({ ...data, password: hashed });
  }

  async updateUser(id: string, data: UpdateUserDto): Promise<UserDocument> {
    const update: Record<string, unknown> = { ...data };
    // Don't allow changing username via update
    delete update.username;
    if (data.password && data.password.length >= 6) {
      update.password = await bcrypt.hash(data.password, 10);
    } else {
      delete update.password;
    }
    const user = await this.userModel
      .findByIdAndUpdate(id, update, { new: true })
      .select('-password')
      .exec();
    if (!user) {
      throw new NotFoundException('المستخدم غير موجود');
    }
    return user;
  }

  async removeUser(id: string): Promise<void> {
    const result = await this.userModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException('المستخدم غير موجود');
    }
  }

  async toggleActive(id: string, isActive: boolean): Promise<UserDocument> {
    const user = await this.userModel
      .findByIdAndUpdate(id, { isActive }, { new: true })
      .select('-password')
      .exec();
    if (!user) throw new NotFoundException('المستخدم غير موجود');
    return user;
  }

  async updateLastLogin(id: string): Promise<void> {
    await this.userModel.findByIdAndUpdate(id, { lastLogin: new Date() }).exec();
  }

  async updateLastSeen(id: string): Promise<void> {
    await this.userModel.findByIdAndUpdate(id, { lastSeen: new Date() }).exec();
  }

  async countUsers(): Promise<number> {
    return this.userModel.countDocuments().exec();
  }

  async deleteAllUsers(): Promise<void> {
    await this.userModel.deleteMany({}).exec();
  }
}
