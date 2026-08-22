import { ArrayMaxSize, IsArray, IsEmail } from 'class-validator';

export class SendEmailDto {
  @IsArray()
  @ArrayMaxSize(20)
  @IsEmail({}, { each: true })
  to: string[];
}
