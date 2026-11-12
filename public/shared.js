/* 共通: 多言語辞書・ユーティリティ
 * 翻訳は初稿です。運用前に各言語のネイティブによるチェックが必要です（要件定義 A-02）。
 * 辞書キー接頭辞: ui_=画面文言, st_=進捗, w_=作業, r_=現場ルール, t_=トラブル, m_=連絡定型文
 */
(function () {
  const LANGS = [
    { code: 'ja', label: '日本語', flag: '🇯🇵', speech: 'ja-JP' },
    { code: 'zh', label: '中文', flag: '🇨🇳', speech: 'zh-CN' },
  ];

  // [icon, ja, en, vi, id] ※現在の対応言語は日本語と中国語のみ（zh は下の ZH）。en/vi/id は将来の追加用に保持
  const rows = {
    // ---- 画面文言 ----
    ui_select_driver: ['👤', 'あなたを選んでください', 'Choose your name', 'Chọn tên của bạn', 'Pilih nama Anda'],
    ui_jobs_new: ['🆕', '新しい案件', 'New jobs', 'Chuyến mới', 'Pekerjaan baru'],
    ui_jobs_none: ['', '案件はありません', 'No jobs', 'Không có chuyến nào', 'Tidak ada pekerjaan'],
    ui_accept: ['✅', '受ける', 'Accept', 'Nhận', 'Terima'],
    ui_decline: ['❌', '断る', 'Decline', 'Từ chối', 'Tolak'],
    ui_pickup: ['⬆️', '積込み', 'Pickup', 'Lấy hàng', 'Ambil muatan'],
    ui_dropoff: ['⬇️', '荷降ろし', 'Delivery', 'Giao hàng', 'Antar muatan'],
    ui_time: ['🕒', '時間', 'Time', 'Thời gian', 'Waktu'],
    ui_cargo: ['📦', '荷物', 'Cargo', 'Hàng hóa', 'Muatan'],
    ui_navigate: ['🧭', 'ナビを開く', 'Open navigation', 'Mở dẫn đường', 'Buka navigasi'],
    ui_depart: ['🚚', '出発する', 'Depart', 'Xuất phát', 'Berangkat'],
    ui_arrive: ['📍', '到着した', 'I have arrived', 'Tôi đã đến nơi', 'Saya sudah tiba'],
    ui_checkin: ['🪪', '受付する', 'Check in', 'Đăng ký (check-in)', 'Check-in'],
    ui_start: ['▶️', '作業開始', 'Start work', 'Bắt đầu làm việc', 'Mulai kerja'],
    ui_done: ['🏁', '作業完了', 'Work done', 'Hoàn thành', 'Selesai'],
    ui_photo: ['📷', '写真を撮る', 'Take a photo', 'Chụp ảnh', 'Ambil foto'],
    ui_photo_ok: ['✅', '写真を送りました', 'Photo sent', 'Đã gửi ảnh', 'Foto terkirim'],
    ui_wait_called: ['⏳', '呼び出しをお待ちください', 'Please wait to be called', 'Vui lòng chờ được gọi', 'Mohon tunggu dipanggil'],
    ui_go_berth: ['📣', 'バースへ進んでください', 'Go to the berth', 'Hãy đến cửa/dock', 'Silakan menuju dok'],
    ui_berth: ['🚪', 'バース', 'Berth', 'Cửa/dock', 'Dok'],
    ui_your_number: ['🎫', '受付番号', 'Your number', 'Số thứ tự của bạn', 'Nomor antrean Anda'],
    ui_eta: ['🕒', '到着まで', 'Arrival in', 'Đến nơi sau', 'Tiba dalam'],
    ui_min: ['', '分', 'min', 'phút', 'menit'],
    ui_help: ['🆘', '困ったとき', 'Need help', 'Cần giúp đỡ', 'Butuh bantuan'],
    ui_messages: ['💬', '連絡', 'Messages', 'Tin nhắn', 'Pesan'],
    ui_site_guide: ['📋', '現場ガイド', 'Site guide', 'Hướng dẫn tại địa điểm', 'Panduan lokasi'],
    ui_entrance: ['🚪', '入口', 'Entrance', 'Lối vào', 'Pintu masuk'],
    ui_job_done: ['🎉', '配送完了です。お疲れさまでした', 'Delivery complete. Thank you!', 'Hoàn tất giao hàng. Cảm ơn bạn!', 'Pengiriman selesai. Terima kasih!'],
    ui_back: ['◀️', '戻る', 'Back', 'Quay lại', 'Kembali'],
    ui_listen: ['🔊', '音声で聞く', 'Listen', 'Nghe', 'Dengarkan'],
    ui_sent: ['📨', '送信しました', 'Sent', 'Đã gửi', 'Terkirim'],
    ui_current: ['🚚', '今の案件', 'Current job', 'Chuyến hiện tại', 'Pekerjaan saat ini'],
    ui_work_requests: ['🛠️', '作業の依頼', 'Work requests', 'Yêu cầu công việc', 'Permintaan kerja'],
    ui_gps_on: ['📡', '位置情報を共有中', 'Sharing location', 'Đang chia sẻ vị trí', 'Membagikan lokasi'],
    ui_next_stop: ['➡️', '次の場所', 'Next stop', 'Điểm tiếp theo', 'Pemberhentian berikutnya'],
    // ---- 進捗 ----
    st_pending: ['⏸️', '待機', 'Waiting', 'Chờ', 'Menunggu'],
    st_enroute: ['🚚', '移動中', 'On the way', 'Đang di chuyển', 'Dalam perjalanan'],
    st_arrived: ['📍', '到着', 'Arrived', 'Đã đến', 'Tiba'],
    st_checkedin: ['🪪', '受付済み', 'Checked in', 'Đã đăng ký', 'Sudah check-in'],
    st_called: ['📣', '呼び出し中', 'Called', 'Đã được gọi', 'Dipanggil'],
    st_working: ['🛠️', '作業中', 'Working', 'Đang làm việc', 'Sedang bekerja'],
    st_done: ['✅', '完了', 'Done', 'Hoàn tất', 'Selesai'],
    // ---- 作業 ----
    w_forklift_unload: ['🚜', 'フォークリフトで荷降ろし', 'Unload with forklift', 'Dỡ hàng bằng xe nâng', 'Bongkar dengan forklift'],
    w_forklift_load: ['🚜', 'フォークリフトで積込み', 'Load with forklift', 'Xếp hàng bằng xe nâng', 'Muat dengan forklift'],
    w_manual_unload: ['📦', '手荷役で荷降ろし', 'Unload by hand', 'Dỡ hàng bằng tay', 'Bongkar manual'],
    w_manual_load: ['📦', '手荷役で積込み', 'Load by hand', 'Xếp hàng bằng tay', 'Muat manual'],
    w_wing_open: ['🚪', 'ウイング開放', 'Open the wing body', 'Mở thùng cánh dơi', 'Buka sayap bak truk'],
    w_seal_check: ['🔒', '封印（シール）確認', 'Check the seal', 'Kiểm tra niêm phong', 'Periksa segel'],
    w_pallet_swap: ['🔁', 'パレット交換', 'Swap pallets', 'Đổi pallet', 'Tukar palet'],
    w_tail_lift: ['⬆️', 'パワーゲート使用', 'Use the tail lift', 'Dùng bửng nâng', 'Gunakan lift gate'],
    w_sheet: ['🟫', 'シート掛け', 'Cover with a sheet', 'Phủ bạt', 'Pasang terpal'],
    // ---- 現場ルール ----
    r_gate_check: ['🪪', '入口で受付票を見せる', 'Show your slip at the gate', 'Xuất trình phiếu tại cổng', 'Tunjukkan slip di gerbang'],
    r_helmet: ['⛑️', 'ヘルメットを着ける', 'Wear a helmet', 'Đội mũ bảo hộ', 'Pakai helm'],
    r_vest: ['🦺', '安全ベストを着る', 'Wear a safety vest', 'Mặc áo phản quang', 'Pakai rompi keselamatan'],
    r_no_idle: ['🔇', 'アイドリング禁止', 'No idling', 'Không nổ máy không tải', 'Dilarang idle mesin'],
    r_speed5: ['🐢', '場内は時速5km', '5 km/h on site', 'Tốc độ 5 km/h trong khu vực', '5 km/jam di area'],
    r_one_way: ['➡️', '一方通行', 'One-way', 'Đường một chiều', 'Satu arah'],
    r_no_phone: ['📵', '運転中は携帯を使わない', 'No phone while driving', 'Không dùng điện thoại khi lái xe', 'Dilarang HP saat mengemudi'],
    r_engine_off: ['🛑', '荷役中はエンジン停止', 'Engine off while loading', 'Tắt máy khi bốc xếp', 'Matikan mesin saat bongkar muat'],
    r_chock: ['🛞', '輪止めをする', 'Chock the wheels', 'Chèn bánh xe', 'Pasang ganjal roda'],
    // ---- トラブル（ドライバー→現場・デスク） ----
    t_jam: ['🚧', '渋滞で遅れます', 'Delayed by traffic', 'Bị trễ do kẹt xe', 'Terlambat karena macet'],
    t_accident: ['💥', '事故が起きました', 'I had an accident', 'Tôi bị tai nạn', 'Saya mengalami kecelakaan'],
    t_breakdown: ['🔧', '車が故障しました', 'Vehicle breakdown', 'Xe bị hỏng', 'Kendaraan rusak'],
    t_cargo_damage: ['📦', '荷物が破損・荷崩れしました', 'Cargo damaged or shifted', 'Hàng bị hư hỏng / xô lệch', 'Muatan rusak / bergeser'],
    t_long_wait: ['⏳', '待ち時間が長いです', 'I am waiting too long', 'Tôi phải chờ quá lâu', 'Saya menunggu terlalu lama'],
    t_lost: ['❓', '場所がわかりません', 'I cannot find the place', 'Tôi không tìm thấy địa điểm', 'Saya tidak menemukan lokasi'],
    t_sick: ['🤒', '体調が悪いです', 'I feel sick', 'Tôi thấy không khỏe', 'Saya merasa sakit'],
    t_sos: ['🆘', '緊急！助けてください', 'Emergency! Please help', 'Khẩn cấp! Hãy giúp tôi', 'Darurat! Tolong saya'],
    // ---- 連絡定型文（現場・デスク→ドライバー） ----
    m_ok: ['✅', '了解しました', 'Understood', 'Đã hiểu', 'Dimengerti'],
    m_wait10: ['⏱️', 'あと10分お待ちください', 'Please wait 10 more minutes', 'Vui lòng chờ thêm 10 phút', 'Mohon tunggu 10 menit lagi'],
    m_wait30: ['⏱️', 'あと30分お待ちください', 'Please wait 30 more minutes', 'Vui lòng chờ thêm 30 phút', 'Mohon tunggu 30 menit lagi'],
    m_proceed: ['➡️', 'そのまま進んでください', 'Please proceed', 'Vui lòng tiếp tục', 'Silakan lanjutkan'],
    m_photo: ['📷', '写真を撮って送ってください', 'Please take and send a photo', 'Vui lòng chụp và gửi ảnh', 'Mohon ambil dan kirim foto'],
    m_call_office: ['📞', '事務所から電話します', 'The office will call you', 'Văn phòng sẽ gọi cho bạn', 'Kantor akan menelepon Anda'],
    m_stay: ['🛑', 'その場で待機してください', 'Stay where you are', 'Hãy chờ tại chỗ', 'Tetap di tempat'],
    m_cancel: ['⛔', 'この案件はキャンセルです', 'This job is cancelled', 'Chuyến này đã bị hủy', 'Pekerjaan ini dibatalkan'],
    m_call_berth: ['📣', 'バース {berth} に進んでください', 'Go to berth {berth}', 'Hãy đến cửa số {berth}', 'Silakan menuju dok {berth}'],
    m_work_request: ['🛠️', '作業をお願いします', 'Please do this work', 'Vui lòng thực hiện công việc này', 'Mohon lakukan pekerjaan ini'],
  };

  const ZH = {
    "ui_select_driver": "请选择您的名字",
    "ui_jobs_new": "新任务",
    "ui_jobs_none": "暂无任务",
    "ui_accept": "接单",
    "ui_decline": "拒绝",
    "ui_pickup": "装货",
    "ui_dropoff": "卸货",
    "ui_time": "时间",
    "ui_cargo": "货物",
    "ui_navigate": "打开导航",
    "ui_depart": "出发",
    "ui_arrive": "我已到达",
    "ui_checkin": "登记签到",
    "ui_start": "开始作业",
    "ui_done": "作业完成",
    "ui_photo": "拍照",
    "ui_photo_ok": "照片已发送",
    "ui_wait_called": "请等待叫号",
    "ui_go_berth": "请前往月台",
    "ui_berth": "月台",
    "ui_your_number": "您的排队号",
    "ui_eta": "预计到达还需",
    "ui_min": "分钟",
    "ui_help": "需要帮助",
    "ui_messages": "消息",
    "ui_site_guide": "现场指南",
    "ui_entrance": "入口",
    "ui_job_done": "配送完成，辛苦了",
    "ui_back": "返回",
    "ui_listen": "语音播放",
    "ui_sent": "已发送",
    "ui_current": "当前任务",
    "ui_work_requests": "作业要求",
    "ui_gps_on": "正在共享位置",
    "ui_next_stop": "下一站",
    "st_pending": "待命",
    "st_enroute": "行驶中",
    "st_arrived": "已到达",
    "st_checkedin": "已登记",
    "st_called": "已叫号",
    "st_working": "作业中",
    "st_done": "已完成",
    "w_forklift_unload": "用叉车卸货",
    "w_forklift_load": "用叉车装货",
    "w_manual_unload": "人工卸货",
    "w_manual_load": "人工装货",
    "w_wing_open": "打开翼展车厢",
    "w_seal_check": "检查封条",
    "w_pallet_swap": "更换托盘",
    "w_tail_lift": "使用尾板",
    "w_sheet": "盖篷布",
    "r_gate_check": "在门口出示登记单",
    "r_helmet": "请戴安全帽",
    "r_vest": "请穿反光背心",
    "r_no_idle": "禁止怠速",
    "r_speed5": "场内限速5公里/小时",
    "r_one_way": "单行道",
    "r_no_phone": "驾驶时禁止使用手机",
    "r_engine_off": "装卸时请熄火",
    "r_chock": "请塞好车轮挡块",
    "t_jam": "因堵车会晚到",
    "t_accident": "我出了事故",
    "t_breakdown": "车辆故障",
    "t_cargo_damage": "货物破损或倾倒",
    "t_long_wait": "等待时间太长",
    "t_lost": "找不到地点",
    "t_sick": "我身体不舒服",
    "t_sos": "紧急！请帮助我",
    "m_ok": "明白了",
    "m_wait10": "请再等10分钟",
    "m_wait30": "请再等30分钟",
    "m_proceed": "请继续前进",
    "m_photo": "请拍照并发送",
    "m_call_office": "办公室会给您打电话",
    "m_stay": "请原地等待",
    "m_cancel": "此任务已取消",
    "m_call_berth": "请前往{berth}号月台",
    "m_work_request": "请完成此项作业"
  };
  const DICT = {};
  Object.keys(rows).forEach((k) => {
    const r = rows[k];
    DICT[k] = { icon: r[0], ja: r[1], en: r[2], vi: r[3], id: r[4], zh: ZH[k] };
  });

  const GROUPS = {
    work: Object.keys(DICT).filter((k) => k.startsWith('w_')),
    rules: Object.keys(DICT).filter((k) => k.startsWith('r_')),
    trouble: Object.keys(DICT).filter((k) => k.startsWith('t_')),
    reply: ['m_ok', 'm_wait10', 'm_wait30', 'm_proceed', 'm_photo', 'm_call_office', 'm_stay', 'm_cancel'],
  };

  function tr(key, lang, params) {
    const e = DICT[key];
    if (!e) return key;
    let s = e[lang] || e.ja || key;
    if (params) Object.keys(params).forEach((p) => { s = s.replace('{' + p + '}', params[p]); });
    return s;
  }
  const icon = (key) => (DICT[key] ? DICT[key].icon : '');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtTime(iso) {
    const d = new Date(iso);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }
  function stream(onUpdate) {
    let timer = null;
    const fire = () => { clearTimeout(timer); timer = setTimeout(onUpdate, 150); };
    const es = new EventSource('/api/stream');
    es.addEventListener('update', fire);
    es.onerror = () => { /* ブラウザが自動再接続する */ };
    setInterval(onUpdate, 15000); // 念のための定期更新
    return es;
  }

  window.SL = { LANGS, DICT, GROUPS, tr, icon, esc, fmtTime, fmtDate, api, stream };
})();
