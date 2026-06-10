import {
  Controller, Post, Body, Query, BadRequestException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toUuid(id: unknown): string {
  const s = String(id ?? '');
  return UUID_RE.test(s) ? s : uuidv4();
}

@Controller()
export class MenuAdminController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** POST /menu-data/save?storeId=xxx — POS 메뉴 전체 교체 */
  @Post('menu-data/save')
  async saveMenus(
    @Query('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!storeId) throw new BadRequestException('storeId required');
    const items = (body['items'] as Array<Record<string, unknown>>) ?? [];

    await this.ds.transaction(async (em) => {
      await em.query(`DELETE FROM menus WHERE store_id = $1`, [storeId]);
      for (const item of items) {
        const posId   = String(item['id'] ?? '');
        const id      = toUuid(posId);
        const name    = String(item['name'] ?? '');
        const price   = Number(item['priceForOrder'] ?? item['price'] ?? 0);
        const avail   = item['visible'] !== false && !item['soldOut'];
        const cat     = String(item['category'] ?? '');
        const sort    = Number(item['sort'] ?? 0);
        const meta    = { ...item, posId: posId || id };

        await em.query(
          `INSERT INTO menus(id, store_id, name, unit_price, is_available, category, sort_order, meta, version)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)`,
          [id, storeId, name, price, avail, cat, sort, JSON.stringify(meta)],
        );
      }
    });

    return { ok: true };
  }

  /** POST /categories/save?storeId=xxx — POS 카테고리 전체 교체 */
  @Post('categories/save')
  async saveCategories(
    @Query('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!storeId) throw new BadRequestException('storeId required');
    const items = (body['items'] as Array<Record<string, unknown>>) ?? [];

    await this.ds.transaction(async (em) => {
      await em.query(`DELETE FROM menu_categories WHERE store_id = $1`, [storeId]);
      for (const item of items) {
        const id   = String(item['id'] ?? '');
        if (!id) continue;
        const name = String(item['name'] ?? '');
        const sort = Number(item['sort'] ?? 0);

        await em.query(
          `INSERT INTO menu_categories(id, store_id, name, sort_order, meta)
           VALUES($1,$2,$3,$4,$5)`,
          [id, storeId, name, sort, JSON.stringify(item)],
        );
      }
    });

    return { ok: true };
  }

  /** POST /options/save?storeId=xxx — POS 옵션 그룹 전체 교체 */
  @Post('options/save')
  async saveOptions(
    @Query('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!storeId) throw new BadRequestException('storeId required');
    const items = (body['items'] as Array<Record<string, unknown>>) ?? [];

    await this.ds.transaction(async (em) => {
      await em.query(`DELETE FROM menu_options WHERE store_id = $1`, [storeId]);
      for (const item of items) {
        const id       = String(item['id'] ?? '');
        if (!id) continue;
        const name     = String(item['name'] ?? '');
        const sort     = Number(item['sort'] ?? 0);
        const subItems = item['items'] ?? [];

        await em.query(
          `INSERT INTO menu_options(id, store_id, name, sort_order, items)
           VALUES($1,$2,$3,$4,$5)`,
          [id, storeId, name, sort, JSON.stringify(subItems)],
        );
      }
    });

    return { ok: true };
  }

  /** POST /settings/save?storeId=xxx — POS 가게 설정 저장 */
  @Post('settings/save')
  async saveSettings(
    @Query('storeId') storeId: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!storeId) throw new BadRequestException('storeId required');

    await this.ds.query(
      `INSERT INTO pos_settings(store_id, settings, updated_at)
       VALUES($1,$2,NOW())
       ON CONFLICT (store_id) DO UPDATE
         SET settings = $2, updated_at = NOW()`,
      [storeId, JSON.stringify(body)],
    );

    return { ok: true };
  }
}
