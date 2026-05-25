import {
  Controller, Post, Body, HttpCode, HttpStatus, Res,
} from '@nestjs/common';
import { Response } from 'express';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreateOrderService } from '../application/create-order.service';

@Controller('api/v1/orders')
export class OrderController {
  constructor(private readonly createOrder: CreateOrderService) {}

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
}
