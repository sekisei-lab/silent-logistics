'use strict';
// 一連の業務フローが通ることを確認するスモークテスト（外部依存なし）
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'));
const assert = require('assert');
const { server } = require('../server.js');

server.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (m, p, b) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    const j = await r.json(); return { status: r.status, body: j };
  };
  const ok = async (m, p, b) => { const r = await call(m, p, b); assert.strictEqual(r.status, 200, `${m} ${p} -> ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  try {
    let s = await ok('GET', '/api/bootstrap');
    assert.ok(s.sites.length >= 5 && s.drivers.length === 8 && s.jobs.length === 9);

    // 免許区分が足りないドライバー（中型）に大型案件は割り当てられない
    let r = await call('POST', '/api/jobs/J-1001/assign', { driverId: 'd2' });
    assert.strictEqual(r.status, 409, '免許不足は拒否されること');
    await ok('POST', '/api/jobs/J-1001/assign', { driverId: 'd1' });
    await ok('POST', '/api/jobs/J-1001/respond', { accept: true, driverId: 'd1' });

    // 配車候補の判定: 同じ積地・近い届け先で余裕積載がある案件は積み合わせ可能、荷台違いは不可
    s = await ok('GET', '/api/bootstrap');
    const cand = (jobId, dId) => s.jobs.find((x) => x.id === jobId).candidates.find((c) => c.driverId === dId);
    assert.strictEqual(cand('J-1004', 'd1').mode, 'combine', '積み合わせ可能と判定されること');
    assert.ok(cand('J-1003', 'd1').items.some((i) => i.level === 'error'), '冷凍案件に非冷凍車は不可');
    assert.strictEqual(cand('J-1003', 'd3').mode, 'idle');
    assert.ok(!cand('J-1003', 'd3').items.some((i) => i.level === 'error'));
    assert.ok(s.trucks.t10 && s.bodies.reefer && s.trucks.keitora && s.trucks.keivan);
    // 運送中のテストデータ
    const run = s.jobs.filter((x) => x.state === 'inprogress');
    assert.strictEqual(run.length, 4, '運送中の案件が4件あること');
    assert.ok(run.some((x) => x.eta != null), '移動中の案件はETAが出ること');
    // 当日便（軽トラ）: 軽トラのドライバーが最優先、大型車には警告
    const sd = s.jobs.find((x) => x.id === 'J-1005');
    assert.strictEqual(sd.sameDay, true);
    assert.strictEqual(sd.candidates[0].driverId, 'd4', '当日便は近くの軽トラが最優先');
    assert.ok(sd.candidates.find((c) => c.driverId === 'd1').items.some((i) => i.msg.includes('当日便に大型車')));
    // パワーゲート必須の案件: ゲートなしの10t車は不可、ゲート付きの4tは可
    const tl = await ok('POST', '/api/jobs', { shipperId: 'c1', pickupSiteId: 's1', dropoffSiteId: 's3', windowStart: new Date(Date.now() + 7200e3).toISOString(), truckType: 't4', body: 'van', pallets: 2, tailLift: true, cargo: 'tl' });
    s = await ok('GET', '/api/bootstrap');
    const tc = (id) => s.jobs.find((x) => x.id === tl.id).candidates.find((c) => c.driverId === id);
    assert.ok(tc('d1').items.some((i) => i.msg.includes('パワーゲート')), 'ゲートなしは不可');
    assert.ok(!tc('d2').items.some((i) => i.level === 'error'), 'ゲート付き4tは可');

    // 出発 -> 到着(位置で自動検知) -> 受付 -> 呼び出し -> 作業 -> 完了
    await ok('POST', '/api/jobs/J-1001/stops/0/depart', { by: 'driver' });
    const s1 = s.sites.find((x) => x.id === 's1');
    await ok('POST', '/api/drivers/d1/position', { lat: s1.lat, lng: s1.lng });
    let j = (await ok('GET', '/api/bootstrap')).jobs.find((x) => x.id === 'J-1001');
    assert.strictEqual(j.stops[0].stage, 'arrived', '到着が自動検知されること');
    await ok('POST', '/api/jobs/J-1001/stops/0/checkin', { by: 'driver' });
    r = await call('POST', '/api/jobs/J-1001/stops/0/call', { berth: 'ZZ' });
    assert.strictEqual(r.status, 400, '存在しないバースは拒否');
    await ok('POST', '/api/jobs/J-1001/stops/0/call', { berth: 'A2', by: 'shipper' });
    await ok('POST', '/api/jobs/J-1001/work-request', { idx: 0, key: 'w_seal_check', by: 'shipper' });
    await ok('POST', '/api/jobs/J-1001/stops/0/start', {});
    r = await call('POST', '/api/jobs/J-1001/stops/0/checkin', {});
    assert.strictEqual(r.status, 409, '不正な状態遷移は拒否');
    await ok('POST', '/api/jobs/J-1001/stops/0/done', { by: 'driver' });

    // 2か所目
    await ok('POST', '/api/jobs/J-1001/stops/1/depart', { by: 'driver' });
    const s3 = s.sites.find((x) => x.id === 's3');
    await ok('POST', '/api/drivers/d1/position', { lat: s3.lat, lng: s3.lng });
    await ok('POST', '/api/jobs/J-1001/stops/1/checkin', {});
    await ok('POST', '/api/jobs/J-1001/stops/1/call', { berth: 'D1' });
    await ok('POST', '/api/jobs/J-1001/stops/1/start', {});
    await ok('POST', '/api/jobs/J-1001/messages', { from: 'driver', key: 't_long_wait' });
    await ok('POST', '/api/jobs/J-1001/stops/1/done', { by: 'driver' });
    j = (await ok('GET', '/api/bootstrap')).jobs.find((x) => x.id === 'J-1001');
    assert.strictEqual(j.state, 'done');
    const trouble = j.messages.find((m) => m.kind === 'trouble');
    await ok('POST', `/api/jobs/J-1001/messages/${trouble.id}/resolve`, {});

    // 複数トラックへ同時に打診 → 催促 → 1台が受諾すると他は自動で取り消し
    await ok('POST', '/api/jobs/J-1004/assign', { driverId: 'd1' });
    await ok('POST', '/api/jobs/J-1004/assign', { driverId: 'd3' });
    r = await call('POST', '/api/jobs/J-1004/assign', { driverId: 'd3' });
    assert.strictEqual(r.status, 409, '同じトラックへの二重打診は拒否');
    await ok('POST', '/api/jobs/J-1004/offers/d3/nudge', {});
    let j4 = (await ok('GET', '/api/bootstrap')).jobs.find((x) => x.id === 'J-1004');
    assert.strictEqual(j4.offers.filter((o) => o.status === 'pending').length, 2);
    assert.strictEqual(j4.offers.find((o) => o.driverId === 'd3').nudges, 1);
    const nm = j4.messages.find((m) => m.kind === 'nudge');
    assert.ok(nm && nm.to === 'd3', '催促は対象ドライバー宛て');
    await ok('POST', '/api/jobs/J-1004/offers/d1/withdraw', {});
    await ok('POST', '/api/jobs/J-1004/assign', { driverId: 'd1' });
    await ok('POST', '/api/jobs/J-1004/respond', { accept: true, driverId: 'd3' });
    j4 = (await ok('GET', '/api/bootstrap')).jobs.find((x) => x.id === 'J-1004');
    assert.strictEqual(j4.driverId, 'd3'); assert.strictEqual(j4.state, 'accepted');
    assert.strictEqual(j4.offers.find((o) => o.driverId === 'd1').status, 'cancelled', '他の打診は自動取消');

    // AI打診: 条件に合う上位N台へ並行打診（手動のドラッグ打診と併用できる）
    const aj = await ok('POST', '/api/jobs', { shipperId: 'c1', pickupSiteId: 's1', dropoffSiteId: 's3', windowStart: new Date(Date.now() + 7200e3).toISOString(), truckType: 't10', body: 'van', pallets: 2, cargo: 'ai-test' });
    const ar = await ok('POST', `/api/jobs/${aj.id}/ai-offer`, { count: 3 });
    assert.strictEqual(ar.offered.length, 3, '3台に並行打診');
    let ajj = (await ok('GET', '/api/bootstrap')).jobs.find((x) => x.id === aj.id);
    assert.strictEqual(ajj.offers.filter((o) => o.status === 'pending' && o.by === 'ai').length, 3);
    assert.ok(ajj.offers[0].reason, 'AI打診には理由が付く');
    const manual = ar.offered.length < 8 ? (await ok('GET', '/api/bootstrap')).jobs.find((x) => x.id === aj.id).candidates.find((c) => !ar.offered.includes(c.driverId) && !c.items.some((i) => i.level === 'error')) : null;
    if (manual) { await ok('POST', `/api/jobs/${aj.id}/assign`, { driverId: manual.driverId }); }
    ajj = (await ok('GET', '/api/bootstrap')).jobs.find((x) => x.id === aj.id);
    assert.ok(ajj.offers.filter((o) => o.status === 'pending').length >= 3, 'AIと手動の並行打診');
    if (manual) assert.strictEqual(ajj.offers.find((o) => o.driverId === manual.driverId).by, 'manual');
    const st = await ok('POST', '/api/settings', { autoRespond: false });
    assert.strictEqual(st.autoRespond, false);

    // 新規依頼・拠点登録・定型文以外の拒否
    const nj = await ok('POST', '/api/jobs', { shipperId: 'c1', pickupSiteId: 's1', dropoffSiteId: 's2', windowStart: new Date(Date.now() + 7200e3).toISOString(), vehicleClass: 'medium', cargo: 'テスト', pickupWork: ['w_manual_load'], dropoffWork: [], pickupWh: { forklift: false, helper: true }, dropoffWh: { forklift: true, inspection: true }, tailLift: true, body: 'wing' });
    assert.strictEqual(nj.stops[0].warehouse.forklift, false);
    assert.strictEqual(nj.stops[1].warehouse.inspection, true);
    assert.strictEqual(nj.tailLift, true);
    assert.strictEqual(nj.state, 'open');
    await ok('POST', '/api/sites', { name: '試験拠点', lat: 35.6, lng: 139.7, berths: ['X1'], rules: ['r_helmet', 'bad'] });
    r = await call('POST', `/api/jobs/${nj.id}/messages`, { from: 'shipper', key: 'free text' });
    assert.strictEqual(r.status, 400, '自由記述は拒否');
    console.log('OK: smoke test passed');
  } catch (e) { console.error('FAIL:', e.message); process.exitCode = 1; }
  server.close(); setTimeout(() => process.exit(), 100);
});
