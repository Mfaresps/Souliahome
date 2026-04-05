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
    return this.userModel.find().select('-password').sort({ createdAt: 1 }).exec();
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
    if (data.password) {
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

  async countUsers(): Promise<number> {
    return this.userModel.countDocuments().exec();
  }
}
