import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { SearchService } from './search.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { SearchResponse } from './dto/search.dto';
import { canSeeCost, canSeeSupplier } from '../shared/cost-visibility.util';

@UseGuards(JwtAuthGuard)
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  async search(
    @Query('q') query: string,
    @Req() req: { user?: { role?: string; perms?: string[] } },
  ): Promise<SearchResponse> {
    const canViewPurchases = req.user?.role === 'admin'
      || !!req.user?.perms?.includes('purchase-view');
    const canSearchSuppliers = req.user?.role === 'admin'
      || !!req.user?.perms?.includes('suppliers');
    return this.searchService.search(query || '', canViewPurchases, canSearchSuppliers, canSeeCost(req.user), canSeeSupplier(req.user));
  }
}
