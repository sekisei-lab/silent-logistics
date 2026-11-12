'use strict';
/* 無言オペレーション配車プラットフォーム MVPバックエンド
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
  keitora: { label: '軽トラ', rank: 1, license: 'small', pallets: 1, payloadKg: 350 },
  keivan: { label: '軽バン', rank: 1, license: 'small', pallets: 1, payloadKg: 350 },
  t2: { label: '2t', rank: 2, license: 'small', pallets: 4, payloadKg: 2000 },
  t4: { label: '4t', rank: 3, license: 'medium', pallets: 8, payloadKg: 4000 },
  t10: { label: '10t（大型）', rank: 4, license: 'large', pallets: 16, payloadKg: 10000 },
  trailer: { label: 'トレーラー', rank: 5, license: 'large', pallets: 24, payloadKg: 20000 },
};
const BODIES = { wing: 'ウイング車', van: 'バン（ドライ）', reefer: '冷凍冷蔵車', flat: '平ボディ' };
const COMBINE_PICKUP_KM = 10, COMBINE_DROP_KM = 15, SERVICE_MIN = 20;
// 改善基準告示（トラック）に基づく管理の目安。実運用前に最新の基準を要確認
const LIM = { dayWarn: 13, dayMax: 15, monthWarn: 270, month: 284, monthMax: 310, restWarn: 11, restMin: 9, driveWarnMin: 210, driveMaxMin: 240 };
const localDate = () => { const t = new Date(); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
// 点呼記録（乗務前・乗務後）。日付が変わったら新しい日の記録にする
function tenkoOf(d) {
  if (!d.tenko || d.tenko.date !== localDate()) d.tenko = { date: localDate(), pre: null, post: null };
  return d.tenko;
}
const tenkoOk = (d) => { const t = tenkoOf(d); return !!(t.pre && t.pre.result === 'ok'); };
const continuousMin = (d) => (d.driveSince ? Math.max(0, Math.round((Date.now() - new Date(d.driveSince).getTime()) / 60000)) : 0);

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
    { id: 'd4', name: '趙（デモ）', lang: 'zh', license: 'small', vehicle: '軽トラ K-404', vehicleSpec: { type: 'keitora', body: 'flat' }, residenceExpiry: '2028-06-30', lat: 35.6, lng: 139.72, lastReal: 0, dutyStart: null },
  ];
  const shippers = [
    { id: 'c1', name: 'サンプル食品（デモ）' },
    { id: 'c2', name: 'デモ電機（デモ）' },
    { id: 'c3', name: 'テスト商事（デモ）' },
  ];
  const mkStop = (type, siteId, work, wh) => ({ type, siteId, warehouse: Object.assign({ forklift: true, helper: false, inspection: false }, wh), stage: 'pending', berth: null, checkinNo: null, arrivedAt: null, checkedinAt: null, calledAt: null, startedAt: null, doneAt: null, work, workRequests: [], photo: false });
  const jobs = [
    { id: 'J-1001', shipperId: 'c1', truckType: 't10', cargo: '食品 パレット12枚', pallets: 12, body: 'wing', windowStart: h(1.5), windowEnd: h(2.5), driverId: null, state: 'open', createdAt: h(-1), timeline: [], messages: [], stops: [mkStop('pickup', 's1', ['w_wing_open']), mkStop('dropoff', 's3', ['w_pallet_swap'])] },
    { id: 'J-1002', shipperId: 'c2', truckType: 't4', pallets: 4, body: 'van', tailLift: true, cargo: '家電 箱 40個（約4パレット換算）', windowStart: h(3), windowEnd: h(4), driverId: null, state: 'offered', offers: [{ driverId: 'd2', ts: h(-0.3), status: 'pending', nudges: 0, lastNudge: null }], createdAt: h(-1), timeline: [], messages: [], stops: [mkStop('pickup', 's4', ['w_manual_load', 'w_seal_check'], { forklift: false, helper: true }), mkStop('dropoff', 's5', ['w_manual_unload', 'w_tail_lift'], { forklift: false, inspection: true })] },
    { id: 'J-1003', shipperId: 'c3', truckType: 't10', pallets: 8, body: 'reefer', cargo: '冷凍品 パレット8枚', windowStart: h(5), windowEnd: h(6), driverId: null, state: 'open', createdAt: h(-0.5), timeline: [], messages: [], stops: [mkStop('pickup', 's2', []), mkStop('dropoff', 's1', [])] },
    { id: 'J-1005', shipperId: 'c3', truckType: 'keitora', pallets: 1, body: 'flat', sameDay: true, cargo: '建材 小口 3点（当日便）', windowStart: h(0.4), windowEnd: h(1.4), driverId: null, state: 'open', createdAt: h(-0.1), timeline: [], messages: [], stops: [mkStop('pickup', 's1', ['w_manual_load'], { forklift: false }), mkStop('dropoff', 's2', ['w_manual_unload'], { forklift: false })] },
    { id: 'J-1004', shipperId: 'c1', truckType: 't10', pallets: 4, body: 'van', cargo: '日用品 パレット4枚', windowStart: h(2), windowEnd: h(3), driverId: null, state: 'open', createdAt: h(-0.2), timeline: [], messages: [], stops: [mkStop('pickup', 's1', []), mkStop('dropoff', 's3', [])] },
  ];

  // ---- 運送中のテストデータ（地図・案件ボードの確認用）
  const S = (id) => sites.find((x) => x.id === id);
  const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
  const ago = (m) => new Date(now - m * 60000).toISOString();
  const done = (st, m) => Object.assign(st, { stage: 'done', berth: '1', checkinNo: 'X-001', arrivedAt: ago(m + 25), checkedinAt: ago(m + 18), calledAt: ago(m + 12), startedAt: ago(m + 8), doneAt: ago(m) });
  const demoDriver = (id, name, license, vehicle, spec, pos, dutyMin) => ({ id, name, lang: 'zh', license, vehicle, vehicleSpec: spec, residenceExpiry: '2028-03-31', lat: pos.lat, lng: pos.lng, lastReal: 0, dutyStart: ago(dutyMin), simKm: 0.4 });
  drivers.push(
    demoDriver('d5', '孫（デモ）', 'medium', '4t バン T-505', { type: 't4', body: 'van' }, lerp(S('s4'), S('s5'), 0.4), 190),
    demoDriver('d6', '周（デモ）', 'large', '10t ウイング T-606', { type: 't10', body: 'wing' }, { lat: 35.44, lng: 139.69 }, 120),
    demoDriver('d7', '呉（デモ）', 'small', '軽バン K-707', { type: 'keivan', body: 'van' }, lerp(S('s5'), S('s3'), 0.3), 150),
    demoDriver('d8', '鄭（デモ）', 'large', '10t ウイング T-808', { type: 't10', body: 'wing' }, { lat: S('s1').lat, lng: S('s1').lng }, 80),
  );
  const run = (id, shipperId, driverId, truckType, body, pallets, cargo, w0, w1, stops, log) => ({ id, shipperId, truckType, body, pallets, cargo, windowStart: h(w0), windowEnd: h(w1), driverId, offers: [], state: 'inprogress', createdAt: h(-3), timeline: log.map((t, i) => ({ ts: ago(60 - i * 15), who: 'system', text: t })), messages: [], stops });
  const j2001 = [done(mkStop('pickup', 's4', ['w_manual_load']), 35), mkStop('dropoff', 's5', ['w_manual_unload'])]; j2001[1].stage = 'enroute';
  const j2002 = [mkStop('pickup', 's2', ['w_wing_open']), mkStop('dropoff', 's1', [])]; j2002[0].stage = 'enroute';
  const j2003 = [done(mkStop('pickup', 's5', ['w_manual_load'], { forklift: false }), 20), mkStop('dropoff', 's3', ['w_manual_unload'], { forklift: false })]; j2003[1].stage = 'enroute';
  const j2004 = [mkStop('pickup', 's1', ['w_wing_open']), mkStop('dropoff', 's3', [])];
  Object.assign(j2004[0], { stage: 'checkedin', checkinNo: 'A-021', arrivedAt: ago(14), checkedinAt: ago(10) });
  jobs.push(
    run('J-2001', 'c1', 'd5', 't4', 'van', 4, '飲料 パレット4枚', -1.2, 1.5, j2001, ['千葉で積込み完了', '戸田へ出発']),
    run('J-2002', 'c2', 'd6', 't10', 'wing', 10, '機械部品 パレット10枚', 0.3, 1.5, j2002, ['川崎の積地へ出発']),
    run('J-2003', 'c3', 'd7', 'keivan', 'van', 1, '雑貨 小口3点', -0.8, 1.2, j2003, ['戸田で積込み完了', '横浜へ出発']),
    run('J-2004', 'c1', 'd8', 't10', 'wing', 6, '雑貨 パレット6枚', -0.3, 1.0, j2004, ['平和島に到着', '受付済み（呼び出し待ち）']),
  );
  // ---- 運行管理データ（点呼・月間拘束・休息期間・連続運転・車検）
  const rec = (mins, method, by) => ({ kind: 'pre', at: ago(mins), method, alcohol: 0, health: 'ok', result: 'ok', by });
  const ops = {
    d1: { pre: rec(330, 'IT点呼', '運行管理者 田中'), month: 176, rest: 12.5, drive: null, shaken: 200 },
    d2: { pre: null, month: 190, rest: 11.5, drive: null, shaken: 28 },
    d3: { pre: rec(320, '対面', '運行管理者 田中'), month: 164, rest: 13, drive: null, shaken: 120 },
    d4: { pre: rec(300, 'IT点呼', '運行管理者 佐藤'), month: 201, rest: 12, drive: null, shaken: 300 },
    d5: { pre: rec(420, 'IT点呼', '運行管理者 佐藤'), month: 258, rest: 11.2, drive: 215, shaken: 90 },
    d6: { pre: rec(400, '対面', '運行管理者 田中'), month: 281, rest: 10.2, drive: 100, shaken: 60 },
    d7: { pre: rec(380, 'IT点呼', '運行管理者 佐藤'), month: 172, rest: 12, drive: 60, shaken: 400 },
    d8: { pre: rec(350, 'IT点呼', '運行管理者 田中'), month: 233, rest: 11.8, drive: null, shaken: 45 },
  };
  drivers.forEach((d) => {
    const o = ops[d.id]; if (!o) return;
    d.tenko = { date: localDate(), pre: o.pre, post: null };
    d.monthHours = o.month; d.restHours = o.rest; d.driveSince = o.drive ? ago(o.drive) : null;
    d.vehicleInfo = { shakenDue: new Date(now + o.shaken * 864e5).toISOString().slice(0, 10) };
  });
  jobs.forEach((j) => { j.offers = j.offers || []; });
  return { sites, drivers, shippers, jobs, settings: { autoRespond: false } };
}

function load() {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { db = seed(); }
  db.settings = db.settings || { autoRespond: false };
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
  return Object.assign({}, d, { dutyHours: Math.round(dutyHours(d) * 10) / 10, activeJobId: active ? active.id : null, licenseJa: LICENSE_JA[d.license], tenko: tenkoOf(d), continuousDriveMin: continuousMin(d) });
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
  if (dutyHours(d) >= LIM.dayMax) add('error', `本日の拘束時間が${dutyHours(d).toFixed(1)}hです（上限${LIM.dayMax}h）`);
  else if (dutyHours(d) > LIM.dayWarn) add('warn', `本日の拘束時間が${dutyHours(d).toFixed(1)}hです（原則${LIM.dayWarn}h）`);
  const tk = tenkoOf(d);
  if (!tk.pre) add('warn', '乗務前点呼が未実施です（出発前に必要）');
  else if (tk.pre.result !== 'ok') add('error', '乗務前点呼が不合格です（乗務不可）');
  if (d.restHours != null) {
    if (d.restHours < LIM.restMin) add('error', `前回の休息期間が${d.restHours}h（下限${LIM.restMin}h未満）`);
    else if (d.restHours < LIM.restWarn) add('warn', `前回の休息期間が${d.restHours}h（基本${LIM.restWarn}h）`);
  }
  if (d.monthHours != null) {
    const rem = Math.round((LIM.month - d.monthHours) * 10) / 10;
    if (d.monthHours >= LIM.monthMax) add('error', `月間の拘束が${d.monthHours}h（上限${LIM.monthMax}h）`);
    else if (d.monthHours >= LIM.month) add('warn', `月間の拘束が${d.monthHours}h（原則${LIM.month}hを超過）`);
    else if (d.monthHours >= LIM.monthWarn) add('warn', `月間の拘束が${d.monthHours}h（原則${LIM.month}hまで残り${rem}h）`);
  }
  if (continuousMin(d) >= LIM.driveMaxMin) add('warn', `連続運転が${continuousMin(d)}分です（4時間を超過。休憩が必要）`);
  if (d.vehicleInfo) {
    const sd = (new Date(d.vehicleInfo.shakenDue).getTime() - Date.now()) / 864e5;
    if (sd < 0) add('error', '車検が切れています'); else if (sd < 30) add('warn', `車検期限が近い（残り${Math.ceil(sd)}日）`);
  }

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
  if (j.sameDay) {
    add('info', '当日便: 近くの小型車・軽トラが有利（小回りが利く）');
    if (T.rank >= 4) add('warn', '当日便に大型車は小回りが利きにくい');
  }
  const errors = items.filter((i) => i.level === 'error').length, warns = items.filter((i) => i.level === 'warn').length;
  const late = items.some((i) => i.msg.includes('間に合いません'));
  const score = errors ? 1e9 : (mode === 'combine' ? 0 : mode === 'idle' ? etaMin : etaMin + 30) + (late ? 500 : 0) + warns * 5 + (j.sameDay ? (T.rank - 1) * 8 : 0);
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
      if (!tenkoOk(d)) throw httpErr(409, '乗務前点呼が未実施（または不合格）です。点呼を受けてください');
      if (!d.driveSince) d.driveSince = new Date().toISOString();
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
      if (d) d.driveSince = null; // 荷役中は運転していない（連続運転の起点をリセット）
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
  if (db.settings && db.settings.autoRespond) {
    const now = Date.now();
    for (const j of db.jobs) {
      if (j.state !== 'offered') continue;
      for (const o of (j.offers || []).filter((x) => x.status === 'pending')) {
        if (!o.respondAt) o.respondAt = now + (8 + Math.random() * 17) * 1000;
        if (now >= o.respondAt && j.state === 'offered' && o.status === 'pending') { respondOffer(j, o.driverId, Math.random() < 0.5); changed = true; }
      }
    }
  }
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
      const step = d.simKm || Math.max(0.5, dist * 0.2);
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
  trucks: TRUCKS, bodies: BODIES, settings: db.settings, limits: LIM,
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
    id: 'J-' + (1001 + db.jobs.length + Math.floor(Math.random() * 900)), shipperId: b.shipperId, truckType: TRUCKS[b.truckType] ? b.truckType : 't10', body: BODIES[b.body] ? b.body : 'van', tailLift: !!b.tailLift, sameDay: !!b.sameDay, pallets: Math.max(1, Number(b.pallets) || 1),
    cargo: String(b.cargo || ''), windowStart: start.toISOString(), windowEnd: new Date(start.getTime() + 3600e3).toISOString(),
    driverId: null, offers: [], state: 'open', createdAt: new Date().toISOString(), timeline: [], messages: [],
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

// 打診: 1つの案件に複数のトラックへ同時（並行）に打診できる（最初に受諾したトラックが担当になる）
// by: 'manual'（地図からのドラッグ）／'ai'（AI打診）
function addOffer(j, d, by, reason) {
  j.offers = j.offers || [];
  const ex = j.offers.find((o) => o.driverId === d.id);
  if (ex && ex.status === 'pending') throw httpErr(409, `${d.name}にはすでに打診中です`);
  const now = new Date().toISOString();
  const rec = { driverId: d.id, ts: now, status: 'pending', nudges: 0, lastNudge: null, by, reason: reason || '', respondAt: null };
  if (ex) Object.assign(ex, rec); else j.offers.push(rec);
  j.state = 'offered';
  event(j, `${d.name}に案件を打診${by === 'ai' ? '（AI打診）' : ''}`, by === 'ai' ? 'ai' : 'desk');
}
route('POST', '/api/jobs/:id/assign', (p, b) => {
  const j = job(p.id), d = driver(b.driverId);
  if (!j || !d) throw httpErr(404, '見つかりません');
  if (!['open', 'offered'].includes(j.state)) throw httpErr(409, 'この案件は割当できません');
  const errs = checkAssign(d, j).filter((c) => c.level === 'error');
  if (errs.length) throw httpErr(409, errs.map((e) => e.msg).join(' / '));
  addOffer(j, d, 'manual', '');
  broadcast(); return view(j);
});

// AI打診: 評価の高い順に、条件を満たすトラックへまとめて並行打診する
const MODE_JA = { idle: '待機中の空車', combine: '走行中に積み合わせ', sequential: '現案件の完了後に連続配車' };
function aiReason(c) {
  const t = c.etaMin != null ? `・約${c.etaMin}分` : '';
  const warn = c.items.filter((i) => i.level === 'warn' && !i.msg.includes('別案件')).length;
  return `${MODE_JA[c.mode] || ''}${t}${warn ? `（注意${warn}件）` : ''}`;
}
function aiOffer(j, count) {
  if (!['open', 'offered'].includes(j.state)) throw httpErr(409, 'この案件は打診できません');
  const excluded = new Set((j.offers || []).filter((o) => ['pending', 'declined', 'withdrawn'].includes(o.status)).map((o) => o.driverId));
  const picks = candidatesFor(j).filter((c) => !c.items.some((i) => i.level === 'error') && !excluded.has(c.driverId)).slice(0, count);
  picks.forEach((c) => addOffer(j, driver(c.driverId), 'ai', aiReason(c)));
  return picks;
}
route('POST', '/api/jobs/:id/ai-offer', (p, b) => {
  const j = job(p.id);
  if (!j) throw httpErr(404, '見つかりません');
  const count = Math.min(8, Math.max(1, Number(b.count) || 3));
  const picks = aiOffer(j, count);
  if (!picks.length) throw httpErr(409, '打診できる候補がいません（条件に合う車両がない、または全員に打診済み）');
  broadcast(); return { job: view(j), offered: picks.map((c) => c.driverId) };
});
route('POST', '/api/ai-offer-all', (p, b) => {
  const count = Math.min(8, Math.max(1, Number(b.count) || 3));
  const res = [];
  db.jobs.filter((j) => j.state === 'open').forEach((j) => { try { res.push({ jobId: j.id, offered: aiOffer(j, count).map((c) => c.driverId) }); } catch (e) { /* 候補なしはスキップ */ } });
  broadcast(); return { results: res };
});
route('POST', '/api/settings', (p, b) => { db.settings.autoRespond = !!b.autoRespond; broadcast(); return db.settings; });

// ドライバーの回答（実機の操作・デモ自動応答で共用）
function respondOffer(j, driverId, accept) {
  const o = (j.offers || []).find((x) => x.driverId === driverId && x.status === 'pending');
  if (!o || j.state !== 'offered') throw httpErr(409, 'この案件への打診がありません');
  const d = driver(o.driverId);
  if (accept) {
    o.status = 'accepted'; j.driverId = o.driverId; j.state = 'accepted';
    j.offers.forEach((x) => { if (x !== o && x.status === 'pending') x.status = 'cancelled'; });
    event(j, `${d.name}が受諾`, 'driver');
  } else {
    o.status = 'declined'; event(j, `${d.name}が辞退`, 'driver');
    if (!j.offers.some((x) => x.status === 'pending')) j.state = 'open';
  }
}
route('POST', '/api/jobs/:id/respond', (p, b) => {
  const j = job(p.id);
  if (!j || j.state !== 'offered') throw httpErr(409, '回答できません');
  respondOffer(j, b.driverId, !!b.accept);
  broadcast(); return view(j);
});

// 打診中のトラックへ回答の催促（ドライバーに母国語で通知）
route('POST', '/api/jobs/:id/offers/:driverId/nudge', (p) => {
  const j = job(p.id), o = j && (j.offers || []).find((x) => x.driverId === p.driverId && x.status === 'pending');
  if (!o) throw httpErr(409, '打診中ではありません');
  o.nudges += 1; o.lastNudge = new Date().toISOString();
  const m = message(j, 'desk', 'nudge', 'm_nudge'); m.to = o.driverId;
  event(j, `${driver(o.driverId).name}に回答を催促（${o.nudges}回目）`, 'desk');
  broadcast(); return view(j);
});

route('POST', '/api/jobs/:id/offers/:driverId/withdraw', (p) => {
  const j = job(p.id), o = j && (j.offers || []).find((x) => x.driverId === p.driverId && x.status === 'pending');
  if (!o) throw httpErr(409, '打診中ではありません');
  o.status = 'withdrawn'; event(j, `${driver(o.driverId).name}への打診を取り下げ`, 'desk');
  if (!j.offers.some((x) => x.status === 'pending')) j.state = 'open';
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

// 点呼（乗務前・乗務後）の記録。アルコール検知または体調不良は不合格（乗務不可）
route('POST', '/api/drivers/:id/tenko', (p, b) => {
  const d = driver(p.id);
  if (!d) throw httpErr(404, '見つかりません');
  const kind = b.kind === 'post' ? 'post' : 'pre';
  const tk = tenkoOf(d);
  if (kind === 'post' && !tk.pre) throw httpErr(409, '乗務前点呼の記録がありません');
  const alcohol = Math.max(0, Number(b.alcohol) || 0), health = b.health === 'bad' ? 'bad' : 'ok';
  tk[kind] = { kind, at: new Date().toISOString(), method: ['対面', 'IT点呼', '電話'].includes(b.method) ? b.method : 'IT点呼', alcohol, health, result: alcohol > 0 || health === 'bad' ? 'ng' : 'ok', by: String(b.by || '運行管理者').slice(0, 30) };
  broadcast(); return driverView(d);
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
