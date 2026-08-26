import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import type { JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { MailModule } from '../../infra/mail/mail.module';
import { PdfSecurityController } from './controllers/pdf-security.controller';
import { SessionsController } from './controllers/sessions.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { PdfRateLimitService } from './services/pdf-rate-limit.service';
import { SessionsService } from './services/sessions.service';
import { BruteForceService } from './brute-force.service';
import { ForensicTrailModule } from '../forensic-trail/forensic-trail.module';
import { TokenRevocationService } from './token-revocation.service';
import { TurnstileService } from './turnstile.service';
import { UserSession } from './entities/user-session.entity';
import { AuthPrincipalService } from './auth-principal.service';
import { UserMfaCredential } from './entities/user-mfa-credential.entity';
import { UserMfaRecoveryCode } from './entities/user-mfa-recovery-code.entity';
import { MfaService } from './services/mfa.service';
import { LoginAnomalyService } from './services/login-anomaly.service';
import { PwnedPasswordService } from './services/pwned-password.service';
import { FileInspectionModule } from '../../shared/security/file-inspection.module';
import {
  getAccessTokenSecret,
  getAccessTokenTtl,
  getJwtSignOptions,
  isInfiniteTtl,
} from './auth-security.config';
import type { SignOptions } from 'jsonwebtoken';

@Module({
  imports: [
    forwardRef(() => UsersModule),
    FileInspectionModule,
    forwardRef(() => MailModule),
    PassportModule,
    // Permite que bloqueios de força bruta sejam gravados na trilha forense,
    // que é persistente e encadeada — antes o único registro era log volátil.
    ForensicTrailModule,
    TypeOrmModule.forFeature([
      UserSession,
      UserMfaCredential,
      UserMfaRecoveryCode,
    ]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const jwtSecret = getAccessTokenSecret(configService);
        const configuredAccessTokenTtl =
          configService.get<string>('ACCESS_TOKEN_TTL')?.trim() ||
          configService.get<string>('JWT_EXPIRES_IN')?.trim();
        const accessTokenTtl = (configuredAccessTokenTtl?.trim() ||
          getAccessTokenTtl()) as NonNullable<SignOptions['expiresIn']>;
        const jwtSignOptions = getJwtSignOptions(configService);
        const signOptions: JwtSignOptions | undefined = isInfiniteTtl(
          accessTokenTtl,
        )
          ? jwtSignOptions
          : { expiresIn: accessTokenTtl, ...jwtSignOptions };
        return signOptions
          ? { secret: jwtSecret, signOptions }
          : { secret: jwtSecret };
      },
      inject: [ConfigService],
    }),
  ],
  providers: [
    AuthService,
    AuthPrincipalService,
    JwtStrategy,
    PdfRateLimitService,
    SessionsService,
    BruteForceService,
    TokenRevocationService,
    TurnstileService,
    MfaService,
    LoginAnomalyService,
    PwnedPasswordService,
  ],
  controllers: [AuthController, PdfSecurityController, SessionsController],
  exports: [
    AuthService,
    AuthPrincipalService,
    JwtModule,
    PdfRateLimitService,
    TokenRevocationService,
    MfaService,
    TurnstileService,
  ],
})
export class AuthModule {}
