/* ドライバーアプリ: 会話なしで完結する、母国語＋絵記号UI */
(function () {
  const { tr, icon, esc, fmtTime, api, LANGS, GROUPS, whKeys } = SL;
  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  let data = null, meId = store.get('sl_driver'), lang = store.get('sl_lang'), view = 'main';
  let seenMsgs = JSON.parse(store.get('sl_seen') || '{}');
  let lastMsgCount = null, watchId = null, lastPosSent = 0;

  const T = (k, p) => tr(k, lang, p);
  const me = () => data && data.drivers.find((d) => d.id === meId);
  const siteOf = (id) => data.sites.find((s) => s.id === id);
  const jobs = () => data.jobs.filter((j) => j.driverId === meId);

  function toast(text) {
    const el = $('toast'); el.textContent = text; el.classList.remove('hidden');
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), 2200);
  }
  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    const l = LANGS.find((x) => x.code === lang);
    const u = new SpeechSynthesisUtterance(text); u.lang = l ? l.speech : 'en-US';
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
  function beep() {
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) { /* ignore */ }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(); o.frequency.value = 880; o.connect(ctx.destination);
      o.start(); setTimeout(() => { o.stop(); ctx.close(); }, 250);
    } catch (e) { /* ignore */ }
  }

  async function load() {
    data = await api('GET', '/api/bootstrap');
    const d = me();
    if (d) {
      if (!lang) lang = d.lang;
      const all = allMessages();
      if (lastMsgCount !== null && all.length > lastMsgCount) beep();
      lastMsgCount = all.length;
      startGps();
    }
    render();
  }

  function allMessages() {
    const out = [];
    jobs().forEach((j) => j.messages.forEach((m) => { if (m.from !== 'driver') out.push(Object.assign({ jobId: j.id }, m)); }));
    return out.sort((a, b) => b.ts.localeCompare(a.ts));
  }
  function unreadCount() { return allMessages().filter((m) => !seenMsgs[m.id]).length; }
  function markSeen() { allMessages().forEach((m) => { seenMsgs[m.id] = 1; }); store.set('sl_seen', JSON.stringify(seenMsgs)); }

  // ---- GPS共有（許可されない場合はサーバー側のデモ移動で補う）
  function startGps() {
    if (watchId !== null || !('geolocation' in navigator)) return;
    try {
      watchId = navigator.geolocation.watchPosition((pos) => {
        const now = Date.now();
        const active = jobs().some((j) => j.state === 'inprogress');
        if (!active || now - lastPosSent < 5000) return;
        lastPosSent = now;
        api('POST', `/api/drivers/${meId}/position`, { lat: pos.coords.latitude, lng: pos.coords.longitude }).catch(() => {});
      }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
    } catch (e) { /* ignore */ }
  }

  // ---- 描画
  function pictGrid(keys, reqKeys) {
    return '<div class="pict">' + keys.map((k) => `<div class="p ${reqKeys && reqKeys.includes(k) ? 'req' : ''}"><span class="ic">${icon(k)}</span><span class="tx">${esc(T(k))}</span></div>`).join('') + '</div>';
  }
  function topbar() {
    const d = me();
    return `<div class="topbar"><div class="who">${esc(d ? d.name : '')}${d ? ' <span class="status-dot"></span>' : ''}
      <button class="btn" data-switch="1" style="margin-left:6px;padding:4px 10px" title="Demo: switch driver">👤⇄</button></div>
      <div class="langs">${LANGS.map((l) => `<button data-lang="${l.code}" class="${l.code === lang ? 'on' : ''}" title="${esc(l.label)}">${l.flag}</button>`).join('')}</div></div>`;
  }

  function render() {
    const app = $('app'), bar = $('bar');
    if (!meId || !me()) {
      bar.classList.add('hidden');
      lang = lang || 'en';
      app.innerHTML = `<div class="topbar"><div class="who">🚚</div><div class="langs">${LANGS.map((l) => `<button data-lang="${l.code}" class="${l.code === lang ? 'on' : ''}">${l.flag}</button>`).join('')}</div></div>
        <h2>${esc(T('ui_select_driver'))}</h2>` +
        data.drivers.map((d) => `<button class="driver-pick" data-pick="${d.id}"><span class="fl">${LANGS.find((l) => l.code === d.lang).flag}</span><span>${esc(d.name)}<br><span class="muted small">${esc(d.vehicle)}</span></span></button>`).join('');
      bindCommon();
      return;
    }
    bar.classList.remove('hidden');
    const unread = unreadCount();
    bar.innerHTML = `<button data-nav="main">🚚<br>${esc(T('ui_current'))}</button>
      <button data-nav="messages">💬<br>${esc(T('ui_messages'))}${unread ? `<span class="badge">${unread}</span>` : ''}</button>
      <button data-nav="help" class="sos">🆘<br>${esc(T('ui_help'))}</button>`;
    app.innerHTML = topbar() + (view === 'messages' ? viewMessages() : view === 'help' ? viewHelp() : viewMain());
    bindCommon();
  }

  function viewMain() {
    const mine = jobs();
    const offers = mine.filter((j) => j.state === 'offered');
    const active = mine.find((j) => j.state === 'accepted' || j.state === 'inprogress');
    let html = '';
    offers.forEach((j) => { html += offerCard(j); });
    if (active) html += activeCard(active);
    if (!offers.length && !active) {
      const done = mine.filter((j) => j.state === 'done').length;
      html += `<div class="card" style="text-align:center"><div style="font-size:48px">${done ? '🎉' : '🕒'}</div><h2>${esc(done ? T('ui_job_done') : T('ui_jobs_none'))}</h2></div>`;
    }
    return html;
  }

  function whCard(s, boxed) {
    const inner = `<b>${icon('ui_wh_side')} ${esc(T('ui_wh_side'))}</b>${pictGrid(whKeys(s.warehouse))}`;
    return boxed ? `<div class="card">${inner}</div>` : `<div class="muted small">${icon('ui_wh_side')} ${esc(T('ui_wh_side'))}</div>${pictGrid(whKeys(s.warehouse))}`;
  }
  function stopSummary(j, s, withWork) {
    const st = siteOf(s.siteId);
    return `<div class="row wrap"><span class="stage-chip">${icon(s.type === 'pickup' ? 'ui_pickup' : 'ui_dropoff')} ${esc(T(s.type === 'pickup' ? 'ui_pickup' : 'ui_dropoff'))}</span></div>
      <h2 style="margin-top:6px">${esc(st.name)}</h2>${withWork ? whCard(s, false) + (s.work.length ? `<div class="muted small">${icon('ui_driver_work')} ${esc(T('ui_driver_work'))}</div>` + pictGrid(s.work, s.workRequests.map((r) => r.key)) : '') : ''}`;
  }

  function offerCard(j) {
    const p = j.stops[0], d = j.stops[1];
    return `<div class="card"><span class="stage-chip">${icon('ui_jobs_new')} ${esc(T('ui_jobs_new'))}</span>
      ${stopSummary(j, p, true)}
      <div class="sep"></div>
      ${stopSummary(j, d, true)}
      <div class="row wrap muted" style="margin:6px 0">${icon('ui_time')} ${esc(fmtTime(j.windowStart))}–${esc(fmtTime(j.windowEnd))} &nbsp; ${icon('ui_cargo')} ${esc(j.cargo)}</div>
      <button class="big ok" data-respond="${j.id}" data-accept="1">${icon('ui_accept')} ${esc(T('ui_accept'))}</button>
      <button class="big ghost" data-respond="${j.id}" data-accept="0">${icon('ui_decline')} ${esc(T('ui_decline'))}</button></div>`;
  }

  function activeCard(j) {
    const idx = j.activeStop;
    if (idx < 0) return `<div class="card" style="text-align:center"><div style="font-size:48px">🎉</div><h2>${esc(T('ui_job_done'))}</h2></div>`;
    const s = j.stops[idx], st = siteOf(s.siteId);
    const nav = `https://www.google.com/maps/dir/?api=1&destination=${st.lat},${st.lng}`;
    const reqKeys = s.workRequests.map((r) => r.key);
    let body = '', say = '';
    const jobBtn = (action, label, ic, cls) => `<button class="big ${cls || ''}" data-act="${action}" data-job="${j.id}" data-idx="${idx}">${icon(ic)} ${esc(T(label))}</button>`;
    const navBtn = `<a class="big ghost" style="text-decoration:none" href="${nav}" target="_blank" rel="noopener">${icon('ui_navigate')} ${esc(T('ui_navigate'))}</a>`;
    const guide = whCard(s, true) + `<div class="card"><b>${icon('ui_site_guide')} ${esc(T('ui_site_guide'))}</b>${pictGrid(st.rules)}</div>`;

    switch (s.stage) {
      case 'pending':
        body = jobBtn('depart', 'ui_depart', 'ui_depart', '') + navBtn + guide; say = T('ui_depart'); break;
      case 'enroute':
        body = `<div class="eta">${j.eta != null ? j.eta : '–'} <small>${esc(T('ui_min'))}</small></div><div class="muted small" style="text-align:center">${icon('ui_gps_on')} ${esc(T('ui_gps_on'))}</div>
          ${navBtn}${jobBtn('arrive', 'ui_arrive', 'ui_arrive', 'ghost')}${guide}`;
        say = T('ui_eta') + ' ' + (j.eta != null ? j.eta : '') + ' ' + T('ui_min'); break;
      case 'arrived':
        body = jobBtn('checkin', 'ui_checkin', 'ui_checkin', '') + guide; say = T('ui_checkin'); break;
      case 'checkedin':
        body = `<div class="ticket"><div class="muted">${icon('ui_your_number')} ${esc(T('ui_your_number'))}</div><div class="no">${esc(s.checkinNo)}</div></div>
          <div class="card" style="text-align:center"><div style="font-size:40px">⏳</div><b>${esc(T('ui_wait_called'))}</b></div>${guide}`;
        say = T('ui_wait_called'); break;
      case 'called':
        body = `<div class="berth"><div class="tx">${icon('ui_go_berth')} ${esc(T('ui_go_berth'))}</div><div class="no">${esc(s.berth)}</div></div>${jobBtn('start', 'ui_start', 'ui_start', 'ok')}`;
        say = T('m_call_berth', { berth: s.berth }); break;
      case 'working': {
        const keys = Array.from(new Set(s.work.concat(reqKeys)));
        body = whCard(s, true) + `<div class="card"><b>${icon('ui_work_requests')} ${esc(T('ui_work_requests'))}</b>${pictGrid(keys, reqKeys)}</div>
          <button class="big ghost" data-photo="${j.id}" data-idx="${idx}">${icon(s.photo ? 'ui_photo_ok' : 'ui_photo')} ${esc(T(s.photo ? 'ui_photo_ok' : 'ui_photo'))}</button>
          ${jobBtn('done', 'ui_done', 'ui_done', 'ok')}`;
        say = keys.map((k) => T(k)).join('. '); break;
      }
      default: break;
    }
    const stageKey = 'st_' + s.stage;
    const next = j.stops[idx + 1] ? `<div class="muted small">${icon('ui_next_stop')} ${esc(T('ui_next_stop'))}: ${esc(siteOf(j.stops[idx + 1].siteId).name)}</div>` : '';
    return `<div class="card"><div class="row wrap"><span class="stage-chip">${icon(stageKey)} ${esc(T(stageKey))}</span><span class="grow"></span>
      <button class="btn" data-speak="${esc(say)}" aria-label="${esc(T('ui_listen'))}">${icon('ui_listen')}</button></div>
      ${stopSummary(j, s, false)}
      <div class="row wrap muted" style="margin:4px 0">${icon('ui_time')} ${esc(fmtTime(j.windowStart))}–${esc(fmtTime(j.windowEnd))} &nbsp; ${icon('ui_cargo')} ${esc(j.cargo)}</div>${next}</div>${body}`;
  }

  function viewMessages() {
    markSeen();
    const ms = allMessages();
    setTimeout(() => { const b = document.querySelector('[data-nav="messages"] .badge'); if (b) b.remove(); }, 0);
    if (!ms.length) return `<h2>${icon('ui_messages')} ${esc(T('ui_messages'))}</h2><div class="card muted">${esc(T('ui_jobs_none'))}</div>`;
    return `<h2>${icon('ui_messages')} ${esc(T('ui_messages'))}</h2>` + ms.map((m) => {
      const key = m.kind === 'work' ? m.params.work : m.key;
      const extra = m.kind === 'work' ? `<div class="muted small">${esc(T('m_work_request'))}</div>` : '';
      return `<div class="msg"><span class="ic">${icon(key)}</span><div><div class="tx">${esc(T(key, m.params))}</div>${extra}<div class="muted small">${esc(fmtTime(m.ts))}</div></div></div>`;
    }).join('');
  }

  function viewHelp() {
    const active = jobs().find((j) => j.state === 'accepted' || j.state === 'inprogress');
    if (!active) return `<h2>${icon('ui_help')} ${esc(T('ui_help'))}</h2><div class="card muted">${esc(T('ui_jobs_none'))}</div>`;
    const keys = GROUPS.trouble.filter((k) => k !== 't_sos');
    return `<h2>${icon('ui_help')} ${esc(T('ui_help'))}</h2>
      <button class="big crit" data-trouble="t_sos" data-job="${active.id}">${icon('t_sos')} ${esc(T('t_sos'))}</button>
      <div class="pict">${keys.map((k) => `<button class="p" data-trouble="${k}" data-job="${active.id}"><span class="ic">${icon(k)}</span><span class="tx">${esc(T(k))}</span></button>`).join('')}</div>
      <button class="big ghost" data-nav="main">${icon('ui_back')} ${esc(T('ui_back'))}</button>`;
  }

  // ---- イベント
  function bindCommon() {
    document.querySelectorAll('[data-lang]').forEach((b) => { b.onclick = () => { lang = b.dataset.lang; store.set('sl_lang', lang); render(); }; });
    document.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => { meId = b.dataset.pick; store.set('sl_driver', meId); const d = me(); lang = d.lang; store.set('sl_lang', lang); lastMsgCount = null; load(); }; });
    document.querySelectorAll('[data-switch]').forEach((b) => { b.onclick = () => { meId = null; store.set('sl_driver', ''); view = 'main'; lastMsgCount = null; render(); window.scrollTo(0, 0); }; });
    document.querySelectorAll('[data-nav]').forEach((b) => { b.onclick = () => { view = b.dataset.nav; render(); window.scrollTo(0, 0); }; });
    document.querySelectorAll('[data-speak]').forEach((b) => { b.onclick = () => speak(b.dataset.speak); });
    document.querySelectorAll('[data-respond]').forEach((b) => { b.onclick = async () => { await act(() => api('POST', `/api/jobs/${b.dataset.respond}/respond`, { accept: b.dataset.accept === '1' })); }; });
    document.querySelectorAll('[data-act]').forEach((b) => { b.onclick = async () => { await act(() => api('POST', `/api/jobs/${b.dataset.job}/stops/${b.dataset.idx}/${b.dataset.act}`, { by: 'driver' })); }; });
    document.querySelectorAll('[data-photo]').forEach((b) => { b.onclick = () => takePhoto(b.dataset.photo, b.dataset.idx); });
    document.querySelectorAll('[data-trouble]').forEach((b) => { b.onclick = async () => { await act(() => api('POST', `/api/jobs/${b.dataset.job}/messages`, { from: 'driver', key: b.dataset.trouble })); toast(icon('ui_sent') + ' ' + T('ui_sent')); view = 'main'; render(); }; });
  }
  async function act(fn) { try { await fn(); await load(); } catch (e) { toast('⚠️ ' + e.message); } }

  function takePhoto(jobId, idx) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
    inp.onchange = async () => { if (inp.files && inp.files.length) { await act(() => api('POST', `/api/jobs/${jobId}/stops/${idx}/photo`, {})); toast(icon('ui_photo_ok') + ' ' + T('ui_photo_ok')); } };
    inp.click();
  }

  SL.stream(load);
  load().catch((e) => { $('app').innerHTML = '<p>' + esc(e.message) + '</p>'; });
})();
