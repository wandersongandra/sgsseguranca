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
import { EpisService } from './epis.service';
import { BaseController } from '../../shared/base/base.controller';
import { Epi } from './entities/epi.entity';
import { CreateEpiDto } from './dto/create-epi.dto';
import { UpdateEpiDto } from './dto/update-epi.dto';
import { CatalogQueryDto } from '../../shared/dto/catalog-query.dto';
import { Authorize } from '../auth/authorize.decorator';
import { Roles } from '../auth/roles.decorator';
import { Role } from '../auth/enums/roles.enum';

@ApiTags('epis')
@Controller('epis')
export class EpisController extends BaseController<
  Epi,
  CreateEpiDto,
  UpdateEpiDto
> {
  constructor(private readonly episService: EpisService) {
    super(episService, 'EPI');
  }

  @Get()
  @Authorize('can_manage_catalogs')
  findAll(@Query() query: CatalogQueryDto) {
    return this.episService.findPaginated(query);
  }

  /**
   * Os overrides abaixo NÃO são cosméticos.
   *
   * `BaseController.create/update` declaram o @Body() com um type parameter
   * genérico. O TypeScript apaga generics em `design:paramtypes` e emite
   * `Object`; o ValidationPipe do Nest pula a validação quando o metatype é
   * `Object` (`validation.pipe.js` › `toValidate`). Resultado: nas rotas
   * herdadas, `whitelist`/`forbidNonWhitelisted` e TODOS os decorators de
   * CreateEpiDto/UpdateEpiDto — inclusive o `sanitizePlainTextTransform`
   * anti-XSS — eram letra morta.
   *
   * Redeclarar o parâmetro com a classe concreta restaura a validação.
   */
  @Post()
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST)
  @Authorize('can_manage_catalogs')
  override create(@Body() createDto: CreateEpiDto): Promise<Epi> {
    return this.episService.create(EpisService.toEntityPayload(createDto));
  }

  @Patch(':id')
  @Roles(Role.ADMIN_GERAL, Role.ADMIN_EMPRESA, Role.TST)
  @Authorize('can_manage_catalogs')
  override update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() updateDto: UpdateEpiDto,
  ): Promise<Epi> {
    return this.episService.update(id, EpisService.toEntityPayload(updateDto));
  }
}
