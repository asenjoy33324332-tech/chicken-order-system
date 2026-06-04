import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AppLogger } from '../../../common/logger/logger.service';

@WebSocketGateway({
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
})
export class OrderGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server: Server;

  constructor(private readonly logger: AppLogger) {}

  handleConnection(client: Socket) {
    this.logger.info({ event: 'SOCKET_CONNECTED', socketId: client.id });
  }

  handleDisconnect(client: Socket) {
    this.logger.info({ event: 'SOCKET_DISCONNECTED', socketId: client.id });
  }

  // POS가 연결 후 매장 룸 입장 (join_store 또는 pos_hello 둘 다 지원)
  @SubscribeMessage('join_store')
  handleJoinStore(
    @MessageBody() data: { storeId: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.joinStoreRoom(client, data?.storeId);
  }

  // BBQ POS 앱 호환: pos_hello 이벤트로도 룸 입장
  @SubscribeMessage('pos_hello')
  handlePosHello(
    @MessageBody() data: { storeId: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.joinStoreRoom(client, data?.storeId);
  }

  private joinStoreRoom(client: Socket, storeId?: string) {
    if (!storeId) return;
    const room = `store:${storeId}`;
    client.join(room);
    client.emit('pos_ok', { storeId });
    this.logger.info({ event: 'POS_JOINED', storeId, socketId: client.id });
  }

  // 새 주문 → 해당 매장 POS에 emit
  emitNewOrder(storeId: string, order: Record<string, unknown>) {
    this.server.to(`store:${storeId}`).emit('new_order', order);
  }

  // 주문 상태 변경 → 해당 매장 POS + 손님앱에 emit
  emitOrderUpdated(storeId: string, order: Record<string, unknown>) {
    this.server.to(`store:${storeId}`).emit('order_updated', order);
  }

  // 주문 취소
  emitOrderCancelled(storeId: string, payload: { orderId: string; reason?: string }) {
    this.server.to(`store:${storeId}`).emit('order_cancelled', payload);
  }
}
