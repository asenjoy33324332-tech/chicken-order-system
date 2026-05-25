import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { OrderEntity } from './order.entity';

@Entity('order_state_transitions')
export class OrderStateTransitionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => OrderEntity, (o) => o.transitions)
  @JoinColumn({ name: 'order_id' })
  order: OrderEntity;

  @Column({ name: 'order_id' })
  orderId: string;

  @Column({ name: 'from_status', type: 'varchar', length: 20, nullable: true })
  fromStatus: string | null;

  @Column({ name: 'to_status', type: 'varchar', length: 20 })
  toStatus: string;

  @Column({ name: 'worker_id', type: 'varchar', length: 255, nullable: true })
  workerId: string | null;

  @Column({ name: 'job_id', type: 'varchar', length: 255, nullable: true })
  jobId: string | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @CreateDateColumn({ name: 'transitioned_at' })
  transitionedAt: Date;
}
