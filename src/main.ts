import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { TraceInterceptor } from './common/interceptors/trace.interceptor';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { AppLogger } from './common/logger/logger.service';

async function bootstrap(): Promise<void> {
  const mode = process.env.APP_MODE || 'all';

  let RootModule: unknown;
  if (mode === 'api') {
    const { AppApiModule } = await import('./app-api.module');
    RootModule = AppApiModule;
  } else if (mode === 'worker') {
    const { AppWorkerModule } = await import('./app-worker.module');
    RootModule = AppWorkerModule;
  } else {
    const { AppAllModule } = await import('./app-all.module');
    RootModule = AppAllModule;
  }

  const app = await NestFactory.create(RootModule as Parameters<typeof NestFactory.create>[0], {
    bufferLogs: true,
  });

  const logger = app.get(AppLogger);
  app.useLogger(logger);
  app.useGlobalInterceptors(new TraceInterceptor());
  app.useGlobalFilters(new GlobalExceptionFilter(logger));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableShutdownHooks();

  const port = parseInt(process.env.PORT || '3000', 10);

  if (mode === 'worker') {
    await app.init();
    logger.info({ event: 'WORKER_STARTED', mode, pid: process.pid });
  } else {
    await app.listen(port);
    logger.info({ event: 'SERVER_STARTED', mode, port, pid: process.pid });
  }

  // Graceful shutdown (k8s/ECS SIGTERM)
  process.on('SIGTERM', async () => {
    logger.info({ event: 'GRACEFUL_SHUTDOWN_START' });
    await app.close();
    logger.info({ event: 'GRACEFUL_SHUTDOWN_COMPLETE' });
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  console.error('애플리케이션 시작 실패:', err);
  process.exit(1);
});
