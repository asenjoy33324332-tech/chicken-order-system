import {
  IsString, IsNotEmpty, IsArray, ValidateNested,
  IsInt, Min, IsNumberString, IsOptional, Length, Matches,
} from 'class-validator';
import { Type } from 'class-transformer';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OrderItemDto {
  @IsString()
  @Matches(UUID_RE, { message: 'menuId는 UUID 형식이어야 합니다.' })
  menuId: string;

  @IsInt({ message: 'quantity는 정수여야 합니다.' })
  @Min(1, { message: 'quantity는 1 이상이어야 합니다.' })
  quantity: number;
}

export class CreateOrderDto {
  /** 클라이언트가 생성하는 멱등성 키 (UUID 권장) */
  @IsString()
  @IsNotEmpty({ message: 'idempotencyKey는 필수입니다.' })
  @Length(1, 255)
  idempotencyKey: string;

  @IsString()
  @Matches(UUID_RE, { message: 'storeId는 UUID 형식이어야 합니다.' })
  storeId: string;

  @IsString()
  @Matches(UUID_RE, { message: 'userId는 UUID 형식이어야 합니다.' })
  @IsOptional()
  userId?: string;

  /** 클라이언트가 계산한 총액 (서버에서 교차 검증) */
  @IsNumberString({}, { message: 'totalAmount는 숫자 문자열이어야 합니다.' })
  totalAmount: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];
}
