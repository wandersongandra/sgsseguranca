import { Global, Module } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { PuppeteerPoolService } from './puppeteer-pool.service';
import { PdfValidatorService } from './pdf-validator.service';
import { PasswordService } from './password.service';
import { PdfCompressionService } from './pdf-compression.service';
import { SignatureTimestampService } from './signature-timestamp.service';
import { TempCleanupService } from './temp-cleanup.service';

@Global() // Torna os serviços disponíveis globalmente sem precisar importar o módulo
@Module({
  providers: [
    PdfService,
    PuppeteerPoolService,
    PdfValidatorService,
    PasswordService,
    PdfCompressionService,
    SignatureTimestampService,
    TempCleanupService,
  ],
  exports: [
    PdfService,
    PuppeteerPoolService,
    PdfValidatorService,
    PasswordService,
    PdfCompressionService,
    SignatureTimestampService,
    TempCleanupService,
  ],
})
export class CommonServicesModule {}
