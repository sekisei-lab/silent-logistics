/* 荷主・拠点ポータル（日本語）: 依頼登録 / バース呼び出し / 作業依頼 / 現場ガイド登録 / 進捗確認 */
(function () {
  const { tr, icon, esc, fmtTime, fmtDate, api, GROUPS, LANGS } = SL;
  const $ = (id) => document.getElementById(id);
  let data = null, tab = 'jobs', shipperId = null;
  const keep = {}; // 再描画しても保持するUI状態（バース選択・作業チェック）

  const STAGE_JA = { pending: '待機', enroute: '移動中', arrived: '到着', checkedin: '受付済み', called: '呼び出し中', working: '作業中', done: '完了' };
  const STATE_JA = { open: 'ドライバー未定', offered: '打診中', accepted: '受諾済み', inprogress: '運行中', done: '完了' };
  const site = (id) => data.sites.find((s) => s.id === id);
  const drv = (id) => data.drivers.find((d) => d.id === id);
  const ja = (k, p) => tr(k, 'ja', p);

  async function load() {
    data = await api('GET', '/api/bootstrap');
    if (!shipperId) shipperId = data.shippers[0].id;
    $('shipper').innerHTML = data.shippers.map((s) => `<option value="${s.id}" ${s.id === shipperId ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    render();
  }
  function busy() { const a = document.activeElement; return a && ['INPUT', 'TEXTAREA'].includes(a.tagName) && a.type !== 'checkbox'; }

  function render() {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    if (tab === 'jobs') $('view').innerHTML = viewJobs();
    else if (tab === 'new') { if (!$('f_new')) $('view').innerHTML = viewNew(); }
    else if (tab === 'sites') { if (!$('f_site')) $('view').innerHTML = viewSites(); }
    bind();
  }

  // ---------------- 依頼・進捗
  function viewJobs() {
    const mine = data.jobs.filter((j) => j.shipperId === shipperId).sort((a, b) => (a.state === 'done') - (b.state === 'done') || a.windowStart.localeCompare(b.windowStart));
    if (!mine.length) return '<div class="card muted">依頼がありません。「輸送依頼を作成」から登録してください。</div>';
    return '<div class="grid2">' + mine.map(jobCard).join('') + '</div>';
  }

  function jobCard(j) {
    const d = j.driverId && drv(j.driverId);
    const lang = d && LANGS.find((l) => l.code === d.lang);
    const idx = j.activeStop;
    const stops = j.stops.map((s, i) => {
      const st = site(s.siteId);
      const eta = i === idx && j.eta != null ? `／到着まで約${j.eta}分（${j.distKm.toFixed(1)}km）` : '';
      return `<div class="stop ${i === idx && j.state !== 'done' ? 'active' : ''}"><div class="small muted">${s.type === 'pickup' ? '積込み' : '荷降ろし'}</div>
        <b>${esc(st.name)}</b><br><span class="tag ${s.stage === 'done' ? 'done' : s.stage === 'pending' ? '' : 'inprogress'}">${STAGE_JA[s.stage]}</span>
        ${s.checkinNo ? ` 受付 <b>${esc(s.checkinNo)}</b>` : ''}${s.berth ? ` バース <b>${esc(s.berth)}</b>` : ''}<span class="small muted">${eta}</span>
        ${s.photo ? '<br><span class="small">📷 写真あり</span>' : ''}</div>`;
    }).join('');
    let actions = '';
    if (idx >= 0 && j.state === 'inprogress') {
      const s = j.stops[idx], st = site(s.siteId);
      if (s.stage === 'checkedin') {
        const sel = keep['berth' + j.id] || st.berths[0];
        actions += `<div class="row wrap" style="margin-top:8px"><b>バースを指定して呼び出し</b>
          <select data-berth="${j.id}">${st.berths.map((b) => `<option ${b === sel ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
          <button class="btn primary" data-call="${j.id}" data-idx="${idx}">📣 呼び出す</button></div>`;
      }
      if (['arrived', 'checkedin', 'called', 'working'].includes(s.stage)) {
        const checked = keep['work' + j.id] || [];
        actions += `<details style="margin-top:8px"><summary><b>作業を依頼する（ドライバーに母国語で表示）</b></summary>
          <div class="checks">${GROUPS.work.map((k) => `<label><input type="checkbox" data-wk="${j.id}" value="${k}" ${checked.includes(k) ? 'checked' : ''}>${icon(k)} ${esc(ja(k))}</label>`).join('')}</div>
          <button class="btn" data-workreq="${j.id}" data-idx="${idx}">依頼を送信</button></details>`;
      }
      if (s.stage === 'working') actions += `<div style="margin-top:8px"><button class="btn ok" data-doneby="${j.id}" data-idx="${idx}">作業完了を確認</button></div>`;
    }
    const troubles = j.messages.filter((m) => m.kind === 'trouble' && !m.resolved).map((m) => `<div class="alert ${m.key === 't_sos' || m.key === 't_accident' ? 'crit' : 'warn'}">
        <span>${icon(m.key)} <b>${esc(ja(m.key))}</b> <span class="small">${fmtTime(m.ts)}</span></span>
        <span>${GROUPS.reply.slice(0, 5).map((k) => `<button class="btn" data-reply="${j.id}" data-key="${k}" data-mid="${m.id}" title="ドライバーへ母国語で送信">${icon(k)} ${esc(ja(k))}</button>`).join(' ')}</span></div>`).join('');
    const tl = j.timeline.slice(-6).reverse().map((e) => `<li>${fmtTime(e.ts)} <b>${esc(e.text)}</b></li>`).join('');
    return `<div class="card"><div class="row wrap"><b>${j.id}</b><span class="tag ${j.state}">${STATE_JA[j.state]}</span><span class="grow"></span>
      <span class="small muted">${fmtDate(j.windowStart)} ${fmtTime(j.windowStart)}–${fmtTime(j.windowEnd)}</span></div>
      <div class="small muted">${esc(j.cargo)}／${{ large: '大型', medium: '中型', small: '普通' }[j.vehicleClass]}車</div>
      <div style="margin:6px 0">${d ? `🚚 ${esc(d.name)}（${esc(d.vehicle)}）${lang ? lang.flag + ' ' + esc(lang.label) : ''}` : '<span class="muted">ドライバー調整中</span>'}</div>
      <div class="stops">${stops}</div>${troubles}${actions}
      <details style="margin-top:6px"><summary class="small muted">履歴</summary><ul class="timeline">${tl || '<li>なし</li>'}</ul></details></div>`;
  }

  // ---------------- 依頼作成
  function siteOptions(sel) { return data.sites.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join(''); }
  function workChecks(name, defaults) { return `<div class="checks">${GROUPS.work.map((k) => `<label><input type="checkbox" name="${name}" value="${k}" ${defaults.includes(k) ? 'checked' : ''}>${icon(k)} ${esc(ja(k))}</label>`).join('')}</div>`; }
  function viewNew() {
    const t = new Date(Date.now() + 2 * 3600e3); t.setMinutes(0, 0, 0);
    const local = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    return `<form class="card" id="f_new" style="max-width:760px"><h2 style="margin:0 0 6px">輸送依頼を作成</h2>
      <p class="small muted">積地・届け先の入口、待機場所、荷役条件は「拠点・現場ガイド」の登録内容が、ドライバーへ母国語で自動表示されます。</p>
      <div class="grid2"><label class="f">積地（積込み）<select name="pickupSiteId">${siteOptions('s1')}</select></label>
      <label class="f">届け先（荷降ろし）<select name="dropoffSiteId">${siteOptions('s3')}</select></label></div>
      <div class="grid2"><div><b class="small">積込みの作業</b>${workChecks('pickupWork', ['w_forklift_load'])}</div>
      <div><b class="small">荷降ろしの作業</b>${workChecks('dropoffWork', ['w_forklift_unload'])}</div></div>
      <div class="grid3"><label class="f">到着希望日時<input type="datetime-local" name="windowStart" value="${local}" required></label>
      <label class="f">車格<select name="vehicleClass"><option value="large">大型</option><option value="medium">中型</option><option value="small">普通</option></select></label>
      <label class="f">荷物の内容<input name="cargo" placeholder="例: 食品 パレット10枚" required></label></div>
      <button class="btn primary" type="submit">依頼を登録</button> <span id="newmsg" class="small"></span></form>`;
  }

  // ---------------- 拠点・現場ガイド
  function viewSites() {
    const rows = data.sites.map((s) => `<tr><td><b>${esc(s.name)}</b><br><span class="small muted">${esc(s.address)}</span></td>
      <td>${esc(s.berths.join(', '))}</td><td>${s.rules.map((r) => `${icon(r)} ${esc(ja(r))}`).join('<br>')}</td><td class="small">${esc(s.note)}</td></tr>`).join('');
    return `<div class="grid2"><div class="card"><h2 style="margin:0 0 6px">登録済みの拠点</h2><table><tr><th>拠点</th><th>バース</th><th>現場ルール（ドライバーへ母国語で表示）</th><th>メモ</th></tr>${rows}</table></div>
      <form class="card" id="f_site"><h2 style="margin:0 0 6px">拠点を登録</h2>
        <label class="f">拠点名<input name="name" required></label><label class="f">住所<input name="address"></label>
        <div class="grid2"><label class="f">緯度<input name="lat" type="number" step="any" placeholder="35.6812" required></label><label class="f">経度<input name="lng" type="number" step="any" placeholder="139.7671" required></label></div>
        <label class="f">バース（カンマ区切り）<input name="berths" placeholder="A1, A2, B1"></label>
        <b class="small">現場ルール</b><div class="checks">${GROUPS.rules.map((k) => `<label><input type="checkbox" name="rules" value="${k}">${icon(k)} ${esc(ja(k))}</label>`).join('')}</div>
        <label class="f">メモ（日本語・現場スタッフ向け）<textarea name="note" rows="2"></textarea></label>
        <button class="btn primary" type="submit">登録</button> <span id="sitemsg" class="small"></span></form></div>`;
  }

  // ---------------- イベント
  async function act(fn, msgEl) {
    try { await fn(); await load(); } catch (e) { if (msgEl) msgEl.textContent = '⚠️ ' + e.message; else alert(e.message); }
  }
  function bind() {
    document.querySelectorAll('[data-berth]').forEach((s) => { s.onchange = () => { keep['berth' + s.dataset.berth] = s.value; }; });
    document.querySelectorAll('[data-wk]').forEach((c) => {
      c.onchange = () => { keep['work' + c.dataset.wk] = Array.from(document.querySelectorAll(`[data-wk="${c.dataset.wk}"]:checked`)).map((x) => x.value); };
    });
    document.querySelectorAll('[data-call]').forEach((b) => {
      b.onclick = () => { const sel = document.querySelector(`[data-berth="${b.dataset.call}"]`); act(() => api('POST', `/api/jobs/${b.dataset.call}/stops/${b.dataset.idx}/call`, { berth: sel.value, by: 'shipper' })); };
    });
    document.querySelectorAll('[data-workreq]').forEach((b) => {
      b.onclick = () => {
        const keys = keep['work' + b.dataset.workreq] || [];
        if (!keys.length) return alert('作業を選んでください');
        keep['work' + b.dataset.workreq] = [];
        act(async () => { for (const k of keys) await api('POST', `/api/jobs/${b.dataset.workreq}/work-request`, { idx: Number(b.dataset.idx), key: k, by: 'shipper' }); });
      };
    });
    document.querySelectorAll('[data-doneby]').forEach((b) => { b.onclick = () => act(() => api('POST', `/api/jobs/${b.dataset.doneby}/stops/${b.dataset.idx}/done`, { by: 'shipper' })); });
    document.querySelectorAll('[data-reply]').forEach((b) => {
      b.onclick = () => act(async () => { await api('POST', `/api/jobs/${b.dataset.reply}/messages`, { from: 'shipper', key: b.dataset.key }); await api('POST', `/api/jobs/${b.dataset.reply}/messages/${b.dataset.mid}/resolve`, {}); });
    });
    const fn = $('f_new');
    if (fn) fn.onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(fn), g = (n) => f.getAll(n);
      const body = { shipperId, pickupSiteId: f.get('pickupSiteId'), dropoffSiteId: f.get('dropoffSiteId'), windowStart: f.get('windowStart'), vehicleClass: f.get('vehicleClass'), cargo: f.get('cargo'), pickupWork: g('pickupWork'), dropoffWork: g('dropoffWork') };
      act(async () => { await api('POST', '/api/jobs', body); tab = 'jobs'; $('view').innerHTML = ''; }, $('newmsg'));
    };
    const fs = $('f_site');
    if (fs) fs.onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(fs);
      const body = { name: f.get('name'), address: f.get('address'), lat: f.get('lat'), lng: f.get('lng'), berths: String(f.get('berths') || '').split(/[,、\s]+/), rules: f.getAll('rules'), note: f.get('note') };
      act(async () => { await api('POST', '/api/sites', body); $('view').innerHTML = ''; }, $('sitemsg'));
    };
  }

  $('shipper').onchange = (e) => { shipperId = e.target.value; render(); };
  document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; $('view').innerHTML = ''; render(); }; });
  SL.stream(() => { if (!busy()) load(); });
  load();
})();
