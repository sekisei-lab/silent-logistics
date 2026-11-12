'use strict';
/* 無言オペレーション物流プラットフォーム MVPバックエンド
 * 依存パッケージなし（Node.js 標準モジュールのみ）。
 * 保存先: data/db.json（Renderの無料枠ではデプロイ/再起動で初期化されます）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC = path.join(__dirname, 'public');
const SIM = process.env.SIMULATE !== '0'; // 実GPSが来ない車両を自動で動かすデモ機能
const GEOFENCE_KM = 0.15;
const SPEED_KMH = 30;

const STAGES = ['pending', 'enroute', 'arrived', 'checkedin', 'called', 'working', 'done'];
const LICENSE_RANK = { small: 1, medium: 2, large: 3 };
const LICENSE_JA = { small: '普通', medium: '中型', large: '大型' };
// 車種マスタ（一般的な区分に固定）。pallets は 11型パレット換算の積載目安
const TRUCKS = {
  kei: { label: '軽貨物', rank: 1, license: 'small', pallets: 1, payloadKg: 350 },
  t2: { label: '2t', rank: 2, license: 'small', pallets: 4, payloadKg: 2000 },
  t4: { label: '4t', rank: 3, license: 'medium', pallets: 8, payloadKg: 4000 },
  t10: { label: '10t（大型）', rank: 4, license: 'large', pallets: 16, payloadKg: 10000 },
  trailer: { label: 'トレーラー', rank: 5, license: 'large', pallets: 24, payloadKg: 20000 },
};
const BODIES = { wing: 'ウイング車', van: 'バン（ドライ）', reefer: '冷凍冷蔵車', flat: '平ボディ' };
const COMBINE_PICKUP_KM = 10, COMBINE_DROP_KM = 15, SERVICE_MIN = 20;

// ---------------------------------------------------------------- DB
let db = null;
let saveTimer = null;
const uid = (p) => p + Math.random().toString(36).slice(2, 8);

function seed() {
  const now = Date.now();
  const h = (n) => new Date(now + n * 3600e3).toISOString();
  const rule = (...r) => r;
  const sites = [
    { id: 's1', name: 'デモ物流センター 平和島', address: '東京都大田区平和島（デモ）', lat: 35.588, lng: 139.743, berths: ['A1', 'A2', 'A3', 'B1', 'B2'], rules: rule('r_gate_check', 'r_helmet', 'r_vest', 'r_speed5', 'r_one_way', 'r_chock'), note: '北門から入り、受付で伝票を提示。待機場所は敷地奥の駐車エリア。' },
    { id: 's2', name: 'デモ冷凍倉庫 川崎', address: '神奈川県川崎市川崎区（デモ）', lat: 35.529, lng: 139.777, berths: ['C1', 'C2', 'C3'], rules: rule('r_gate_check', 'r_vest', 'r_no_idle', 'r_engine_off', 'r_speed5'), note: '冷凍品のため荷役中はアイドリング禁止。' },
    { id: 's3', name: 'デモ配送センター 横浜', address: '神奈川県横浜市中区（デモ）', lat: 35.424, lng: 139.67, berths: ['D1', 'D2', 'D3', 'D4'], rules: rule('r_gate_check', 'r_helmet', 'r_vest', 'r_one_way', 'r_no_phone'), note: '西ゲート利用。バースは受付後に番号で呼び出し。' },
    { id: 's4', name: 'デモ工場 千葉', address: '千葉県習志野市（デモ）', lat: 35.683, lng: 140.026, berths: ['E1', 'E2'], rules: rule('r_gate_check', 'r_helmet', 'r_vest', 'r_speed5', 'r_engine_off'), note: '' },
    { id: 's5', name: 'デモ店舗配送所 戸田', address: '埼玉県戸田市（デモ）', lat: 35.814, lng: 139.68, berths: ['F1', 'F2', 'F3'], rules: rule('r_gate_check', 'r_vest', 'r_no_idle', 'r_chock'), note: '' },
  ];
  const drivers = [
    { id: 'd1', name: '王（デモ）', lang: 'zh', license: 'large', vehicle: '10t ウイング T-101', vehicleSpec: { type: 't10', body: 'wing' }, residenceExpiry: '2028-03-31', lat: 35.7, lng: 139.8, lastReal: 0, dutyStart: null },
    { id: 'd2', name: '李（デモ）', lang: 'zh', license: 'medium', vehicle: '4t バン（パワーゲート付）T-202', vehicleSpec: { type: 't4', body: 'van', tailLift: true }, residenceExpiry: new Date(now + 55 * 864e5).toISOString().slice(0, 10), lat: 35.65, lng: 139.75, lastReal: 0, dutyStart: null },
    { id: 'd3', name: '張（デモ）', lang: 'zh', license: 'large', vehicle: '10t 冷凍 T-303', vehicleSpec: { type: 't10', body: 'reefer' }, residenceExpiry: '2027-09-30', lat: 35.55, lng: 139.72, lastReal: 0, dutyStart: null },
  ];
  const shippers = [
    { id: 'c1', name: 'サンプル食品（デモ）' },
    { id: 'c2', name: 'デモ電機（デモ）' },
    { id: 'c3', name: 'テスト商事（デモ）' },
  ];
  const mkStop = (type, siteId, work, wh) => ({ type, siteId, warehouse: Object.assign({ forklift: true, helper: false, inspection: false }, wh), stage: 'pending', berth: null, checkinNo: null, arrivedAt: null, checkedinAt: null, calledAt: null, startedAt: null, doneAt: null, work, workRequests: [], photo: false });
  const jobs = [
    { id: 'J-1001', shipperId: 'c1', truckType: 't10', cargo: '食品 パレット12枚', pallets: 12, body: 'wing', windowStart: h(1.5), windowEnd: h(2.5), driverId: null, state: 'open', createdAt: h(-1), timeline: [], messages: [], stops: [mkStop('pickup', 's1', ['w_wing_open']), mkStop('dropoff', 's3', ['w_pallet_swap'])] },
    { id: 'J-1002', shipperId: 'c2', truckType: 't4', pallets: 4, body: 'van', tailLift: true, cargo: '家電 箱 40個（約4パレット換算）', windowStart: h(3), windowEnd: h(4), driverId: 'd2', state: 'offered', createdAt: h(-1), timeline: [], messages: [], stops: [mkStop('pickup', 's4', ['w_manual_load', 'w_seal_check'], { forklift: false, helper: true }), mkStop('dropoff', 's5', ['w_manual_unload', 'w_tail_lift'], { forklift: false, inspection: true })] },
    { id: 'J-1003', shipperId: 'c3', truckType: 't10', pallets: 8, body: 'reefer', cargo: '冷凍品 パレット8枚', windowStart: h(5), windowEnd: h(6), driverId: null, state: 'open', createdAt: h(-0.5), timeline: [], messages: [], stops: [mkStop('pickup', 's2', []), mkStop('dropoff', 's1', [])] },
    { id: 'J-1004', shipperId: 'c1', truckType: 't10', pallets: 4, body: 'van', cargo: '日用品 パレット4枚', windowStart: h(2), windowEnd: h(3), driverId: null, state: 'open', createdAt: h(-0.2), timeline: [], messages: [], stops: [mkStop('pickup', 's1', []), mkStop('dropoff', 's3', [])] },
  ];
  return { sites, drivers, shippers, jobs };
}

function load() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { db = seed(); }
  save(true);
}
function save(now) {
  if (now) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { /* 書き込み不可の環境ではメモリのみ */ } return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(true), 500);
}

// ---------------------------------------------------------------- helpers
const site = (id) => db.sites.find((s) => s.id === id);
const driver = (id) => db.drivers.find((d) => d.id === id);
const job = (id) => db.jobs.find((j) => j.id === id);

function km(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function activeStopIdx(j) { return j.stops.findIndex((s) => s.stage !== 'done'); }
function event(j, text, who) { j.timeline.push({ ts: new Date().toISOString(), who: who || 'system', text }); }
function message(j, from, kind, key, params) {
  const m = { id: uid('m'), ts: new Date().toISOString(), from, kind, key, params: params || null, resolved: false };
  j.messages.push(m);
  return m;
}
function view(j) {
  const idx = activeStopIdx(j);
  let eta = null, distKm = null;
  const d = j.driverId && driver(j.driverId);
  if (d && idx >= 0 && j.state === 'inprogress') {
    const s = j.stops[idx];
    if (s.stage === 'enroute' || s.stage === 'pending') {
      distKm = km(d, site(s.siteId));
      eta = Math.round((distKm / SPEED_KMH) * 60);
    }
  }
  return Object.assign({}, j, { activeStop: idx, eta, distKm });
}
function dutyHours(d) { return d.dutyStart ? (Date.now() - new Date(d.dutyStart).getTime()) / 3600e3 : 0; }
function driverView(d) {
  const active = db.jobs.find((j) => j.driverId === d.id && (j.state === 'inprogress' || j.state === 'accepted'));
  return Object.assign({}, d, { dutyHours: Math.round(dutyHours(d) * 10) / 10, activeJobId: active ? active.id : null, licenseJa: LICENSE_JA[d.license] });
}
const hhmm = (ms) => { const t = new Date(ms); return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); };
const BODY_OK = (need, have) => (need === 'van' ? ['van', 'wing', 'reefer'].includes(have) : need === have);

// 同じ車両に積める貨物の組み合わせか（冷凍冷蔵と常温の混載は不可）
const compatCargo = (a, b, spec) => (a.body === 'reefer') === (b.body === 'reefer') && BODY_OK(a.body, spec.body) && BODY_OK(b.body, spec.body);
// 配車候補の評価: 車種・免許・積載・荷台・在留期限・拘束時間に加え、
// 走行中の車両について「積み合わせ（途中ピックアップ）」と「現案件完了後の連続配車」が可能かを判定する
function evaluate(d, j) {
  const items = [], add = (level, msg) => items.push({ level, msg });
  const spec = d.vehicleSpec, T = TRUCKS[spec.type], need = TRUCKS[j.truckType] || TRUCKS.t10;
  if (LICENSE_RANK[d.license] < LICENSE_RANK[T.license]) add('error', `免許区分が不足（${LICENSE_JA[d.license]}免許では${T.label}車は不可）`);
  if (T.rank < need.rank) add('error', `車格が不足（${T.label}車では${need.label}指定に対応不可）`);
  else if (T.rank > need.rank) add('warn', `指定（${need.label}）より大きい車両です`);
  if ((j.pallets || 0) > T.pallets) add('error', `積載不足（${j.pallets}枚に対し最大${T.pallets}枚）`);
  if (!BODY_OK(j.body, spec.body)) add('error', `荷台が合いません（必要: ${BODIES[j.body]}／この車両: ${BODIES[spec.body]}）`);
  if (j.tailLift && !spec.tailLift) add('error', 'パワーゲート付きの車両が必要です');
  j.stops.forEach((st) => { if (st.warehouse && !st.warehouse.forklift && !spec.tailLift) add('warn', `${site(st.siteId).name}にフォークリフトがありません（パワーゲートなしの車両は荷役が困難）`); });
  const days = (new Date(d.residenceExpiry).getTime() - Date.now()) / 864e5;
  if (days < 0) add('error', '在留期限が切れています');
  else if (days < 90) add('warn', `在留期限が近い（残り${Math.ceil(days)}日）`);
  if (dutyHours(d) > 13) add('warn', `本日の拘束時間が${dutyHours(d).toFixed(1)}hです（目安13h）`);

  const P = site(j.stops[0].siteId), D2 = site(j.stops[1].siteId);
  const now = Date.now(), end = new Date(j.windowEnd).getTime();
  const cur = db.jobs.find((x) => x.id !== j.id && x.driverId === d.id && ['offered', 'accepted', 'inprogress'].includes(x.state));
  let mode = 'idle', etaMin = null, arrival = null;
  if (!cur) {
    etaMin = Math.round((km(d, P) / SPEED_KMH) * 60); arrival = now + etaMin * 60000;
    if (arrival > end) add('warn', `空車で向かうと${hhmm(arrival)}着で希望時間に間に合いません`);
    else add('info', `待機中。空車で約${etaMin}分で積地に到着（${hhmm(arrival)}）`);
  } else {
    add('warn', `別案件 ${cur.id} を担当中です`);
    const curPick = site(cur.stops[0].siteId), curDrop = site(cur.stops[1].siteId);
    const loaded = cur.stops[0].stage === 'done';
    const used = cur.pallets || 0, spare = T.pallets - used;
    const dropGap = km(curDrop, D2);
    if ((j.pallets || 0) <= spare && compatCargo(cur, j, spec) && dropGap <= COMBINE_DROP_KM) {
      if (loaded && cur.state === 'inprogress') {
        const detour = km(d, P) + km(P, curDrop) - km(d, curDrop);
        if (detour <= COMBINE_PICKUP_KM) { mode = 'combine'; add('info', `走行中の積み合わせが可能（積地まで迂回+${detour.toFixed(1)}km、余裕${spare}枚、届け先どうし${dropGap.toFixed(1)}km）`); }
      } else if (!loaded) {
        const pg = km(curPick, P);
        if (pg <= COMBINE_PICKUP_KM) { mode = 'combine'; add('info', `同じ便に積み合わせ可能（積地どうし${pg.toFixed(1)}km、合計${used + (j.pallets || 0)}/${T.pallets}枚、届け先どうし${dropGap.toFixed(1)}km）`); }
      }
    }
    if (mode === 'combine') { etaMin = Math.round((km(d, P) / SPEED_KMH) * 60); arrival = now + etaMin * 60000; }
    else {
      mode = 'sequential';
      let pos = d, t = 0;
      cur.stops.forEach((st) => { if (st.stage !== 'done') { const s2 = site(st.siteId); t += (km(pos, s2) / SPEED_KMH) * 60 + SERVICE_MIN; pos = s2; } });
      etaMin = Math.round(t + (km(pos, P) / SPEED_KMH) * 60); arrival = now + etaMin * 60000;
      if (arrival > end) add('warn', `現案件の完了後だと${hhmm(arrival)}着で希望時間に間に合いません`);
      else add('info', `現案件 ${cur.id} の完了後に連続配車が可能（${hhmm(arrival)}着見込み）`);
    }
  }
  const errors = items.filter((i) => i.level === 'error').length, warns = items.filter((i) => i.level === 'warn').length;
  const late = items.some((i) => i.msg.includes('間に合いません'));
  const score = errors ? 1e9 : (mode === 'combine' ? 0 : mode === 'idle' ? etaMin : etaMin + 30) + (late ? 500 : 0) + warns * 5;
  return { driverId: d.id, items, mode, etaMin, arrivalAt: arrival ? new Date(arrival).toISOString() : null, score };
}
const checkAssign = (d, j) => evaluate(d, j).items;
const candidatesFor = (j) => db.drivers.map((d) => evaluate(d, j)).sort((a, b) => a.score - b.score);

// ---------------------------------------------------------------- SSE
const clients = new Set();
function broadcast() {
  save();
  for (const res of clients) res.write('event: update\ndata: {}\n\n');
}

// ---------------------------------------------------------------- state machine
function advance(j, idx, action, by, body) {
  const s = j.stops[idx];
  if (!s) throw httpErr(404, '停車先がありません');
  const d = j.driverId && driver(j.driverId);
  const label = (s.type === 'pickup' ? '積地' : '届け先') + '「' + site(s.siteId).name + '」';
  const need = (stage) => { if (s.stage !== stage) throw httpErr(409, `現在の状態(${s.stage})ではできません`); };
  if (idx !== activeStopIdx(j)) throw httpErr(409, '現在の停車先ではありません');
  switch (action) {
    case 'depart':
      need('pending');
      if (!d) throw httpErr(409, 'ドライバー未割当です');
      s.stage = 'enroute'; j.state = 'inprogress';
      if (!d.dutyStart) d.dutyStart = new Date().toISOString();
      event(j, `${label}へ出発`, 'driver');
      break;
    case 'arrive':
      need('enroute');
      s.stage = 'arrived'; s.arrivedAt = new Date().toISOString();
      event(j, `${label}に到着${body && body.auto ? '（自動検知）' : ''}`, body && body.auto ? 'system' : 'driver');
      break;
    case 'checkin': {
      need('arrived');
      const n = db.jobs.reduce((a, x) => a + x.stops.filter((y) => y.siteId === s.siteId && y.checkinNo).length, 0) + 1;
      s.stage = 'checkedin'; s.checkedinAt = new Date().toISOString();
      s.checkinNo = site(s.siteId).berths[0].charAt(0) + '-' + String(n).padStart(3, '0');
      event(j, `${label}で受付（${s.checkinNo}）`, 'driver');
      break;
    }
    case 'call': {
      need('checkedin');
      const berth = body && body.berth;
      if (!berth || !site(s.siteId).berths.includes(berth)) throw httpErr(400, 'バースを選んでください');
      s.stage = 'called'; s.berth = berth; s.calledAt = new Date().toISOString();
      message(j, by || 'shipper', 'call', 'm_call_berth', { berth });
      event(j, `${label}: バース${berth}へ呼び出し`, by || 'shipper');
      break;
    }
    case 'start':
      need('called');
      s.stage = 'working'; s.startedAt = new Date().toISOString();
      event(j, `${label}で作業開始`, 'driver');
      break;
    case 'done':
      need('working');
      s.stage = 'done'; s.doneAt = new Date().toISOString();
      event(j, `${label}で作業完了`, by || 'driver');
      if (idx === j.stops.length - 1) {
        j.state = 'done'; event(j, '配送完了', 'system');
      }
      break;
    default: throw httpErr(400, '不明な操作です');
  }
}
function httpErr(code, msg) { const e = new Error(msg); e.code = code; return e; }

// ---------------------------------------------------------------- simulation
function tick() {
  let changed = false;
  for (const j of db.jobs) {
    if (j.state !== 'inprogress' || !j.driverId) continue;
    const idx = activeStopIdx(j);
    if (idx < 0) continue;
    const s = j.stops[idx];
    if (s.stage !== 'enroute') continue;
    const d = driver(j.driverId), target = site(s.siteId);
    const real = Date.now() - (d.lastReal || 0) < 30000;
    if (!real && SIM) {
      const dist = km(d, target);
      const step = Math.max(0.5, dist * 0.2);
      const r = Math.min(1, step / Math.max(dist, 0.001));
      d.lat += (target.lat - d.lat) * r; d.lng += (target.lng - d.lng) * r;
      changed = true;
    }
    if (km(d, target) < GEOFENCE_KM && (real || SIM)) { advance(j, idx, 'arrive', 'system', { auto: true }); changed = true; }
  }
  if (changed) broadcast();
}
setInterval(() => { try { tick(); } catch (e) { console.error(e); } }, 2000);

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/bootstrap', () => ({
  sites: db.sites, shippers: db.shippers,
  drivers: db.drivers.map(driverView),
  trucks: TRUCKS, bodies: BODIES,
  jobs: db.jobs.map((j) => { const v = view(j); if (j.state === 'open' || j.state === 'offered') v.candidates = candidatesFor(j); return v; }).sort((a, b) => a.windowStart.localeCompare(b.windowStart)),
}));

route('POST', '/api/reset', () => { db = seed(); broadcast(); return { ok: true }; });

route('POST', '/api/sites', (p, b) => {
  if (!b.name || !b.lat || !b.lng) throw httpErr(400, '名称と座標が必要です');
  const s = { id: uid('s'), name: String(b.name), address: String(b.address || ''), lat: Number(b.lat), lng: Number(b.lng), berths: (b.berths || []).filter(Boolean), rules: (b.rules || []).filter((r) => /^r_/.test(r)), note: String(b.note || '') };
  if (!s.berths.length) s.berths = ['1'];
  db.sites.push(s); broadcast(); return s;
});

route('POST', '/api/jobs', (p, b) => {
  const wh = (o) => ({ forklift: !(o && o.forklift === false), helper: !!(o && o.helper), inspection: !!(o && o.inspection) });
  const st = (type, siteId, work, w) => {
    if (!site(siteId)) throw httpErr(400, '拠点を選んでください');
    return { type, siteId, warehouse: wh(w), stage: 'pending', berth: null, checkinNo: null, arrivedAt: null, checkedinAt: null, calledAt: null, startedAt: null, doneAt: null, work: (work || []).filter((x) => /^w_/.test(x)), workRequests: [], photo: false };
  };
  if (!b.shipperId) throw httpErr(400, '荷主を選んでください');
  const start = new Date(b.windowStart);
  if (isNaN(start)) throw httpErr(400, '日時が不正です');
  const j = {
    id: 'J-' + (1001 + db.jobs.length + Math.floor(Math.random() * 900)), shipperId: b.shipperId, truckType: TRUCKS[b.truckType] ? b.truckType : 't10', body: BODIES[b.body] ? b.body : 'van', tailLift: !!b.tailLift, pallets: Math.max(1, Number(b.pallets) || 1),
    cargo: String(b.cargo || ''), windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 3600e3).toISOString(),
    driverId: null, state: 'open', createdAt: new Date().toISOString(), timeline: [], messages: [],
    stops: [st('pickup', b.pickupSiteId, b.pickupWork, b.pickupWh), st('dropoff', b.dropoffSiteId, b.dropoffWork, b.dropoffWh)],
  };
  event(j, '輸送依頼を登録', 'shipper');
  db.jobs.push(j); broadcast(); return view(j);
});

route('GET', '/api/jobs/:id/check', (p, b, q) => {
  const j = job(p.id), d = driver(q.get('driverId'));
  if (!j || !d) throw httpErr(404, '見つかりません');
  return checkAssign(d, j);
});

route('POST', '/api/jobs/:id/assign', (p, b) => {
  const j = job(p.id), d = driver(b.driverId);
  if (!j || !d) throw httpErr(404, '見つかりません');
  if (!['open', 'offered'].includes(j.state)) throw httpErr(409, 'この案件は割当できません');
  const errs = checkAssign(d, j).filter((c) => c.level === 'error');
  if (errs.length) throw httpErr(409, errs.map((e) => e.msg).join(' / '));
  j.driverId = d.id; j.state = 'offered';
  event(j, `${d.name}に案件を提示`, 'desk');
  broadcast(); return view(j);
});

route('POST', '/api/jobs/:id/respond', (p, b) => {
  const j = job(p.id);
  if (!j || j.state !== 'offered') throw httpErr(409, '回答できません');
  const d = driver(j.driverId);
  if (b.accept) { j.state = 'accepted'; event(j, `${d.name}が受諾`, 'driver'); }
  else { event(j, `${d.name}が辞退`, 'driver'); j.driverId = null; j.state = 'open'; }
  broadcast(); return view(j);
});

route('POST', '/api/jobs/:id/stops/:idx/:action', (p, b) => {
  const j = job(p.id);
  if (!j) throw httpErr(404, '見つかりません');
  advance(j, Number(p.idx), p.action, b.by, b);
  broadcast(); return view(j);
});

route('POST', '/api/jobs/:id/stops/:idx/photo', (p) => {
  const j = job(p.id); const s = j && j.stops[Number(p.idx)];
  if (!s) throw httpErr(404, '見つかりません');
  s.photo = true; event(j, '写真を送信', 'driver'); broadcast(); return view(j);
});

route('POST', '/api/jobs/:id/work-request', (p, b) => {
  const j = job(p.id), s = j && j.stops[Number(b.idx)];
  if (!s || !/^w_/.test(b.key)) throw httpErr(400, '不正な依頼です');
  s.workRequests.push({ key: b.key, ts: new Date().toISOString() });
  message(j, b.by || 'shipper', 'work', 'm_work_request', { work: b.key });
  event(j, '作業依頼: ' + b.key, b.by || 'shipper');
  broadcast(); return view(j);
});

route('POST', '/api/jobs/:id/messages', (p, b) => {
  const j = job(p.id);
  if (!j) throw httpErr(404, '見つかりません');
  if (!/^[tm]_/.test(b.key)) throw httpErr(400, '定型文のみ送信できます');
  const kind = b.from === 'driver' ? 'trouble' : 'reply';
  const m = message(j, b.from || 'shipper', kind, b.key);
  event(j, (b.from === 'driver' ? 'ドライバー連絡: ' : '現場から連絡: ') + b.key, b.from || 'shipper');
  broadcast(); return m;
});

route('POST', '/api/jobs/:id/messages/:mid/resolve', (p) => {
  const j = job(p.id), m = j && j.messages.find((x) => x.id === p.mid);
  if (!m) throw httpErr(404, '見つかりません');
  m.resolved = true; broadcast(); return m;
});

route('POST', '/api/drivers/:id/position', (p, b) => {
  const d = driver(p.id);
  if (!d) throw httpErr(404, '見つかりません');
  d.lat = Number(b.lat); d.lng = Number(b.lng); d.lastReal = Date.now();
  tick(); broadcast(); return { ok: true };
});

// ---------------------------------------------------------------- server
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    const ka = setInterval(() => res.write(': ka\n\n'), 25000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }
  if (u.pathname.startsWith('/api/')) {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
      try {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(u.pathname);
          if (!m) continue;
          const body = raw ? JSON.parse(raw) : {};
          return send(200, r.fn(Object.assign({}, m.groups), body, u.searchParams));
        }
        send(404, { error: 'not found' });
      } catch (e) {
        send(e.code || 500, { error: e.message });
        if (!e.code) console.error(e);
      }
    });
    return;
  }
  // 静的ファイル
  let rel = decodeURIComponent(u.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

load();
if (require.main === module) {
  server.listen(PORT, () => console.log(`silent-logistics listening on :${PORT}`));
}
module.exports = { server };
