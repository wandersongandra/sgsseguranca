import { IsArray, IsEmail } from 'class-validator';

export class SendEmailDto {
  @IsArray()
  @IsEmail({}, { each: true })
  to: string[];
}
