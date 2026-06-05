const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  await client.connect();
  const sql = fs.readFileSync(path.join(__dirname, '../database/migrations/004_areas.sql'), 'utf8');
  console.log('004_areas.sql 실행 중...');
  await client.query(sql);
  console.log('완료');

  const r = await client.query('SELECT name, store_id FROM areas ORDER BY store_id, sort_order');
  console.log('\n지역 목록:');
  r.rows.forEach(row => console.log(` - ${row.name} → ${row.store_id.slice(0,8)}...`));

  await client.end();
}

run().catch(e => { console.error('에러:', e.message); client.end(); });
