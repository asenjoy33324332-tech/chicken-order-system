import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { OrderStatus } from '../order-state-machine';
import { OrderItemEntity } from './order-item.entity';
import { OrderStateTransitionEntity } from './order-state-transition.entity';

@Entity('orders')
export class OrderEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'idempotency_key', length: 255, unique: true })
  idempotencyKey: string;

  @Column({ name: 'trace_id', length: 255 })
  traceId: string;

  @Column({ name: 'store_id' })
  storeId: string;

  @Column({ name: 'user_id', type: 'varchar', nullable: true })
  userId: string | null;

  @Column({ length: 20, default: 'QUEUED' })
  status: OrderStatus;

  @Column({ name: 'requested_amount', type: 'numeric', precision: 10, scale: 2 })
  requestedAmount: string;

  @Column({ name: 'calculated_amount', type: 'numeric', precision: 10, scale: 2 })
  calculatedAmount: string;

  @Column({ default: 0 })
  version: number;

  @Column({ name: 'pos_response', type: 'jsonb', nullable: true })
  posResponse: Record<string, unknown> | null;

  @Column({ name: 'pos_error_message', type: 'text', nullable: true })
  posErrorMessage: string | null;

  @Column({ name: 'retry_count', default: 0 })
  retryCount: number;

  @Column({ name: 'dlq_at', type: 'timestamptz', nullable: true })
  dlqAt: Date | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'queued_at', type: 'timestamptz', default: () => 'NOW()' })
  queuedAt: Date;

  @Column({ name: 'saved_at', type: 'timestamptz', nullable: true })
  savedAt: Date | null;

  @Column({ name: 'sent_to_pos_at', type: 'timestamptz', nullable: true })
  sentToPosAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ name: 'failed_at', type: 'timestamptz', nullable: true })
  failedAt: Date | null;

  @OneToMany(() => OrderItemEntity, (item) => item.order, { cascade: ['insert'] })
  items: OrderItemEntity[];

  @OneToMany(() => OrderStateTransitionEntity, (t) => t.order)
  transitions: OrderStateTransitionEntity[];
}
