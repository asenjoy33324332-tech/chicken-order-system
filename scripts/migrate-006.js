const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  await client.connect();
  const sql = fs.readFileSync(path.join(__dirname, '../database/migrations/006_add_updated_at.sql'), 'utf8');
  console.log('006_add_updated_at.sql 실행 중...');
  await client.query(sql);
  console.log('완료');

  const r = await client.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'updated_at'
  `);
  console.log('\nupdated_at 컬럼 확인:');
  console.log(r.rows[0] ?? '컬럼 없음 (오류)');
  await client.end();
}

run().catch(e => { console.error('에러:', e.message); client.end(); });
