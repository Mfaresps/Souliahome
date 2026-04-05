import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SearchService } from './search.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { SearchResponse } from './dto/search.dto';

@UseGuards(JwtAuthGuard)
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  async search(@Query('q') query: string): Promise<SearchResponse> {
    return this.searchService.search(query || '');
  }
}
