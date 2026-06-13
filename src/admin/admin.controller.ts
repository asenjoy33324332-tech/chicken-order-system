import {
  Controller, Post, Get, Put, Delete, Param, Query, Body,
  HttpCode, HttpStatus, Header,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AdminService } from './admin.service';
import { v4 as uuidv4 } from 'uuid';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin1234';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  private checkAdminPassword(password: string): boolean {
    return password === ADMIN_PASSWORD;
  }

  /** DLQ 목록 조회 */
  @Get('orders/dlq')
  getDlqOrders(
    @Query('storeId') storeId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.admin.getDlqOrders({
      storeId,
      from,
      to,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  /** 단일 주문 수동 재처리 */
  @Post('orders/:orderId/redrive')
  @HttpCode(HttpStatus.OK)
  redriveOrder(@Param('orderId') orderId: string) {
    return this.admin.redriveOrder(orderId);
  }

  /** 시스템 상태 (큐 깊이, 서킷 브레이커) */
  @Get('system/status')
  getStatus(@Query('storeIds') storeIds?: string) {
    const ids = storeIds ? storeIds.split(',') : [];
    return this.admin.getSystemStatus(ids);
  }

  /** 헬스 체크 */
  @Get('health')
  health() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /** 구역 관리 HTML 페이지 */
  @Get('areas')
  @Header('Content-Type', 'text/html; charset=utf-8')
  getAreasPage() {
    return this.buildAreasHtml();
  }

  /** 구역 + 매장 데이터 JSON */
  @Get('areas/data')
  async getAreasData(@Query('password') password?: string) {
    if (!this.checkAdminPassword(password ?? '')) {
      return { ok: false, message: '비밀번호가 틀렸습니다.' };
    }
    const areas = await this.ds.query<Array<{
      id: string; name: string; store_id: string; store_name: string;
      is_active: boolean; sort_order: number;
    }>>(
      `SELECT a.id, a.name, a.store_id, s.name as store_name, a.is_active, a.sort_order
         FROM areas a
         JOIN stores s ON s.id = a.store_id
        ORDER BY a.sort_order, a.name`,
    );
    const stores = await this.ds.query<Array<{ id: string; name: string }>>(
      `SELECT id, name FROM stores WHERE is_active = TRUE ORDER BY name`,
    );
    return { ok: true, areas, stores };
  }

  /** 구역 추가 */
  @Post('areas')
  async createArea(@Body() body: Record<string, unknown>) {
    if (!this.checkAdminPassword(String(body['password'] ?? ''))) {
      return { ok: false, message: '비밀번호가 틀렸습니다.' };
    }
    const name = String(body['name'] ?? '').trim();
    const storeId = String(body['storeId'] ?? '').trim();
    const sortOrder = Number(body['sortOrder'] ?? 0);
    if (!name || !storeId) return { ok: false, message: 'name, storeId는 필수입니다.' };
    const id = uuidv4();
    await this.ds.query(
      `INSERT INTO areas (id, name, store_id, is_active, sort_order)
       VALUES ($1, $2, $3, TRUE, $4)`,
      [id, name, storeId, sortOrder],
    );
    return { ok: true, id };
  }

  /** 구역 수정 */
  @Put('areas/:id')
  async updateArea(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!this.checkAdminPassword(String(body['password'] ?? ''))) {
      return { ok: false, message: '비밀번호가 틀렸습니다.' };
    }
    const name = String(body['name'] ?? '').trim();
    const storeId = String(body['storeId'] ?? '').trim();
    const sortOrder = Number(body['sortOrder'] ?? 0);
    const isActive = body['isActive'] !== false;
    if (!name || !storeId) return { ok: false, message: 'name, storeId는 필수입니다.' };
    await this.ds.query(
      `UPDATE areas SET name=$1, store_id=$2, sort_order=$3, is_active=$4 WHERE id=$5`,
      [name, storeId, sortOrder, isActive, id],
    );
    return { ok: true };
  }

  /** 구역 삭제 */
  @Delete('areas/:id')
  async deleteArea(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!this.checkAdminPassword(String(body['password'] ?? ''))) {
      return { ok: false, message: '비밀번호가 틀렸습니다.' };
    }
    await this.ds.query(`DELETE FROM areas WHERE id=$1`, [id]);
    return { ok: true };
  }

  private buildAreasHtml(): string {
    const serverUrl = process.env.SERVER_URL ?? '';
    return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>구역 관리</title>
<style>
  body { font-family: sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
  h1 { color: #333; }
  .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
  th { background: #f0f0f0; font-weight: bold; }
  input, select { padding: 8px; border: 1px solid #ccc; border-radius: 4px; width: 100%; box-sizing: border-box; }
  button { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; }
  .btn-primary { background: #1976d2; color: white; }
  .btn-danger { background: #d32f2f; color: white; }
  .btn-edit { background: #388e3c; color: white; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .mt { margin-top: 10px; }
  label { font-size: 0.85em; color: #666; }
  #msg { padding: 10px; border-radius: 4px; display: none; }
  .ok { background: #e8f5e9; color: #2e7d32; }
  .err { background: #ffebee; color: #c62828; }
</style>
</head>
<body>
<h1>🗺️ 구역 관리</h1>

<div class="card">
  <h2>로그인</h2>
  <input id="pw" type="password" placeholder="관리자 비밀번호" style="max-width:300px">
  <button class="btn-primary mt" onclick="loadData()" style="margin-left:8px">로드</button>
  <div id="msg"></div>
</div>

<div class="card" id="addCard" style="display:none">
  <h2>구역 추가</h2>
  <div class="grid2">
    <div><label>구역명</label><input id="newName" placeholder="예: 남동구"></div>
    <div><label>담당 매장</label><select id="newStore"></select></div>
    <div><label>정렬순서</label><input id="newSort" type="number" value="0"></div>
  </div>
  <button class="btn-primary mt" onclick="addArea()">추가</button>
</div>

<div class="card" id="editCard" style="display:none">
  <h2>구역 수정</h2>
  <div class="grid2">
    <div><label>구역명</label><input id="editName"></div>
    <div><label>담당 매장</label><select id="editStore"></select></div>
    <div><label>정렬순서</label><input id="editSort" type="number"></div>
    <div><label>활성</label><select id="editActive"><option value="true">활성</option><option value="false">비활성</option></select></div>
  </div>
  <input type="hidden" id="editId">
  <button class="btn-edit mt" onclick="saveEdit()">저장</button>
  <button class="mt" onclick="cancelEdit()" style="margin-left:8px">취소</button>
</div>

<div class="card">
  <h2>구역 목록</h2>
  <table>
    <thead><tr><th>구역명</th><th>담당 매장</th><th>정렬</th><th>활성</th><th>작업</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
</div>

<script>
var BASE = '` + serverUrl + `';
var gAreas = [];
var gStores = [];

function showMsg(text, isOk) {
  var el = document.getElementById('msg');
  el.textContent = text;
  el.className = isOk ? 'ok' : 'err';
  el.style.display = 'block';
  setTimeout(function() { el.style.display = 'none'; }, 3000);
}

function pw() { return document.getElementById('pw').value; }

function loadData() {
  fetch(BASE + '/admin/areas/data?password=' + encodeURIComponent(pw()))
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (!d.ok) { showMsg(d.message || '오류', false); return; }
      gAreas = d.areas;
      gStores = d.stores;
      renderStoreOptions('newStore');
      renderStoreOptions('editStore');
      renderTable();
      document.getElementById('addCard').style.display = 'block';
      showMsg('로드 완료 (' + gAreas.length + '건)', true);
    })
    .catch(function() { showMsg('네트워크 오류', false); });
}

function renderStoreOptions(selId) {
  var sel = document.getElementById(selId);
  sel.innerHTML = '';
  gStores.forEach(function(s) {
    var opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    sel.appendChild(opt);
  });
}

function renderTable() {
  var tbody = document.getElementById('tbody');
  tbody.innerHTML = '';
  gAreas.forEach(function(a) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>' + a.name + '</td>' +
      '<td>' + a.store_name + '</td>' +
      '<td>' + a.sort_order + '</td>' +
      '<td>' + (a.is_active ? '✅' : '❌') + '</td>' +
      '<td>' +
        '<button class="btn-edit" data-id="' + a.id + '" onclick="openEdit(this)">수정</button> ' +
        '<button class="btn-danger" data-id="' + a.id + '" onclick="deleteArea(this)">삭제</button>' +
      '</td>';
    tbody.appendChild(tr);
  });
}

function openEdit(btn) {
  var id = btn.getAttribute('data-id');
  var a = gAreas.find(function(x) { return x.id === id; });
  if (!a) return;
  document.getElementById('editId').value = a.id;
  document.getElementById('editName').value = a.name;
  document.getElementById('editSort').value = a.sort_order;
  document.getElementById('editActive').value = a.is_active ? 'true' : 'false';
  renderStoreOptions('editStore');
  document.getElementById('editStore').value = a.store_id;
  document.getElementById('editCard').style.display = 'block';
}

function cancelEdit() {
  document.getElementById('editCard').style.display = 'none';
}

function addArea() {
  var body = {
    password: pw(),
    name: document.getElementById('newName').value.trim(),
    storeId: document.getElementById('newStore').value,
    sortOrder: parseInt(document.getElementById('newSort').value) || 0
  };
  fetch(BASE + '/admin/areas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) { showMsg('추가됨', true); loadData(); document.getElementById('newName').value = ''; }
      else showMsg(d.message || '오류', false);
    }).catch(function() { showMsg('네트워크 오류', false); });
}

function saveEdit() {
  var id = document.getElementById('editId').value;
  var body = {
    password: pw(),
    name: document.getElementById('editName').value.trim(),
    storeId: document.getElementById('editStore').value,
    sortOrder: parseInt(document.getElementById('editSort').value) || 0,
    isActive: document.getElementById('editActive').value === 'true'
  };
  fetch(BASE + '/admin/areas/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) { showMsg('수정됨', true); cancelEdit(); loadData(); }
      else showMsg(d.message || '오류', false);
    }).catch(function() { showMsg('네트워크 오류', false); });
}

function deleteArea(btn) {
  var id = btn.getAttribute('data-id');
  if (!confirm('삭제하시겠습니까?')) return;
  fetch(BASE + '/admin/areas/' + id, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw() })
  }).then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) { showMsg('삭제됨', true); loadData(); }
      else showMsg(d.message || '오류', false);
    }).catch(function() { showMsg('네트워크 오류', false); });
}
</script>
</body>
</html>`;
  }
}
