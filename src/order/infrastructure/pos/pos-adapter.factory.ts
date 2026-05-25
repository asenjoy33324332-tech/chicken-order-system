import { Injectable } from '@nestjs/common';
import { PosAdapter } from './pos-adapter.interface';
import { LegacyV1PosAdapter } from './adapters/legacy-v1.adapter';
import { ModernV2PosAdapter } from './adapters/modern-v2.adapter';

@Injectable()
export class PosAdapterFactory {
  create(
    posType: string,
    endpoint: string,
    apiKey: string | null,
  ): PosAdapter {
    switch (posType) {
      case 'LEGACY_V1':
        return new LegacyV1PosAdapter(endpoint, apiKey);
      case 'MODERN_V2':
      case 'TABLET_V3':
        return new ModernV2PosAdapter(endpoint, apiKey);
      default:
        throw new Error(`알 수 없는 POS 타입: ${posType}`);
    }
  }
}
