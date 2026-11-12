/* 配車・運行管理デスク（日本語）: 配車 / 地図監視 / アラート / 例外対応 / 法令チェック */
(function () {
  const { tr, icon, esc, fmtTime, fmtDate, api, GROUPS, LANGS } = SL;
  const $ = (id) => document.getElementById(id);
  const ja = (k, p) => tr(k, 'ja', p);
  let data = null, map = null, siteLayer = null;
  const markers = {};
  let dragging = null, pendingBoard = false; // 地図の車両マーカーをドラッグして配車する
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
    renderAlerts(); renderDrivers(); renderMap();
    if (dragging) pendingBoard = true; else renderBoard();
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
      let assign = '', dropAttr = '';
      if (j.state === 'open' || j.state === 'offered') {
        dropAttr = ` data-drop="${j.id}"`;
        const cands = j.candidates || [];
        const best = cands.find((c) => !c.items.some((i) => i.level === 'error'));
        const tagOf = (c) => c.items.some((i) => i.level === 'error') ? '✕不可' : c.mode === 'combine' ? '＋積合せ可' : c.mode === 'sequential' ? '→連続配車' : '◎空車';
        assign = `${best ? `<div class="small" style="margin-top:6px">おすすめ: <b>${esc(drv(best.driverId).name)}</b>（${best.mode === 'combine' ? '走行中の車両に積み合わせ' : best.mode === 'sequential' ? '現案件の完了後に連続配車' : '待機中の空車'}）</div>` : '<div class="small" style="margin-top:6px;color:var(--crit)">条件に合うドライバーがいません</div>'}
          <div class="small muted" style="margin-top:4px">${cands.map((c) => `${flag(drv(c.driverId))} ${esc(shortName(drv(c.driverId)))} ${tagOf(c)}`).join('　')}</div>
          <div class="drop-hint">🚚 地図の緑の車両マーカーをここへドラッグして${j.state === 'offered' ? '再割当' : '配車'}</div>`;
      }
      return `<div class="card"${dropAttr}><div class="row wrap"><b>${j.id}</b><span class="tag ${j.state}">${STATE_JA[j.state]}</span><span class="grow"></span>
        <span class="small muted">${fmtDate(j.windowStart)} ${fmtTime(j.windowStart)}–${fmtTime(j.windowEnd)}</span></div>
        <div class="small" style="margin:4px 0">${stops}</div><div class="small">必要車両: <b>${esc(data.trucks[j.truckType].label)}・${esc(data.bodies[j.body])}</b>・${j.pallets}枚${j.sameDay ? ' <span class="tag warn">⚡当日便</span>' : ''}</div><div class="small muted">${esc(j.cargo)}${d ? `／${flag(d)} ${esc(d.name)}` : ''}${j.eta != null ? `／到着まで約${j.eta}分` : ''}</div>${assign}</div>`;
    }).join('');
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
      const html = `<b>${esc(d.name)}</b><br>${esc(d.vehicle)}${job ? `<br>${job.id}（${STAGE_JA[job.stops[Math.max(job.activeStop, 0)].stage] || ''}）${job.eta != null ? `／約${job.eta}分` : ''}` : '<br>待機'}<br><span class="small">案件カードへドラッグして配車</span>`;
      const key = (job ? 'busy:' : 'idle:') + d.name;
      const ic = L.divIcon({ className: 'veh-icon', html: vehHtml(d, !!job), iconSize: [48, 58], iconAnchor: [24, 22] });
      const cur = markers[d.id];
      if (!cur) {
        const m = L.marker([d.lat, d.lng], { icon: ic, zIndexOffset: 1000 }).bindPopup(html).addTo(map);
        markers[d.id] = { m, key }; attachDrag(m, d.id);
      } else {
        if (!(dragging && dragging.driverId === d.id)) cur.m.setLatLng([d.lat, d.lng]);
        cur.m.setPopupContent(html);
        if (cur.key !== key) { cur.m.setIcon(ic); cur.key = key; attachDrag(cur.m, d.id); }
      }
    });
  }

  // ---------------- 車両マーカー（緑）をドラッグして案件カードへドロップ = 配車
  const shortName = (d) => d.name.replace(/（.*）/, '');
  function vehHtml(d, busy) {
    return `<div class="veh ${busy ? 'busy' : ''}"><div class="veh-badge"><svg viewBox="0 0 48 28" width="30" height="18" aria-hidden="true"><rect x="1" y="2" width="29" height="18" rx="2" fill="#0a1c3c"/><path d="M32 8h8l6 7v5H32z" fill="#0a1c3c"/><circle cx="11" cy="22" r="4.5" fill="#0a1c3c" stroke="#8ee37f" stroke-width="1.5"/><circle cx="37" cy="22" r="4.5" fill="#0a1c3c" stroke="#8ee37f" stroke-width="1.5"/></svg></div><div class="veh-name">${esc(shortName(d))}</div></div>`;
  }
  function notify(text, level) {
    const el = $('dtoast'); el.textContent = text; el.style.background = level === 'crit' ? 'var(--crit)' : ''; el.style.color = level === 'crit' ? '#3a0606' : '';
    el.classList.remove('hidden'); clearTimeout(notify.t); notify.t = setTimeout(() => el.classList.add('hidden'), 4000);
  }
  function tipHtml(jobId, driverId) {
    const j = data.jobs.find((x) => x.id === jobId), c = j && (j.candidates || []).find((x) => x.driverId === driverId);
    if (!c) return '';
    const mark = { error: '✕', warn: '⚠', info: 'ℹ' }, col = { error: 'var(--crit)', warn: 'var(--warn)', info: 'var(--green)' };
    const ng = c.items.some((i) => i.level === 'error');
    return `<b>${esc(shortName(drv(driverId)))} → ${esc(jobId)}</b>　${ng ? '<span style="color:var(--crit)">割当不可</span>' : '<span style="color:var(--green)">離して配車</span>'}` +
      c.items.map((i) => `<div style="color:${col[i.level]}">${mark[i.level]} ${esc(i.msg)}</div>`).join('');
  }
  async function dropAssign(jobId, driverId) {
    const j = data.jobs.find((x) => x.id === jobId), c = j && (j.candidates || []).find((x) => x.driverId === driverId);
    const errs = c ? c.items.filter((i) => i.level === 'error') : [];
    if (errs.length) { notify('✕ 割り当てできません: ' + errs.map((e) => e.msg).join(' / '), 'crit'); return; }
    try { await api('POST', `/api/jobs/${jobId}/assign`, { driverId }); notify(`${jobId} を ${shortName(drv(driverId))} に打診しました`); }
    catch (e) { notify('⚠️ ' + e.message, 'crit'); }
  }
  function attachDrag(marker, driverId) {
    const el = marker.getElement();
    if (!el) return;
    L.DomEvent.disableClickPropagation(el);
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); startDrag(driverId, e); });
  }
  function startDrag(driverId, e) {
    dragging = { driverId };
    const ghost = document.createElement('div'); ghost.className = 'veh-ghost'; ghost.innerHTML = vehHtml(drv(driverId), false); document.body.appendChild(ghost);
    const tip = $('dragtip');
    document.body.classList.add('dragging'); map.dragging.disable(); map.closePopup();
    const cardAt = (ev) => { const t = document.elementFromPoint(ev.clientX, ev.clientY); return t && t.closest ? t.closest('[data-drop]') : null; };
    const move = (ev) => {
      ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px';
      document.querySelectorAll('.drop-hover').forEach((x) => x.classList.remove('drop-hover'));
      const card = cardAt(ev);
      if (card) {
        card.classList.add('drop-hover'); tip.innerHTML = tipHtml(card.dataset.drop, driverId); tip.classList.remove('hidden');
        tip.style.left = Math.max(8, Math.min(ev.clientX + 18, window.innerWidth - 340)) + 'px'; tip.style.top = Math.max(8, Math.min(ev.clientY + 18, window.innerHeight - tip.offsetHeight - 8)) + 'px';
      } else tip.classList.add('hidden');
    };
    const end = async (ev, cancel) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancelUp);
      const card = cancel ? null : cardAt(ev);
      ghost.remove(); tip.classList.add('hidden'); document.body.classList.remove('dragging'); map.dragging.enable();
      document.querySelectorAll('.drop-hover').forEach((x) => x.classList.remove('drop-hover'));
      const jobId = card && card.dataset.drop;
      dragging = null; pendingBoard = false;
      if (jobId) await dropAssign(jobId, driverId);
      await load();
    };
    const up = (ev) => end(ev, false), cancelUp = (ev) => end(ev, true);
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancelUp);
    move(e);
  }

  async function act(fn) { try { await fn(); await load(); } catch (e) { alert(e.message); } }
  SL.stream(load);
  setInterval(() => { $('clock').textContent = new Date().toLocaleString('ja-JP'); }, 30000);
  load();
})();
