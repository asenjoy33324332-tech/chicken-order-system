import { Injectable, LoggerService } from '@nestjs/common';
import pino from 'pino';
import { getTraceContext } from '../trace/trace.context';

const pinoLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: process.env.APP_MODE || 'app',
    instanceId: process.env.HOSTNAME || 'local',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

@Injectable()
export class AppLogger implements LoggerService {
  private ctx: Record<string, unknown> = {};

  setContext(context: Record<string, unknown>): void {
    this.ctx = context;
  }

  private base(): Record<string, unknown> {
    return { ...getTraceContext(), ...this.ctx };
  }

  log(data: string | Record<string, unknown>): void {
    pinoLogger.info({ ...this.base(), ...(typeof data === 'string' ? { message: data } : data) });
  }

  info(data: Record<string, unknown>): void {
    pinoLogger.info({ ...this.base(), ...data });
  }

  warn(data: Record<string, unknown>): void {
    pinoLogger.warn({ ...this.base(), ...data });
  }

  error(data: Record<string, unknown> | string, trace?: string): void {
    pinoLogger.error({
      ...this.base(),
      ...(typeof data === 'string' ? { message: data, trace } : data),
    });
  }

  debug(data: Record<string, unknown>): void {
    pinoLogger.debug({ ...this.base(), ...data });
  }

  verbose(message: string): void {
    pinoLogger.trace({ ...this.base(), message });
  }
}
