import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { OrderEntity } from './order.entity';

@Entity('order_items')
export class OrderItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => OrderEntity, (o) => o.items)
  @JoinColumn({ name: 'order_id' })
  order: OrderEntity;

  @Column({ name: 'order_id' })
  orderId: string;

  @Column({ name: 'menu_id' })
  menuId: string;

  @Column({ name: 'menu_name', length: 255 })
  menuName: string;

  @Column({ name: 'unit_price', type: 'numeric', precision: 10, scale: 2 })
  unitPrice: string;

  @Column({ type: 'int' })
  quantity: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
