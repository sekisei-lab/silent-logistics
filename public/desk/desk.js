/* 配車・運行管理デスク（日本語）: 配車 / 地図監視 / アラート / 例外対応 / 法令チェック */
(function () {
  const { tr, icon, esc, fmtTime, fmtDate, api, GROUPS, LANGS } = SL;
  const $ = (id) => document.getElementById(id);
  const ja = (k, p) => tr(k, 'ja', p);
  let data = null, map = null, siteLayer = null;
  const markers = {};
  const keep = {}; // 配車の選択状態 { jobId: driverId }
  const STAGE_JA = { pending: '待機', enroute: '移動中', arrived: '到着', checkedin: '受付済み', called: '呼び出し中', working: '作業中', done: '完了' };
  const STATE_JA = { open: '未割当', offered: '打診中', accepted: '受諾済み', inprogress: '運行中', done: '完了' };
  const site = (id) => data.sites.find((s) => s.id === id);
  const drv = (id) => data.drivers.find((d) => d.id === id);
  const flag = (d) => (LANGS.find((l) => l.code === d.lang) || {}).flag || '';
  const LIC = { small: 1, medium: 2, large: 3 };
  const LIC_JA = { small: '普通', medium: '中型', large: '大型' };

  async function load() { data = await api('GET', '/api/bootstrap'); render(); }

  function render() {
    $('clock').textContent = new Date().toLocaleString('ja-JP');
    renderAlerts(); renderBoard(); renderDrivers(); renderMap();
  }

  // ---------------- アラート
  function renderAlerts() {
    const items = [];
    data.jobs.forEach((j) => {
      j.messages.filter((m) => m.kind === 'trouble' && !m.resolved).forEach((m) => {
        const d = drv(j.driverId);
        const crit = m.key === 't_sos' || m.key === 't_accident' || m.key === 't_sick';
        items.push({ level: crit ? 'crit' : 'warn', order: crit ? 0 : 1, html: `<span>${icon(m.key)} <b>${esc(j.id)} ${esc(d ? d.name : '')}: ${esc(ja(m.key))}</b> <span class="small">${fmtTime(m.ts)}</span></span>
          <span>${GROUPS.reply.map((k) => `<button class="btn" data-reply="${j.id}" data-key="${k}" data-mid="${m.id}">${icon(k)} ${esc(ja(k))}</button>`).join(' ')}
          <button class="btn" data-resolve="${j.id}" data-mid="${m.id}">対応済み</button></span>` });
      });
      if (j.state === 'inprogress' && j.eta != null && Date.now() + j.eta * 60000 > new Date(j.windowEnd).getTime()) {
        items.push({ level: 'warn', order: 2, html: `<span>⏰ <b>${esc(j.id)}</b> 到着予定が希望時間（${fmtTime(j.windowEnd)}）を超過する見込みです（到着まで約${j.eta}分）</span>` });
      }
      const s = j.activeStop >= 0 && j.stops[j.activeStop];
      if (s && s.stage === 'checkedin' && Date.now() - new Date(s.checkedinAt).getTime() > 20 * 60000) {
        items.push({ level: 'warn', order: 2, html: `<span>⏳ <b>${esc(j.id)}</b> ${esc(site(s.siteId).name)} で受付後20分以上待機しています</span>` });
      }
      if (j.state === 'open' && new Date(j.windowStart).getTime() - Date.now() < 2 * 3600e3) {
        items.push({ level: 'warn', order: 3, html: `<span>🚨 <b>${esc(j.id)}</b> 未割当（希望 ${fmtTime(j.windowStart)}）。早めに配車してください</span>` });
      }
    });
    data.drivers.forEach((d) => {
      const days = (new Date(d.residenceExpiry).getTime() - Date.now()) / 864e5;
      if (days < 90) items.push({ level: 'info', order: 4, html: `<span>🪪 ${esc(d.name)}: 在留期限まで残り${Math.ceil(days)}日（${esc(d.residenceExpiry)}）</span>` });
      if (d.dutyHours > 13) items.push({ level: 'warn', order: 2, html: `<span>🕒 ${esc(d.name)}: 本日の拘束が${d.dutyHours}hです</span>` });
    });
    items.sort((a, b) => a.order - b.order);
    $('alerts').innerHTML = items.length ? items.map((i) => `<div class="alert ${i.level}">${i.html}</div>`).join('') : '<div class="alert info">✅ 現在アラートはありません</div>';
    document.querySelectorAll('[data-reply]').forEach((b) => {
      b.onclick = () => act(async () => { await api('POST', `/api/jobs/${b.dataset.reply}/messages`, { from: 'desk', key: b.dataset.key }); await api('POST', `/api/jobs/${b.dataset.reply}/messages/${b.dataset.mid}/resolve`, {}); });
    });
    document.querySelectorAll('[data-resolve]').forEach((b) => { b.onclick = () => act(() => api('POST', `/api/jobs/${b.dataset.resolve}/messages/${b.dataset.mid}/resolve`, {})); });
  }

  // ---------------- 配車ボード
  function renderBoard() {
    const order = { open: 0, offered: 1, accepted: 2, inprogress: 3, done: 4 };
    const jobs = data.jobs.slice().sort((a, b) => order[a.state] - order[b.state] || a.windowStart.localeCompare(b.windowStart));
    $('board').innerHTML = '<h3 style="margin-top:0">案件ボード</h3>' + jobs.map((j) => {
      const d = j.driverId && drv(j.driverId);
      const stops = j.stops.map((s, i) => `${i ? ' → ' : ''}${esc(site(s.siteId).name)}${s.stage !== 'pending' ? `<span class="tag ${s.stage === 'done' ? 'done' : 'inprogress'}">${STAGE_JA[s.stage]}</span>` : ''}`).join('');
      let assign = '';
      if (j.state === 'open' || j.state === 'offered') {
        const cands = j.candidates || [];
        const cOf = (id) => cands.find((c) => c.driverId === id);
        const best = cands.find((c) => !c.items.some((i) => i.level === 'error'));
        const sel = keep[j.id] || (j.driverId || '');
        const cs = sel ? cOf(sel) : null;
        const hasErr = cs && cs.items.some((i) => i.level === 'error');
        const tagOf = (c) => c.items.some((i) => i.level === 'error') ? '✕不可' : c.mode === 'combine' ? '＋積合せ可' : c.mode === 'sequential' ? '→連続配車' : '◎空車';
        const col = { error: 'var(--crit)', warn: 'var(--warn)', info: 'var(--brand)' }, mark = { error: '✕', warn: '⚠', info: 'ℹ' };
        assign = `${best ? `<div class="small" style="margin-top:6px">おすすめ: <b>${esc(drv(best.driverId).name)}</b>（${best.mode === 'combine' ? '走行中の車両に積み合わせ' : best.mode === 'sequential' ? '現案件の完了後に連続配車' : '待機中の空車'}）</div>` : '<div class="small" style="margin-top:6px;color:var(--crit)">条件に合うドライバーがいません</div>'}
          <div class="row wrap" style="margin-top:6px"><select data-sel="${j.id}"><option value="">ドライバーを選択…</option>${cands.map((c) => {
            const x = drv(c.driverId);
            return `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${flag(x)} ${esc(x.name)}（${esc(x.vehicle)}）${tagOf(c)}</option>`;
          }).join('')}</select>
          <button class="btn primary" data-assign="${j.id}" ${sel && !hasErr ? '' : 'disabled'}>${j.state === 'offered' ? '再割当' : '割り当てて打診'}</button></div>
          ${(cs ? cs.items : []).map((c) => `<div class="small" style="color:${col[c.level]}">${mark[c.level]} ${esc(c.msg)}</div>`).join('')}`;
      }
      return `<div class="card"><div class="row wrap"><b>${j.id}</b><span class="tag ${j.state}">${STATE_JA[j.state]}</span><span class="grow"></span>
        <span class="small muted">${fmtDate(j.windowStart)} ${fmtTime(j.windowStart)}–${fmtTime(j.windowEnd)}</span></div>
        <div class="small" style="margin:4px 0">${stops}</div><div class="small">必要車両: <b>${esc(data.trucks[j.truckType].label)}・${esc(data.bodies[j.body])}</b>・${j.pallets}枚</div><div class="small muted">${esc(j.cargo)}${d ? `／${flag(d)} ${esc(d.name)}` : ''}${j.eta != null ? `／到着まで約${j.eta}分` : ''}</div>${assign}</div>`;
    }).join('');
    document.querySelectorAll('[data-sel]').forEach((s) => { s.onchange = () => { keep[s.dataset.sel] = s.value; renderBoard(); }; });
    document.querySelectorAll('[data-assign]').forEach((b) => { b.onclick = () => act(() => api('POST', `/api/jobs/${b.dataset.assign}/assign`, { driverId: keep[b.dataset.assign] })); });
  }

  // ---------------- ドライバー
  function renderDrivers() {
    $('drivers').innerHTML = '<table><tr><th>ドライバー</th><th>言語</th><th>車両・免許</th><th>在留期限</th><th>本日の拘束</th><th>状況</th></tr>' + data.drivers.map((d) => {
      const days = Math.ceil((new Date(d.residenceExpiry).getTime() - Date.now()) / 864e5);
      const job = d.activeJobId && data.jobs.find((j) => j.id === d.activeJobId);
      return `<tr><td><b>${esc(d.name)}</b></td><td>${flag(d)} ${esc((LANGS.find((l) => l.code === d.lang) || {}).label || '')}</td><td>${esc(d.vehicle)}<br><span class="small muted">${LIC_JA[d.license]}免許／最大${data.trucks[d.vehicleSpec.type].pallets}枚</span></td>
        <td>${esc(d.residenceExpiry)} ${days < 90 ? `<span class="tag warn">残り${days}日</span>` : ''}</td>
        <td>${d.dutyHours}h ${d.dutyHours > 13 ? '<span class="tag crit">超過</span>' : ''}</td>
        <td>${job ? `${job.id} ${STAGE_JA[job.stops[Math.max(job.activeStop, 0)].stage] || ''}` : '<span class="muted">待機</span>'}</td></tr>`;
    }).join('') + '</table><div class="small muted" style="margin-top:6px">拘束時間は初回出発からの経過で簡易計算（改善基準告示の目安: 1日13時間）。実運用では勤怠・デジタコと連携します。</div>';
  }

  // ---------------- 地図
  function renderMap() {
    if (!map) {
      map = L.map('map').setView([35.62, 139.75], 10);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' }).addTo(map);
      siteLayer = L.layerGroup().addTo(map);
    }
    siteLayer.clearLayers();
    data.sites.forEach((s) => {
      L.marker([s.lat, s.lng], { icon: L.divIcon({ className: 'site-icon', html: '🏭', iconSize: [24, 24] }) }).bindPopup(`<b>${esc(s.name)}</b><br>${esc(s.address)}<br>バース: ${esc(s.berths.join(', '))}`).addTo(siteLayer);
    });
    data.drivers.forEach((d) => {
      const job = d.activeJobId && data.jobs.find((j) => j.id === d.activeJobId);
      const html = `<b>${esc(d.name)}</b><br>${esc(d.vehicle)}${job ? `<br>${job.id}（${STAGE_JA[job.stops[Math.max(job.activeStop, 0)].stage] || ''}）${job.eta != null ? `／約${job.eta}分` : ''}` : '<br>待機'}`;
      if (markers[d.id]) { markers[d.id].setLatLng([d.lat, d.lng]).setPopupContent(html); }
      else markers[d.id] = L.marker([d.lat, d.lng], { icon: L.divIcon({ className: 'truck-icon', html: '<img src="/truck.svg" alt="" style="width:56px;display:block">', iconSize: [56, 26], iconAnchor: [28, 13] }) }).bindPopup(html).addTo(map);
    });
  }

  async function act(fn) { try { await fn(); await load(); } catch (e) { alert(e.message); } }
  SL.stream(load);
  setInterval(() => { $('clock').textContent = new Date().toLocaleString('ja-JP'); }, 30000);
  load();
})();
