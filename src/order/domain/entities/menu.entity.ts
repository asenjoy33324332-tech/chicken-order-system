import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { StoreEntity } from './store.entity';

@Entity('menus')
export class MenuEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => StoreEntity)
  @JoinColumn({ name: 'store_id' })
  store: StoreEntity;

  @Column({ name: 'store_id' })
  storeId: string;

  @Column({ length: 255 })
  name: string;

  @Column({ name: 'unit_price', type: 'numeric', precision: 10, scale: 2 })
  unitPrice: string;

  @Column({ name: 'is_available', default: true })
  isAvailable: boolean;

  @Column({ default: 0 })
  version: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
