import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration from './config/configuration';
import { OrderEntity } from './order/domain/entities/order.entity';
import { OrderItemEntity } from './order/domain/entities/order-item.entity';
import { OrderStateTransitionEntity } from './order/domain/entities/order-state-transition.entity';
import { StoreEntity } from './order/domain/entities/store.entity';
import { MenuEntity } from './order/domain/entities/menu.entity';

/** 공통 루트 모듈 — DB 연결 + Config만 설정 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host:     config.get<string>('database.host'),
        port:     config.get<number>('database.port'),
        username: config.get<string>('database.username'),
        password: config.get<string>('database.password'),
        database: config.get<string>('database.database'),
        entities: [
          OrderEntity,
          OrderItemEntity,
          OrderStateTransitionEntity,
          StoreEntity,
          MenuEntity,
        ],
        synchronize: false,    // 절대 true 금지 (운영 환경 스키마 파괴 위험)
        logging: process.env.NODE_ENV !== 'production',
        ssl: process.env.DATABASE_HOST?.includes('neon.tech') || process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false,
        extra: {
          max: parseInt(process.env.DB_POOL_MAX || '30', 10),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
          options: '-c statement_timeout=5000',
        },
      }),
    }),
  ],
})
export class AppModule {}

