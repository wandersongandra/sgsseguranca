import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

const MFA_CODE_MIN_LENGTH = 6;
const MFA_CODE_MAX_LENGTH = 64;

export class VerifyLoginMfaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  challengeToken: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(MFA_CODE_MIN_LENGTH)
  @MaxLength(MFA_CODE_MAX_LENGTH)
  code: string;
}

export class ActivateBootstrapMfaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  challengeToken: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(MFA_CODE_MIN_LENGTH)
  @MaxLength(MFA_CODE_MAX_LENGTH)
  code: string;
}

export class ActivateMfaEnrollmentDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(MFA_CODE_MIN_LENGTH)
  @MaxLength(MFA_CODE_MAX_LENGTH)
  code: string;
}

export class DisableMfaDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(MFA_CODE_MIN_LENGTH)
  @MaxLength(MFA_CODE_MAX_LENGTH)
  code: string;
}

export class VerifyStepUpDto {
  @IsString()
  @Length(3, 120)
  reason: string;

  @IsOptional()
  @IsString()
  @MinLength(MFA_CODE_MIN_LENGTH)
  @MaxLength(MFA_CODE_MAX_LENGTH)
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password?: string;
}

export class MfaStatusResponseDto {
  enabled: boolean;
  required: boolean;
  privilegedRole: string;
  recoveryCodesRemaining: number;
}

export class MfaChallengeResponseDto {
  mfaRequired: true;
  challengeToken: string;
  expiresIn: number;
  methods: string[];
}

export class MfaBootstrapResponseDto {
  mfaEnrollRequired: true;
  challengeToken: string;
  expiresIn: number;
  otpAuthUrl: string;
  manualEntryKey: string;
  recoveryCodes: string[];
}

export class CompleteMfaSessionDto {
  accessToken: string;
  user: unknown;
  roles: string[];
  permissions: string[];
}
