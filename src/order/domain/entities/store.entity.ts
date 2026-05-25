import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('stores')
export class StoreEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255 })
  name: string;

  @Column({ name: 'pos_type', length: 50 })
  posType: string;

  @Column({ name: 'pos_endpoint', length: 500 })
  posEndpoint: string;

  @Column({ name: 'pos_api_key_enc', type: 'varchar', length: 500, nullable: true })
  posApiKeyEnc: string | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
