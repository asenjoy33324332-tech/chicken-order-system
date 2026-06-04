import {
  Controller, Post, Body, Headers, UnauthorizedException, HttpCode, HttpStatus, Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreateOrderService } from '../application/create-order.service';

interface BridgeOrderDto {
  orderId: string;
  storeId: string;
  items: Array<{
    menuId: string;
    menuName: string;
    quantity: number;
    unitPrice: number;
    optionPrice?: number;
  }>;
  totalAmount: number;
  kcpTno?: string;
  paymentMethod?: string;
  orderType?: string;
  customerName?: string;
}

@Controller('internal')
export class InternalBridgeController {
  private readonly logger = new Logger(InternalBridgeController.name);
  private readonly bridgeApiKey: string;

  constructor(
    private readonly createOrder: CreateOrderService,
    private readonly config: ConfigService,
  ) {
    this.bridgeApiKey = config.get<string>('bbq.apiKey', '');
  }

  @Post('orders')
  @HttpCode(HttpStatus.ACCEPTED)
  async bridgeOrder(
    @Headers('x-api-key') apiKey: string,
    @Body() dto: BridgeOrderDto,
  ) {
    // 내부 API Key 검증 (설정된 경우에만)
    if (this.bridgeApiKey && apiKey !== this.bridgeApiKey) {
      throw new UnauthorizedException('Invalid bridge API key');
    }

    this.logger.log({ event: 'BRIDGE_ORDER_RECEIVED', orderId: dto.orderId, storeId: dto.storeId });

    const result = await this.createOrder.execute({
      idempotencyKey: dto.orderId,  // BBQ orderId를 멱등성 키로 사용
      storeId: dto.storeId,
      userId: null,
      requestedAmount: String(dto.totalAmount),
      items: dto.items.map(item => ({
        menuId: item.menuId,
        menuName: item.menuName,
        quantity: item.quantity,
        unitPrice: item.unitPrice + (item.optionPrice ?? 0),
      })),
    });

    return {
      ok: true,
      orderId: dto.orderId,
      nestOrderId: result.orderId,
      replayed: result.replayed,
    };
  }
}
