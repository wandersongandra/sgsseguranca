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
import { MachinesService } from './machines.service';
import { BaseController } from '../../shared/base/base.controller';
import { Machine } from './entities/machine.entity';
import { CreateMachineDto } from './dto/create-machine.dto';
import { UpdateMachineDto } from './dto/update-machine.dto';
import { Authorize } from '../auth/authorize.decorator';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/enums/roles.enum';
import { CatalogQueryDto } from '../../shared/dto/catalog-query.dto';

@ApiTags('machines')
@Controller('machines')
export class MachinesController extends BaseController<
  Machine,
  CreateMachineDto,
  UpdateMachineDto
> {
  constructor(private readonly machinesService: MachinesService) {
    super(machinesService, 'Máquina');
  }

  @Get()
  @Authorize('can_manage_catalogs')
  findPaginated(@Query() query: CatalogQueryDto) {
    return this.machinesService.findPaginated(query);
  }

  /**
   * Override obrigatório: o @Body() genérico de `BaseController` emite
   * `design:paramtypes = [Object]` e o ValidationPipe global pula a validação
   * inteira. Ver `EpisController` para a explicação completa.
   */
  @Post()
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST)
  @Authorize('can_manage_catalogs')
  override create(@Body() createDto: CreateMachineDto): Promise<Machine> {
    return this.machinesService.create(createDto);
  }

  @Patch(':id')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST)
  @Authorize('can_manage_catalogs')
  override update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() updateDto: UpdateMachineDto,
  ): Promise<Machine> {
    return this.machinesService.update(id, updateDto);
  }
}
