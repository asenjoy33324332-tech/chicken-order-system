import {
  Controller, Post, Patch, Body, Param, HttpCode, HttpStatus, Res, NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Response } from 'express';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { CreateOrderService } from '../application/create-order.service';
import { OrderGateway } from '../infrastructure/socket/order.gateway';

@Controller('api/v1/orders')
export class OrderController {
  constructor(
    private readonly createOrder: CreateOrderService,
    private readonly gateway: OrderGateway,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @Body() dto: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.createOrder.execute({
      idempotencyKey: dto.idempotencyKey,
      storeId: dto.storeId,
      userId: dto.userId ?? null,
      requestedAmount: dto.totalAmount,
      items: dto.items,
    });

    if (result.replayed) {
      res.setHeader('X-Idempotency-Replay', 'true');
    }

    const { replayed: _replayed, ...body } = result;
    return body;
  }

  // POS가 주문 상태 변경 시 호출 (ACCEPTED / COOKING / DONE / CANCELLED)
  @Patch(':orderId/status')
  @HttpCode(HttpStatus.OK)
  async updateStatus(
    @Param('orderId') orderId: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    const rows = await this.ds.query<Array<{ store_id: string; status: string }>>(
      `UPDATE orders
          SET status     = $1,
              updated_at = NOW()
        WHERE id = $2
        RETURNING store_id, status`,
      [dto.status, orderId],
    );

    if (!rows.length) throw new NotFoundException(`주문 없음: ${orderId}`);

    const { store_id: storeId, status } = rows[0];
    this.gateway.emitOrderUpdated(storeId, { id: orderId, status, updatedAt: new Date().toISOString() });

    return { ok: true, orderId, status };
  }
}
