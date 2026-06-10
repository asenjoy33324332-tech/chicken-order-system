const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function run() {
  await client.connect();
  const sql = fs.readFileSync(path.join(__dirname, '../database/migrations/007_menu_management.sql'), 'utf8');
  console.log('007_menu_management.sql 실행 중...');
  await client.query(sql);
  console.log('완료');

  const cols = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'menus' AND column_name IN ('category','sort_order','meta')
    ORDER BY column_name
  `);
  console.log('\nmenus 신규 컬럼:', cols.rows.map(x => x.column_name).join(', '));

  const tables = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('menu_categories','menu_options','pos_settings')
    ORDER BY table_name
  `);
  console.log('신규 테이블:', tables.rows.map(x => x.table_name).join(', '));

  await client.end();
}

run().catch(e => { console.error('에러:', e.message); client.end(); });
