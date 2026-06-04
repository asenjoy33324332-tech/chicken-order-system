import { IsIn, IsOptional, IsString } from 'class-validator';

export class UpdateOrderStatusDto {
  @IsIn(['ACCEPTED', 'COOKING', 'DONE', 'CANCELLED'])
  status: 'ACCEPTED' | 'COOKING' | 'DONE' | 'CANCELLED';

  @IsOptional()
  @IsString()
  reason?: string;
}
