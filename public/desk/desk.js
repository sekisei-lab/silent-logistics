/* 配車・運行管理デスク（日本語）: 配車 / 地図監視 / アラート / 例外対応 / 法令チェック */
(function () {
  const { tr, icon, esc, fmtTime, fmtDate, api, GROUPS, LANGS } = SL;
  const $ = (id) => document.getElementById(id);
  const ja = (k, p) => tr(k, 'ja', p);
  let data = null, map = null, siteLayer = null;
  const markers = {};
  const aiCount = {}; // AI打診の台数 { jobId: n }
  const nudgeSel = {}; // 催促・取り下げ用に選択したトラック { jobId: Set(driverId) }
  let alertsOpen = false;
  let selectedJob = null, routeLayer = null; // 案件カードで選択中の案件（出発地→到着地を地図に表示）
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
    renderAlerts(); renderDrivers(); renderMap(); drawRoute(false);
    if (dragging) pendingBoard = true; else renderBoard();
  }

  // ---------------- アラート
  function renderAlerts() {
    const items = [];
    data.jobs.forEach((j) => {
      j.messages.filter((m) => m.kind === 'trouble' && !m.resolved).forEach((m) => {
        const d = drv(j.driverId);
        const crit = m.key === 't_sos' || m.key === 't_accident' || m.key === 't_sick';
        items.push({ job: j.id, level: crit ? 'crit' : 'warn', order: crit ? 0 : 1, html: `<span>${icon(m.key)} <b>${esc(j.id)} ${esc(d ? d.name : '')}: ${esc(ja(m.key))}</b> <span class="small">${fmtTime(m.ts)}</span></span>
          <span>${GROUPS.reply.map((k) => `<button class="btn" data-reply="${j.id}" data-key="${k}" data-mid="${m.id}">${icon(k)} ${esc(ja(k))}</button>`).join(' ')}
          <button class="btn" data-resolve="${j.id}" data-mid="${m.id}">対応済み</button></span>` });
      });
      if (j.state === 'inprogress' && j.eta != null && Date.now() + j.eta * 60000 > new Date(j.windowEnd).getTime()) {
        items.push({ job: j.id, level: 'warn', order: 2, html: `<span>⏰ <b>${esc(j.id)}</b> 到着予定が希望時間（${fmtTime(j.windowEnd)}）を超過する見込みです（到着まで約${j.eta}分）</span>` });
      }
      const s = j.activeStop >= 0 && j.stops[j.activeStop];
      if (s && s.stage === 'checkedin' && Date.now() - new Date(s.checkedinAt).getTime() > 20 * 60000) {
        items.push({ job: j.id, level: 'warn', order: 2, html: `<span>⏳ <b>${esc(j.id)}</b> ${esc(site(s.siteId).name)} で受付後20分以上待機しています</span>` });
      }
      if (j.state === 'open' && new Date(j.windowStart).getTime() - Date.now() < 2 * 3600e3) {
        items.push({ job: j.id, level: 'warn', order: 3, html: `<span>🚨 <b>${esc(j.id)}</b> 未割当（希望 ${fmtTime(j.windowStart)}）。早めに配車してください</span>` });
      }
    });
    data.drivers.forEach((d) => {
      const days = (new Date(d.residenceExpiry).getTime() - Date.now()) / 864e5;
      if (days < 90) items.push({ level: 'info', order: 4, html: `<span>🪪 ${esc(d.name)}: 在留期限まで残り${Math.ceil(days)}日（${esc(d.residenceExpiry)}）</span>` });
      if (d.dutyHours > 13) items.push({ level: 'warn', order: 2, html: `<span>🕒 ${esc(d.name)}: 本日の拘束が${d.dutyHours}hです</span>` });
    });
    items.sort((a, b) => a.order - b.order);
    const cnt = { crit: 0, warn: 0, info: 0 }; items.forEach((i) => { cnt[i.level] = (cnt[i.level] || 0) + 1; });
    const worst = cnt.crit ? 'crit' : cnt.warn ? 'warn' : 'info';
    const tmp = document.createElement('div'); tmp.innerHTML = items.length ? items[0].html : '';
    const first = items.length ? (tmp.querySelector('span') || tmp).textContent.trim() : '';
    $('alerts').innerHTML = items.length
      ? `<div class="alertbar ${worst}" data-alerts-toggle><b class="cnt">⚠ ${items.length}件</b><span class="small">${cnt.crit ? `重大${cnt.crit} ` : ''}${cnt.warn ? `注意${cnt.warn} ` : ''}${cnt.info ? `情報${cnt.info}` : ''}</span><span class="txt">${esc(first)}</span><span>${alertsOpen ? '▲ 閉じる' : '▼ 一覧'}</span></div>
         <div class="alertpanel ${alertsOpen ? '' : 'hidden'}">${items.map((i) => `<div class="alert ${i.level} ${i.job ? 'jump' : ''}"${i.job ? ` data-jump="${i.job}" title="クリックで案件ボードと地図に表示"` : ''}>${i.html}</div>`).join('')}</div>`
      : '<div class="alertbar info"><b class="cnt">✅ アラートなし</b></div>';
    document.querySelectorAll('.alert[data-jump]').forEach((el) => {
      el.onclick = (e) => { if (e.target.closest('button')) return; jumpToJob(el.dataset.jump); };
    });
    const tg = document.querySelector('[data-alerts-toggle]');
    if (tg) tg.onclick = (e) => { if (e.target.closest('button')) return; alertsOpen = !alertsOpen; renderAlerts(); };
    document.querySelectorAll('[data-reply]').forEach((b) => {
      b.onclick = () => act(async () => { await api('POST', `/api/jobs/${b.dataset.reply}/messages`, { from: 'desk', key: b.dataset.key }); await api('POST', `/api/jobs/${b.dataset.reply}/messages/${b.dataset.mid}/resolve`, {}); });
    });
    document.querySelectorAll('[data-resolve]').forEach((b) => { b.onclick = () => act(() => api('POST', `/api/jobs/${b.dataset.resolve}/messages/${b.dataset.mid}/resolve`, {})); });
  }

  // アラートの案件をクリック → 案件ボードで選択・スクロールし、地図にルートを表示
  function jumpToJob(id) {
    selectedJob = id; alertsOpen = false;
    renderAlerts(); renderBoard(); renderMap(); drawRoute(true);
    const card = document.querySelector(`.job-card[data-job="${id}"]`), bd = $('board');
    if (card) {
      bd.scrollTop = Math.max(0, card.offsetTop - 48);
      card.classList.add('flash'); setTimeout(() => card.classList.remove('flash'), 1600);
    }
  }

  // ---------------- 配車ボード
  function renderBoard() {
    const order = { open: 0, offered: 1, accepted: 2, inprogress: 3, done: 4 };
    const jobs = data.jobs.slice().sort((a, b) => order[a.state] - order[b.state] || a.windowStart.localeCompare(b.windowStart));
    const boardEl = $('board'), scrollTop = boardEl.scrollTop;
    boardEl.innerHTML = `<div class="board-title row wrap"><h3 style="margin:0">案件ボード</h3><span class="grow"></span><button class="btn ai-btn" data-ai-all title="未割当の案件すべてに、上位3台へ並行打診">🤖 未割当すべてにAI打診</button><label class="small" title="デモ用: 打診されたドライバーが数秒後に自動で受諾／辞退します"><input type="checkbox" data-autoresp ${data.settings && data.settings.autoRespond ? 'checked' : ''}> デモ自動応答</label></div>` + jobs.map((j) => {
      const d = j.driverId && drv(j.driverId);
      const stops = j.stops.map((s, i) => `${i ? ' → ' : ''}${esc(site(s.siteId).name)}${s.stage !== 'pending' ? `<span class="tag ${s.stage === 'done' ? 'done' : 'inprogress'}">${STAGE_JA[s.stage]}</span>` : ''}`).join('');
      let assign = '', dropAttr = '';
      if (j.state === 'open' || j.state === 'offered') {
        dropAttr = ` data-drop="${j.id}"`;
        const offers = j.offers || [], pend = offers.filter((o) => o.status === 'pending');
        const selSet = nudgeSel[j.id] || (nudgeSel[j.id] = new Set());
        pend.forEach(() => {}); [...selSet].forEach((id) => { if (!pend.some((o) => o.driverId === id)) selSet.delete(id); });
        const done = { declined: '辞退', cancelled: '他が受諾', withdrawn: '取下げ', accepted: '受諾' };
        assign = (offers.length ? `<div class="offers">${offers.map((o) => {
          const x = drv(o.driverId);
          if (o.status === 'pending') {
            const mins = Math.max(0, Math.round((Date.now() - new Date(o.ts).getTime()) / 60000));
            return `<label class="offer-chip ${o.by === 'ai' ? 'ai' : ''}" title="${esc(o.reason || (o.by === 'ai' ? '' : '手動で打診'))}"><input type="checkbox" data-nsel="${j.id}" value="${o.driverId}" ${selSet.has(o.driverId) ? 'checked' : ''}> ${o.by === 'ai' ? '🤖' : '🚚'} ${esc(shortName(x))} <span class="small">${o.by === 'ai' ? 'AI・' : ''}打診中・${mins}分${o.nudges ? `・催促${o.nudges}回` : ''}</span></label>`;
          }
          return `<span class="offer-chip done">${esc(shortName(x))} ${done[o.status] || o.status}</span>`;
        }).join('')}</div>` : '') +
          (pend.length ? `<div class="row wrap" style="margin-top:6px"><span class="small muted">並行打診 ${pend.length}台（AI ${pend.filter((o) => o.by === 'ai').length}／手動 ${pend.filter((o) => o.by !== 'ai').length}）</span>
            <button class="btn" data-nall="${j.id}">全て選択</button>
            <button class="btn primary" data-nudge="${j.id}" ${selSet.size ? '' : 'disabled'}>⏰ 選択したトラックに催促（${selSet.size}）</button>
            <button class="btn" data-withdraw="${j.id}" ${selSet.size ? '' : 'disabled'}>打診を取り下げ</button></div>` : '') +
          `<div class="row wrap" style="margin-top:6px"><button class="btn ai-btn" data-ai="${j.id}">🤖 AI打診</button>
            <select data-aicount="${j.id}" title="一度に打診する台数">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${(aiCount[j.id] || 3) === n ? 'selected' : ''}>上位${n}台</option>`).join('')}</select>
            <span class="small muted">条件に合う順に並行打診</span></div>
          <div class="drop-hint">🚚 または地図の緑の車両マーカーをここへドラッグして手動で打診</div>`;
      }
      return `<div class="card job-card ${selectedJob === j.id ? 'selected' : ''}" data-job="${j.id}"${dropAttr}><div class="row wrap"><b>${j.id}</b><span class="tag ${j.state}">${STATE_JA[j.state]}</span><span class="grow"></span>
        <span class="small muted">${fmtDate(j.windowStart)} ${fmtTime(j.windowStart)}–${fmtTime(j.windowEnd)}</span></div>
        <div class="small" style="margin:4px 0">${stops}</div><div class="small">必要車両: <b>${esc(data.trucks[j.truckType].label)}・${esc(data.bodies[j.body])}</b>・${j.pallets}枚${j.sameDay ? ' <span class="tag warn">⚡当日便</span>' : ''}</div><div class="small muted">${esc(j.cargo)}${d ? `／${flag(d)} ${esc(d.name)}` : ''}${j.eta != null ? `／到着まで約${j.eta}分` : ''}</div>${assign}</div>`;
    }).join('');
    boardEl.scrollTop = scrollTop;
    document.querySelectorAll('#board .job-card').forEach((c) => {
      c.onclick = (e) => {
        if (e.target.closest('button, input, label, a, select')) return;
        selectedJob = selectedJob === c.dataset.job ? null : c.dataset.job;
        renderBoard(); renderMap(); drawRoute(true);
      };
    });
    document.querySelectorAll('[data-aicount]').forEach((x) => { x.onchange = () => { aiCount[x.dataset.aicount] = Number(x.value); }; });
    document.querySelectorAll('[data-ai]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.ai;
        try {
          const r = await api('POST', `/api/jobs/${id}/ai-offer`, { count: aiCount[id] || 3 });
          notify(`🤖 ${id}: ${r.offered.length}台に並行打診しました（${r.offered.map((d) => shortName(drv(d))).join('・')}）`);
          selectedJob = id;
        } catch (e) { notify('⚠️ ' + e.message, 'crit'); }
        await load();
      };
    });
    const allBtn = document.querySelector('[data-ai-all]');
    if (allBtn) allBtn.onclick = async () => {
      try {
        const r = await api('POST', '/api/ai-offer-all', { count: 3 });
        const n = r.results.reduce((a, x) => a + x.offered.length, 0);
        notify(r.results.length ? `🤖 ${r.results.length}件の案件に、のべ${n}台へ並行打診しました` : '打診できる未割当の案件がありません', r.results.length ? undefined : 'crit');
      } catch (e) { notify('⚠️ ' + e.message, 'crit'); }
      await load();
    };
    const ar = document.querySelector('[data-autoresp]');
    if (ar) ar.onchange = async () => { await api('POST', '/api/settings', { autoRespond: ar.checked }); notify(ar.checked ? 'デモ自動応答: オン（打診されたドライバーが数秒後に受諾／辞退します）' : 'デモ自動応答: オフ'); await load(); };
    document.querySelectorAll('[data-nsel]').forEach((c) => {
      c.onchange = () => { const set = nudgeSel[c.dataset.nsel] || (nudgeSel[c.dataset.nsel] = new Set()); if (c.checked) set.add(c.value); else set.delete(c.value); renderBoard(); };
    });
    document.querySelectorAll('[data-nall]').forEach((b) => {
      b.onclick = () => { const j = data.jobs.find((x) => x.id === b.dataset.nall); nudgeSel[j.id] = new Set((j.offers || []).filter((o) => o.status === 'pending').map((o) => o.driverId)); renderBoard(); };
    });
    document.querySelectorAll('[data-nudge]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.nudge, ids = [...(nudgeSel[id] || [])];
        try { for (const dId of ids) await api('POST', `/api/jobs/${id}/offers/${dId}/nudge`, {}); notify(`${ids.length}台に回答を催促しました`); nudgeSel[id] = new Set(); } catch (e) { notify('⚠️ ' + e.message, 'crit'); }
        await load();
      };
    });
    document.querySelectorAll('[data-withdraw]').forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.withdraw, ids = [...(nudgeSel[id] || [])];
        try { for (const dId of ids) await api('POST', `/api/jobs/${id}/offers/${dId}/withdraw`, {}); notify(`${ids.length}台への打診を取り下げました`); nudgeSel[id] = new Set(); } catch (e) { notify('⚠️ ' + e.message, 'crit'); }
        await load();
      };
    });
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
      const offered = data.jobs.some((x) => x.state === 'offered' && (x.offers || []).some((o) => o.driverId === d.id && o.status === 'pending'));
      const sj = selectedJob && data.jobs.find((x) => x.id === selectedJob);
      const dist = sj ? Math.round(kmBetween(d, site(sj.stops[0].siteId))) : null;
      const key = (job ? 'busy:' : 'idle:') + (offered ? 'off:' : '') + (dist != null ? 'd' + dist + ':' : '') + d.name;
      const ic = L.divIcon({ className: 'veh-icon', html: vehHtml(d, !!job, offered, dist), iconSize: [48, 90], iconAnchor: [24, 22] });
      const cur = markers[d.id];
      if (!cur) {
        const m = L.marker([d.lat, d.lng], { icon: ic, zIndexOffset: 1000 }).bindPopup(html).addTo(map);
        markers[d.id] = { m, key }; attachDrag(m, d.id);
      } else {
        if (!(dragging && dragging.driverId === d.id)) cur.m.setLatLng([d.lat, d.lng]);
        cur.m.setPopupContent(html);
        if (cur.key !== key && !dragging) { cur.m.setIcon(ic); cur.key = key; attachDrag(cur.m, d.id); }
      }
    });
  }

  // ---------------- 案件の出発地→到着地ルート（住所はダミーのため、ルートは直線を曲げた概略）
  function kmBetween(a, b) {
    const R = 6371, rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function curve(a, b) {
    const mx = (a.lat + b.lat) / 2, my = (a.lng + b.lng) / 2, dx = b.lat - a.lat, dy = b.lng - a.lng;
    const cx = mx - dy * 0.18, cy = my + dx * 0.18, pts = [];
    for (let i = 0; i <= 28; i++) { const t = i / 28; pts.push([(1 - t) ** 2 * a.lat + 2 * (1 - t) * t * cx + t * t * b.lat, (1 - t) ** 2 * a.lng + 2 * (1 - t) * t * cy + t * t * b.lng]); }
    return pts;
  }
  function drawRoute(fit) {
    if (!map) return;
    if (!routeLayer) routeLayer = L.layerGroup().addTo(map);
    routeLayer.clearLayers();
    const j = selectedJob && data.jobs.find((x) => x.id === selectedJob);
    if (!j) return;
    const A = site(j.stops[0].siteId), B = site(j.stops[1].siteId), pts = curve(A, B);
    L.polyline(pts, { color: '#0a1c3c', weight: 9, opacity: 0.85 }).addTo(routeLayer);
    L.polyline(pts, { color: '#8ee37f', weight: 5, opacity: 1 }).addTo(routeLayer);
    const i = Math.floor(pts.length * 0.55), p0 = pts[i - 1], p1 = pts[i + 1];
    const ang = (Math.atan2((p1[1] - p0[1]) * Math.cos((pts[i][0] * Math.PI) / 180), p1[0] - p0[0]) * 180) / Math.PI; // 北=0°の方位
    L.marker(pts[i], { interactive: false, icon: L.divIcon({ className: 'veh-icon', html: `<svg width="22" height="22" viewBox="0 0 22 22" style="transform:rotate(${ang}deg)"><path d="M11 2 L19 19 L11 15 L3 19 Z" fill="#8ee37f" stroke="#0a1c3c" stroke-width="1.5"/></svg>`, iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(routeLayer);
    const pin = (s, kind, label) => L.marker([s.lat, s.lng], { zIndexOffset: 500, icon: L.divIcon({ className: 'veh-icon', html: `<div class="pin"><div class="pin-dot ${kind}">${kind === 'a' ? '出' : '着'}</div><div class="pin-label">${label} ${esc(s.name.replace(/^デモ/, ''))}</div></div>`, iconSize: [10, 10], iconAnchor: [15, 15] }) }).addTo(routeLayer);
    pin(A, 'a', '出発'); pin(B, 'b', '到着');
    const d = j.driverId && drv(j.driverId);
    if (d && j.activeStop >= 0 && j.state === 'inprogress') {
      const t = site(j.stops[j.activeStop].siteId);
      L.polyline([[d.lat, d.lng], [t.lat, t.lng]], { color: '#f5b83d', weight: 2, dashArray: '6 6' }).addTo(routeLayer);
    }
    if (fit) map.fitBounds(L.latLngBounds(pts), { padding: [90, 90], maxZoom: 13 });
  }

  // ---------------- 車両マーカー（緑）をドラッグして案件カードへドロップ = 配車
  const shortName = (d) => d.name.replace(/（.*）/, '');
  function vehHtml(d, busy, offered, dist) {
    return `<div class="veh ${busy ? 'busy' : ''} ${offered ? 'offered' : ''}"><div class="veh-badge"><svg viewBox="0 0 48 28" width="30" height="18" aria-hidden="true"><rect x="1" y="2" width="29" height="18" rx="2" fill="#0a1c3c"/><path d="M32 8h8l6 7v5H32z" fill="#0a1c3c"/><circle cx="11" cy="22" r="4.5" fill="#0a1c3c" stroke="#8ee37f" stroke-width="1.5"/><circle cx="37" cy="22" r="4.5" fill="#0a1c3c" stroke="#8ee37f" stroke-width="1.5"/></svg></div><div class="veh-name">${esc(shortName(d))}</div>${offered ? '<div class="veh-flag">打診中</div>' : ''}${dist != null ? `<div class="veh-dist">出発地まで${dist}km</div>` : ''}</div>`;
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
    let lastY = null, lastX = null;
    const auto = setInterval(() => {
      if (lastY == null) return;
      const br = $('board').getBoundingClientRect();
      if (lastX < br.left || lastX > br.right) return;
      if (lastY < br.top + 60 && lastY > br.top - 20) $('board').scrollTop -= 14;
      else if (lastY > br.bottom - 60 && lastY < br.bottom + 20) $('board').scrollTop += 14;
    }, 30);
    const move = (ev) => {
      lastX = ev.clientX; lastY = ev.clientY;
      ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px';
      document.querySelectorAll('.drop-hover').forEach((x) => x.classList.remove('drop-hover'));
      const card = cardAt(ev);
      if (card) {
        card.classList.add('drop-hover'); tip.innerHTML = tipHtml(card.dataset.drop, driverId); tip.classList.remove('hidden');
        tip.style.left = Math.max(8, Math.min(ev.clientX + 18, window.innerWidth - 340)) + 'px'; tip.style.top = Math.max(8, Math.min(ev.clientY + 18, window.innerHeight - tip.offsetHeight - 8)) + 'px';
      } else tip.classList.add('hidden');
    };
    const end = async (ev, cancel) => {
      clearInterval(auto);
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
