import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ToolsService } from './tools.service';
import { BaseController } from '../../shared/base/base.controller';
import { Tool } from './entities/tool.entity';
import { CreateToolDto } from './dto/create-tool.dto';
import { UpdateToolDto } from './dto/update-tool.dto';
import { Authorize } from '../auth/authorize.decorator';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/enums/roles.enum';
import { CatalogQueryDto } from '../../shared/dto/catalog-query.dto';

@ApiTags('tools')
@Controller('tools')
export class ToolsController extends BaseController<
  Tool,
  CreateToolDto,
  UpdateToolDto
> {
  constructor(private readonly toolsService: ToolsService) {
    super(toolsService, 'Ferramenta');
  }

  @Get()
  @Authorize('can_manage_catalogs')
  findPaginated(@Query() query: CatalogQueryDto) {
    return this.toolsService.findPaginated(query);
  }

  /**
   * Override obrigatório: o @Body() genérico de `BaseController` emite
   * `design:paramtypes = [Object]` e o ValidationPipe global pula a validação
   * inteira. Ver `EpisController` para a explicação completa.
   */
  @Post()
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST)
  @Authorize('can_manage_catalogs')
  override create(@Body() createDto: CreateToolDto): Promise<Tool> {
    return this.toolsService.create(createDto);
  }

  @Patch(':id')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST)
  @Authorize('can_manage_catalogs')
  override update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() updateDto: UpdateToolDto,
  ): Promise<Tool> {
    return this.toolsService.update(id, updateDto);
  }
}
