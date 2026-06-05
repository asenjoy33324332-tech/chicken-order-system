const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  await client.connect();
  const sql = fs.readFileSync(path.join(__dirname, '../database/migrations/005_pos_status.sql'), 'utf8');
  console.log('005_pos_status.sql 실행 중...');
  await client.query(sql);
  console.log('완료');

  // 제약 확인
  const r = await client.query(`
    SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'orders' AND c.conname = 'chk_order_status'
  `);
  console.log('\n변경된 CHECK 제약:');
  console.log(r.rows[0]?.def);
  await client.end();
}

run().catch(e => { console.error('에러:', e.message); client.end(); });
