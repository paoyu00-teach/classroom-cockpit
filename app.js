const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];

// 網頁 / iPad 版（分享網址）會由打包程式改成 true：教材改用內建 PDF 閱讀器，不呼叫 PowerPoint / Acrobat
const IS_WEB_BUILD = true;
function bindKindLabel(prog) {
  let p = (prog && prog.pptPath) || '';
  if (IS_WEB_BUILD) return /\.pptx?$/i.test(p) ? 'PPT' : 'PDF';
  return /\.pdf$/i.test(p) ? 'PDF' : 'PPT';
}

// 預設機會與命運卡牌
const defaults = {
  chance: [
    '下一位抽到的同學答對，加1分',
    '下一位抽到的同學答對，加2分',
    '下一位抽到的同學答對，加3分',
    '下一位抽到的同學答對，平時成績直接加5分（大獎！）',
    '下一位抽到的同學，全班每人加1分（普天同慶！）',
    '下一位抽到的同學，老師請喝飲料（超級大獎！）',
    '下一位抽到的同學，全班起立鼓掌',
    '下一位抽到的同學，獲得「免死金牌」一張',
    '下一位抽到的同學，可以指定下一個回答問題的幸運兒',
    '表現優良，本次答對分數加倍！'
  ],
  fate: [
    '下一位抽到的同學答錯，扣1分',
    '下一位抽到的同學答錯，扣2分',
    '下一位抽到的同學答錯，扣3分',
    '下一位抽到的同學，當值日生1天',
    '下一位抽到的同學，負責擦黑板一星期',
    '下一位抽到的同學，全班罰站1分鐘',
    '下一位抽到的同學，該同學罰站到下課',
    '下一位抽到的同學，直接當掉（開玩笑的，平時成績扣3分）',
    '下一位抽到的同學，免死金牌加持（意想不到的幸運反轉！）',
    '下一位抽到的同學，該同學深蹲10下'
  ]
};

// 全局狀態
let state = {
  names: [],
  chanceCount: 3,
  fateCount: 3,
  chance: [...defaults.chance],
  fate: [...defaults.fate]
};

let currentSlotIndex = 0;
let currentClassName = '未命名班級';
let absentList = new Set(); // 缺席名單
let todayScores = {}; // 今日記點: { [name]: { total: 0, logs: [ { delta, reason, time } ] } }
let activeBuff = null; // 當前待生效的機會/命運加成效果
let tiles = [];
let position = -1;
let diceN = 2;
// 兩顆骰子各自的最大點數（第二顆為 0 表示只顯示一顆）
function diceFaces() { return [6 * Math.ceil(diceN / 2), 6 * Math.floor(diceN / 2)]; }
let ignoreSpecial = false;
let busy = false;
let toastTimer;
let winnerTile = null;
let currentBubbleTile = null;
// ============================================================
// 暗中抽籤控制：骰子旁的 ★ / ☆ 裝飾 + 課前名單設定
//  ★ 點一下 → 再點學生格子：下一次一定抽到他（再做一次可取消）
//  ☆ 點一下 → 再點學生格子：這節課抽不到他（再做一次可取消）
//  點過星星後點學生格子「完全沒有反應」，不會彈出記點氣泡
//  長按任一顆星星 2 秒：開啟課前名單設定（整學期 / 本節課）
// ============================================================
let liveForceName = null;     // ★ 指定：下一次一定抽到（以名字記錄）
let starMode = null;          // 'must' | 'never' | null：等待點學生格子
let starModeTimer = null;
let plannedLanding = { doorTo: null, cardStudent: null }; // 本次移動預先決定的任意門落點／卡牌指名

const cleanName = raw => String(raw || '').replace(/#.*$/, '').replace(/[\(（].*[\)）]/, '').trim();
function todayStr() {
  let d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function stealthKey() { return 'draw-slot-' + currentSlotIndex + '-stealth'; }
function loadStealth() {
  let s;
  try { s = JSON.parse(localStorage.getItem(stealthKey())) || {}; } catch { s = {}; }
  s.semester = s.semester || {};
  if (!s.lesson || s.lesson.date !== todayStr()) s.lesson = { date: todayStr(), map: {}, picked: [] };
  s.lesson.map = s.lesson.map || {};
  s.lesson.picked = s.lesson.picked || [];
  return s;
}
function saveStealth(s) { localStorage.setItem(stealthKey(), JSON.stringify(s)); }
// 回傳 'must' | 'never' | ''（本節課設定優先於整學期）
function stealthRule(name, s = loadStealth()) {
  let k = cleanName(name), lv = s.lesson.map[k];
  if (lv === 'normal') return '';
  return lv || s.semester[k] || '';
}
function isPickable(t, s = loadStealth()) {
  if (!t || t.kind !== 'student' || t.removed) return false;
  if (liveForceName && cleanName(t.name) === liveForceName) return true;
  return stealthRule(t.name, s) !== 'never';
}
function markPicked(name) {
  let k = cleanName(name), s = loadStealth();
  if (!s.lesson.picked.includes(k)) { s.lesson.picked.push(k); saveStealth(s); }
  if (liveForceName === k) liveForceName = null;
  updateStarMarks();
}
// 本次應該抽到誰：★ 指定優先，其次是「一定點」且今天還沒抽過的人
function currentTargetTile() {
  if (liveForceName) {
    let t = tiles.find(x => x.kind === 'student' && !x.removed && cleanName(x.name) === liveForceName);
    if (t) return t;
  }
  let s = loadStealth();
  let musts = tiles.filter(x => x.kind === 'student' && !x.removed && stealthRule(x.name, s) === 'must' && !s.lesson.picked.includes(cleanName(x.name)));
  return musts.length ? musts[Math.floor(Math.random() * musts.length)] : null;
}
function landingKind(idx, target, s) {
  let t = tiles[idx];
  if (!t) return 'bad';
  if (t.kind === 'student') {
    if (target && t === target) return 'direct';
    return isPickable(t, s) ? 'other' : 'bad';
  }
  if (ignoreSpecial) return 'none';
  return t.kind; // 'door' | 'chance' | 'fate'
}
// 從候選移動方式中挑一個：有目標就想辦法抽到他（直接落點 > 任意門 > 機會 > 命運），
// 沒有目標就隨機挑一個不會落在「不點」學生身上的結果。骰子點數與步數永遠一致。
function planMove(options, cur) {
  let n = tiles.length, s = loadStealth(), target = currentTargetTile();
  let pick = arr => arr[Math.floor(Math.random() * arr.length)];
  let kindOf = o => landingKind((cur + o.steps) % n, target, s);
  plannedLanding = { doorTo: null, cardStudent: null };
  if (target) {
    // 機會卡（加分）優先於命運卡（扣分），避免指定的學生被抽去受罰
    for (let want of ['direct', 'door', 'chance', 'fate']) {
      let ok = options.filter(o => kindOf(o) === want);
      if (ok.length) {
        if (want !== 'direct') plannedLanding = { doorTo: tiles.indexOf(target), cardStudent: target.name };
        return { opt: pick(ok), hit: true };
      }
    }
  }
  // 沒有目標，或這次骰不到目標（目標保留到下一次）：避開「不點」的學生；有目標時也盡量不抽到別人
  let safe = options.filter(o => kindOf(o) !== 'bad');
  if (target) {
    let quiet = safe.filter(o => kindOf(o) === 'none');
    if (quiet.length) safe = quiet;
  }
  return { opt: pick(safe.length ? safe : options), hit: false };
}
function randomPickableName() {
  let s = loadStealth(), list = tiles.filter(t => isPickable(t, s));
  return list.length ? list[Math.floor(Math.random() * list.length)].name : '同學';
}
function randomDoorDestination() {
  let s = loadStealth();
  let idxs = tiles.map((t, i) => i).filter(i => isPickable(tiles[i], s) || (!ignoreSpecial && (tiles[i].kind === 'chance' || tiles[i].kind === 'fate')));
  return idxs.length ? idxs[Math.floor(Math.random() * idxs.length)] : Math.floor(Math.random() * tiles.length);
}

// 星星外觀：只在設定當下閃一下極小的點（約 0.7 秒），平時不留任何記號
function updateStarMarks() {}
function flashStar(sel, on) {
  let el = $(sel);
  if (!el) return;
  el.classList.remove('flash-on', 'flash-off');
  void el.offsetWidth;
  el.classList.add(on ? 'flash-on' : 'flash-off');
  clearTimeout(el._flashT);
  el._flashT = setTimeout(() => el.classList.remove('flash-on', 'flash-off'), 700);
}
function setStarMode(mode) {
  starMode = mode;
  clearTimeout(starModeTimer);
  $('#starMust')?.classList.toggle('waiting', mode === 'must');
  $('#starNever')?.classList.toggle('waiting', mode === 'never');
  if (mode) starModeTimer = setTimeout(() => setStarMode(null), 6000);
}
function applyStarToStudent(t) {
  let k = cleanName(t.name), mode = starMode;
  setStarMode(null);
  if (mode === 'must') {
    liveForceName = (liveForceName === k ? null : k);
    updateStarMarks();
    flashStar('#starMust', !!liveForceName);
  } else if (mode === 'never') {
    let s = loadStealth();
    let nowNever = stealthRule(t.name, s) === 'never';
    if (nowNever) {
      if (s.semester[k] === 'never') s.lesson.map[k] = 'normal';
      else delete s.lesson.map[k];
    } else {
      s.lesson.map[k] = 'never';
      if (liveForceName === k) { liveForceName = null; updateStarMarks(); }
    }
    saveStealth(s);
    flashStar('#starNever', !nowNever);
  }
}
function bindLongPress(el, ms, onLong) {
  if (!el) return;
  let timer = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerdown', () => {
    el._longFired = false;
    cancel();
    timer = setTimeout(() => { el._longFired = true; onLong(); }, ms);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => el.addEventListener(ev, cancel));
  el.addEventListener('contextmenu', e => e.preventDefault());
}

// 課前名單設定面板
function openSecretDialog() {
  setStarMode(null);
  let list = $('#secretList');
  list.replaceChildren();
  let s = loadStealth();
  let names = [...new Set(roster().map(cleanName).filter(Boolean))];
  $('#secretTitle').textContent = `班級名單設定：${localStorage.getItem('draw-slot-' + currentSlotIndex + '-name') || `班級 ${currentSlotIndex + 1}`}`;
  if (!names.length) {
    list.textContent = '目前沒有名單，請先在設定頁載入班級。';
  }
  const mkSelect = (opts, value, onChange) => {
    let sel = document.createElement('select');
    opts.forEach(([v, label]) => {
      let o = document.createElement('option');
      o.value = v; o.textContent = label;
      sel.append(o);
    });
    sel.value = value;
    sel.onchange = () => onChange(sel.value);
    return sel;
  };
  names.forEach(k => {
    let row = document.createElement('div');
    let nameEl = document.createElement('span');
    const refresh = () => {
      let cur = loadStealth(), rule = stealthRule(k, cur);
      row.className = 'secret-row' + (rule ? ' ' + rule : '');
      nameEl.textContent = k;
      if (rule === 'must' && cur.lesson.picked.includes(k)) {
        let tag = document.createElement('span');
        tag.className = 'picked-tag';
        tag.textContent = '（今天已抽過）';
        nameEl.append(tag);
      }
    };
    let semLabel = document.createElement('label');
    semLabel.append('整學期', mkSelect([['', '一般'], ['must', '一定點'], ['never', '不點']], s.semester[k] || '', v => {
      let cur = loadStealth();
      if (v) cur.semester[k] = v; else delete cur.semester[k];
      saveStealth(cur); refresh();
    }));
    let lesLabel = document.createElement('label');
    lesLabel.append('本節課', mkSelect([['', '跟整學期'], ['must', '一定點'], ['never', '不點'], ['normal', '一般']], s.lesson.map[k] || '', v => {
      let cur = loadStealth();
      if (v) cur.lesson.map[k] = v; else delete cur.lesson.map[k];
      saveStealth(cur); refresh();
    }));
    row.append(nameEl, semLabel, lesLabel);
    refresh();
    list.append(row);
  });
  $('#secretDialog').showModal();
}

// 工具函數
function lines(s) { return (s || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean); }
function roster() { return lines($('#names').value); }
function toast(s) {
  let el = $('#toast');
  el.textContent = s;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2300);
}

// 煙火特效
let fireworkFrame = 0, fireworkParticles = [], fireworkCanvas = null, fireworkCtx = null, fireworkTicks = 0;
function startFireworks() {
  stopFireworks();
  fireworkCanvas = $('#fireworks');
  if (!fireworkCanvas) return;
  let rect = fireworkCanvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  fireworkCanvas.width = rect.width * dpr;
  fireworkCanvas.height = rect.height * dpr;
  fireworkCtx = fireworkCanvas.getContext('2d');
  fireworkCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fireworkParticles = [];
  fireworkTicks = 0;
  for (let i = 0; i < 3; i++) burstFirework(Math.random() * rect.width, rect.height * (.18 + Math.random() * .38));
  let w = rect.width, h = rect.height;
  function frame() {
    fireworkCtx.clearRect(0, 0, w, h);
    if (++fireworkTicks % 36 === 0) burstFirework(w * (.12 + Math.random() * .76), h * (.14 + Math.random() * .48));
    fireworkParticles = fireworkParticles.filter(p => p.life > 0);
    for (let p of fireworkParticles) {
      p.x += p.vx; p.y += p.vy; p.vy += .035; p.vx *= .992; p.life--;
      fireworkCtx.globalAlpha = Math.max(0, p.life / p.max);
      fireworkCtx.fillStyle = p.color;
      fireworkCtx.beginPath();
      fireworkCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      fireworkCtx.fill();
    }
    fireworkCtx.globalAlpha = 1;
    fireworkFrame = requestAnimationFrame(frame);
  }
  frame();
}

function burstFirework(x, y) {
  if (!fireworkCanvas) return;
  let colors = ['#ff3d67', '#ffb000', '#1bbdff', '#8a53ff', '#17c98b', '#ff6ad5'];
  let n = 55 + Math.floor(Math.random() * 30);
  for (let i = 0; i < n; i++) {
    let a = Math.PI * 2 * i / n, s = 1.1 + Math.random() * 3.3, life = 45 + Math.random() * 35;
    fireworkParticles.push({
      x, y,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life, max: life,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 1.5 + Math.random() * 2
    });
  }
}

function stopFireworks() {
  if (fireworkFrame) cancelAnimationFrame(fireworkFrame);
  fireworkFrame = 0;
  fireworkParticles = [];
  if (fireworkCtx && fireworkCanvas) fireworkCtx.clearRect(0, 0, fireworkCanvas.width, fireworkCanvas.height);
  fireworkCtx = null;
  fireworkCanvas = null;
}

// 班級進度與歷史管理 (Progress Storage)
function getSlotProgressData(idx) {
  let raw = localStorage.getItem('draw-slot-' + idx + '-progress');
  if (!raw) return { history: [], lastProgress: '', nextHomework: '', lastDate: '', lastSlide: 1, pptPath: '', memoDate: '', memoSeenDate: '' };
  try {
    let d = JSON.parse(raw);
    return {
      history: d.history || [],
      lastProgress: d.lastProgress || '',
      nextHomework: d.nextHomework || '',
      lastDate: d.lastDate || '',
      lastSlide: d.lastSlide || 1,
      pptPath: d.pptPath || '',
      memoDate: d.memoDate || '',
      memoSeenDate: d.memoSeenDate || ''
    };
  } catch {
    return { history: [], lastProgress: '', nextHomework: '', lastDate: '', lastSlide: 1, pptPath: '', memoDate: '', memoSeenDate: '' };
  }
}

function saveSlotProgressData(idx, data) {
  localStorage.setItem('draw-slot-' + idx + '-progress', JSON.stringify(data));
}

// ------------------------------------------------------------
// 備忘錄只保留到下一次上課：
//   寫下備忘的那天 = memoDate。之後哪一天再上這個班，打開時還看得到；
//   一按「開始上課（生成地圖）」、開啟 PPT／PDF、儲存進度，備忘就清掉。
//   寫下的同一天（例如同一班連上兩節）不會清。
// ------------------------------------------------------------
function memoMarkWritten(prog) {
  prog.memoDate = prog.nextHomework ? todayStr() : '';
  prog.memoSeenDate = '';
}
function memoMarkClassHeld(idx) {
  let p = getSlotProgressData(idx);
  if (p.nextHomework && p.memoDate && todayStr() > p.memoDate) {
    p.nextHomework = '';
    p.memoDate = '';
    p.memoSeenDate = '';
    saveSlotProgressData(idx, p);
    if (idx === currentSlotIndex) updateProgressBanners();
  }
}
function memoExpire(idx) {
  let p = getSlotProgressData(idx);
  let changed = false;
  if (p.nextHomework && !p.memoDate) { p.memoDate = todayStr(); changed = true; } // 舊資料：從今天開始算
  if (p.nextHomework && p.memoSeenDate && todayStr() > p.memoSeenDate) {
    p.nextHomework = '';
    p.memoDate = '';
    p.memoSeenDate = '';
    changed = true;
  }
  if (changed) saveSlotProgressData(idx, p);
}

function updateProgressBanners() {
  memoExpire(currentSlotIndex);
  let prog = getSlotProgressData(currentSlotIndex);
  let slotName = localStorage.getItem('draw-slot-' + currentSlotIndex + '-name') || `班級 ${+currentSlotIndex + 1}`;
  currentClassName = slotName;

  $('#bannerClassTitle').textContent = `當前班級：${slotName}`;
  let slideNum = prog.lastSlide || 1;
  document.querySelectorAll('.ppt-kind').forEach(el => el.textContent = bindKindLabel(prog));
  if ($('#bindPptBtn')) $('#bindPptBtn').textContent = IS_WEB_BUILD ? (prog.pptPath ? '📁 換檔案' : '📁 選擇 PDF／PPT') : '📁 綁定簡報';
  $('#openPptSlideText').textContent = `第 ${slideNum} 頁`;
  $('#gamePptSlideNum').textContent = `${slideNum}`;
  if ($('#setupSlideInput')) $('#setupSlideInput').value = slideNum;
  if ($('#gameSlideInput')) $('#gameSlideInput').value = slideNum;
  if ($('#todaySlideNumber')) $('#todaySlideNumber').value = slideNum;

  let memoText = prog.nextHomework || '';
  if ($('#setupMemoInput')) $('#setupMemoInput').value = memoText;

  if (prog.lastProgress) {
    let kindName = IS_WEB_BUILD ? (prog.pptPath ? bindKindLabel(prog) : '教材') : '簡報';
    let pptHint = prog.pptPath ? ` ｜ 📂 <strong>${kindName}：</strong>已綁定` : ` ｜ ⚠️ <em>未綁定${kindName}</em>`;
    $('#bannerProgressText').innerHTML = `📌 <strong>上次（${prog.lastDate}）進度：</strong> ${prog.lastProgress}${pptHint}`;
    $('#headProgressBadge').textContent = `上次：${prog.lastProgress} (第 ${slideNum} 頁) ${memoText ? '｜ 備忘：' + memoText : ''}`;
    $('#headProgressBadge').title = `下次待辦：${memoText || '無'}（點擊可修改）`;
    $('#lastProgressReview').innerHTML = `<strong>日期：</strong>${prog.lastDate}<br><strong>進度：</strong>${prog.lastProgress} (第 ${slideNum} 頁)<br><strong>作業備忘：</strong>${memoText || '無'}`;
  } else {
    $('#bannerProgressText').innerHTML = `尚未有前次記錄，這是第一次開課！`;
    $('#headProgressBadge').textContent = `尚無進度 ${memoText ? '｜ 備忘：' + memoText : ''}`;
    $('#lastProgressReview').textContent = '尚未有前次記錄，這是第一次開課！';
  }
  $('#currentClassTag').textContent = `⊗ 課堂抽籤 · ${slotName}`;
  $('#checkoutClassName').value = slotName;
  updateSheetSyncUI();
  updateNewbieGuide();
}

// 資料讀取與載入
function readForm() {
  state.names = roster();
  state.chanceCount = Math.max(0, Math.min(20, +$('#chanceCount').value || 0));
  state.fateCount = Math.max(0, Math.min(20, +$('#fateCount').value || 0, 37 - state.chanceCount));
  $('#fateCount').value = state.fateCount;
}

function data() {
  readForm();
  return { ...state };
}

function normalizeCards(cards, fallback) {
  return cards?.length
    ? cards.flatMap(card => String(card).replace(/\\r?\\n/g, '\n').split(/\r?\n/)).map(c => c.trim()).filter(Boolean)
    : [...fallback];
}

function applyData(d) {
  state = { ...state, ...d };
  $('#names').value = (state.names || []).join('\n');
  $('#chanceCount').value = state.chanceCount ?? 3;
  $('#fateCount').value = state.fateCount ?? 3;
  state.chance = normalizeCards(state.chance, defaults.chance);
  state.fate = normalizeCards(state.fate, defaults.fate);
  renderQuick();
  updateProgressBanners();
}

function renderQuick() {
  let el = $('#quickSlots');
  el.replaceChildren();
  for (let i = 0; i < 5; i++) {
    let b = document.createElement('button');
    b.className = 'quick-slot' + (i === currentSlotIndex ? ' active' : '');
    b.textContent = localStorage.getItem('draw-slot-' + i + '-name') || `班級 ${i + 1}`;
    b.title = '切換至 ' + b.textContent;
    b.onclick = () => {
      currentSlotIndex = i;
      ngJustSaved = false;
      if (localStorage.getItem('draw-slot-' + i)) {
        loadSlot(i);
      } else {
        // 還沒存過的班：清空名單框，避免把上一班的名單誤存成這一班
        $('#names').value = '';
        if (typeof ngJustSaved !== 'undefined') ngJustSaved = false;
        updateProgressBanners();
        renderQuick();
      }
      $('#slotSelect').value = i;
    };
    el.append(b);
  }
}

function saveSlot(i, n) {
  localStorage.setItem('draw-slot-' + i, JSON.stringify(data()));
  localStorage.setItem('draw-slot-' + i + '-name', n || `班級 ${+i + 1}`);
  currentSlotIndex = +i;
  renderQuick();
  updateProgressBanners();
  toast('班級設定已存檔至槽位 ' + (+i + 1));
}

function loadSlot(i) {
  let raw = localStorage.getItem('draw-slot-' + i);
  currentSlotIndex = +i;
  if (!raw) {
    toast('此槽位尚無存檔，使用預設值');
    updateProgressBanners();
    renderQuick();
    return;
  }
  try {
    applyData(JSON.parse(raw));
    toast('已讀取：' + (localStorage.getItem('draw-slot-' + i + '-name') || `班級 ${+i + 1}`));
  } catch {
    toast('存檔格式有誤');
  }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 棋盤網格自適應算法
function boardShape(count) {
  let best = null;
  for (let rows = 4; rows <= Math.max(4, count); rows++) {
    let cols = Math.max(4, Math.ceil((count - 2 * (rows - 2)) / 2));
    let capacity = 2 * cols + 2 * (rows - 2);
    if (capacity < count) continue;
    let score = Math.abs(cols / rows - 1.8) * 10 + (capacity - count) * 3;
    if (!best || score < best.score) best = { cols, rows, capacity, score };
  }
  return best || { cols: 4, rows: 4, capacity: 12 };
}

// 建立棋盤 (排除缺席學生)
function buildBoard() {
  readForm();
  let validStudents = state.names.filter(rawName => {
    let clean = rawName.replace(/#.*$/, '').replace(/[\(（].*[\)）]/, '').trim();
    return clean && !absentList.has(clean) && !rawName.includes('#缺席') && !rawName.includes('(假)');
  });

  if (!validStudents.length) {
    toast('沒有可用的學生名單（請確認名單未全數缺席）');
    $('#names').focus();
    return;
  }

  let kinds = [];
  for (let i = 0; i < state.chanceCount; i++) kinds.push({ kind: 'chance' });
  for (let i = 0; i < state.fateCount; i++) kinds.push({ kind: 'fate' });
  for (let i = 0; i < 3; i++) kinds.push({ kind: 'door' });

  let students = shuffle(validStudents.map((name, i) => ({ kind: 'student', name, index: i })));
  let specials = shuffle(kinds);
  let count = students.length + specials.length;

  tiles = Array(count).fill(null);
  specials.forEach((t, i) => {
    let at = Math.floor((i + .5) * count / specials.length);
    while (tiles[at]) at = (at + 1) % count;
    tiles[at] = t;
  });

  let studentCursor = 0;
  tiles = tiles.map(t => t || students[studentCursor++]);
  position = -1;

  renderBoard();
  $('#setup').classList.add('hidden');
  $('#game').classList.remove('hidden');
  $('#lastChance').textContent = '尚未抽取';
  $('#lastFate').textContent = '尚未抽取';
  $('#status').textContent = '地圖生成完畢！點擊學生格子可記點，投擲骰子開始抽籤！';
  hideBubble();
}

function tileText(t) {
  if (t.kind === 'chance') return '機會';
  if (t.kind === 'fate') return '命運';
  if (t.kind === 'door') return '任意門';
  if (t.kind === 'student') return t.name;
  return '空';
}

function setTileContent(tile, t, isTopBottom = false) {
  tile.classList.toggle('tile-vertical', isTopBottom);
  if (t.kind !== 'student') {
    tile.textContent = tileText(t);
    return;
  }
  tile.classList.add('student-tile', isTopBottom ? 'student-vertical' : 'student-horizontal');
  let raw = String(t.name || '').trim(), match = raw.match(/^(\d{1,3})\s*(.+)$/);
  let seat = document.createElement('span'), name = document.createElement('span');
  seat.className = 'tile-seat';
  name.className = 'tile-name';
  if (match) {
    seat.textContent = match[1];
    name.textContent = match[2].trim();
    tile.append(seat, name);
  } else {
    name.textContent = raw;
    tile.append(name);
  }

  // 學生記點徽章
  let studentScore = todayScores[t.name]?.total || 0;
  if (studentScore !== 0) {
    let badge = document.createElement('span');
    badge.className = 'score-badge ' + (studentScore > 0 ? 'positive' : 'negative');
    badge.textContent = (studentScore > 0 ? '+' : '') + studentScore;
    tile.append(badge);
  }
}

// 渲染棋盤
function renderBoard() {
  let b = $('#board'), g = $('#game');
  let { cols, rows } = boardShape(tiles.length);
  let scale = Math.max(.62, Math.min(1.18, 42 / tiles.length));

  g.style.setProperty('--seat-size', `${20 * scale}px`);
  g.style.setProperty('--vertical-name-size', `${31 * scale}px`);
  g.style.setProperty('--horizontal-text-size', `${24 * scale}px`);
  g.style.setProperty('--vertical-special-size', `${31 * scale}px`);
  g.style.setProperty('--horizontal-special-size', `${26 * scale}px`);

  if (window.innerWidth > 850) {
    g.style.gridTemplateColumns = `repeat(${cols},minmax(0,1fr))`;
    g.style.gridTemplateRows = `repeat(${rows},minmax(0,1fr))`;
    $('.center-panel').style.gridColumn = `2/${cols}`;
    $('.center-panel').style.gridRow = `2/${rows}`;
  }

  b.replaceChildren();
  let side = rows - 2;

  tiles.forEach((t, i) => {
    let d = document.createElement('div');
    d.className = 'tile ' + (t.kind === 'chance' ? 'special-chance' : t.kind === 'fate' ? 'special-fate' : t.kind === 'door' ? 'door' : 'pastel');
    d.dataset.index = i;

    let row, col;
    if (i < cols) { row = 1; col = i + 1; }
    else if (i < cols + side) { row = i - cols + 2; col = cols; }
    else if (i < cols + side + cols) { let n = i - cols - side; row = rows; col = cols - n; }
    else { let n = i - (2 * cols + side); row = rows - 1 - n; col = 1; }

    let isTopBottom = row === 1 || row === rows;
    setTileContent(d, t, isTopBottom);
    d.style.gridRow = row;
    d.style.gridColumn = col;
    if (isTopBottom && (col === 1 || col === cols)) d.classList.add('corner');

    // 格子事件：學生格子點擊正常記點，絕不露出任何破綻
    if (t.kind === 'student') {
      d.classList.add('student-tile');
      d.title = ''; // 保持乾淨，滑鼠懸停不洩漏任何提示字眼
      // 一般點擊：彈出記點氣泡；若剛點過 ★/☆，則完全沒有反應（暗中設定）
      d.onclick = (e) => {
        e.stopPropagation();
        if (starMode) { applyStarToStudent(t); return; }
        showTileBubble(t, d);
      };
      d.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); };
    }
    b.append(d);
  });

  autoFitAllTiles();
}

// 根據格子真實寬高與字數，動態自適應調整字體大小 (保證絕不超出格子)
function autoFitAllTiles() {
  requestAnimationFrame(() => {
    $$('.tile.student-tile').forEach(tile => {
      let isVertical = tile.classList.contains('student-vertical');
      let seat = tile.querySelector('.tile-seat');
      let name = tile.querySelector('.tile-name');
      if (!name) return;

      let tileW = tile.clientWidth;
      let tileH = tile.clientHeight;
      if (tileW <= 0 || tileH <= 0) return;

      let nameText = name.textContent.trim();
      let charCount = Math.max(1, [...nameText].length);

      if (isVertical) {
        let seatH = seat ? seat.offsetHeight : 0;
        let availH = Math.max(10, tileH - seatH - 6);
        let availW = Math.max(10, tileW - 6);

        let maxHPerChar = availH / charCount;
        let maxW = availW * 0.85;
        let bestFs = Math.max(9, Math.min(24, Math.floor(Math.min(maxHPerChar, maxW))));

        name.style.fontSize = `${bestFs}px`;
        name.style.lineHeight = '1.05';
        if (seat) seat.style.fontSize = `${Math.max(9, Math.min(14, Math.floor(bestFs * 0.8)))}px`;
      } else {
        let seatW = seat ? seat.offsetWidth : 0;
        let availW = Math.max(10, tileW - seatW - 6);
        let availH = Math.max(10, tileH - 6);

        let maxWPerChar = availW / charCount;
        let maxH = availH * 0.75;
        let bestFs = Math.max(9, Math.min(22, Math.floor(Math.min(maxWPerChar, maxH))));

        name.style.fontSize = `${bestFs}px`;
        name.style.lineHeight = '1.05';
        if (seat) seat.style.fontSize = `${Math.max(9, Math.min(14, Math.floor(bestFs * 0.82)))}px`;
      }
    });

    $$('.tile:not(.student-tile)').forEach(tile => {
      let w = tile.clientWidth;
      let h = tile.clientHeight;
      if (w <= 0 || h <= 0) return;
      let isVert = tile.classList.contains('tile-vertical');
      let fs = isVert ? Math.min(h / 3.4, w * 0.82) : Math.min(h * 0.65, w / 3.4);
      tile.style.fontSize = `${Math.max(10, Math.min(22, Math.floor(fs)))}px`;
    });
  });
}

window.addEventListener('resize', autoFitAllTiles);

function setPosition(p) {
  position = (p + tiles.length) % tiles.length;
  $$('.tile').forEach(e => e.classList.toggle('highlight', +e.dataset.index === position));
  $('#status').textContent = `移動到第 ${position + 1} 格：${tileText(tiles[position])}`;
}

async function moveSteps(steps, delay = 280) {
  if (busy) return;
  busy = true;
  for (let i = 0; i < steps; i++) {
    setPosition(position + 1);
    await new Promise(r => setTimeout(r, delay));
  }
  await resolveLanding(true);
  busy = false;
}

// 降落判定
async function resolveLanding(allowDoor = false) {
  let t = tiles[position];
  if (!t) return;
  if ((t.kind === 'chance' || t.kind === 'fate') && !ignoreSpecial) {
    let student = plannedLanding.cardStudent || randomPickableName();
    plannedLanding = { doorTo: null, cardStudent: null };
    if (student !== '同學') markPicked(student);
    draw(t.kind, student);
    return;
  }
  if (t.kind === 'door' && !ignoreSpecial && allowDoor) {
    let p = plannedLanding.doorTo ?? randomDoorDestination();
    plannedLanding = { doorTo: null, cardStudent: null };
    setPosition(p);
    $('#status').textContent = `任意門！跳到第 ${p + 1} 格`;
    await resolveLanding(false);
    return;
  }
  if (t.kind === 'student' && isPickable(t)) {
    markPicked(t.name);
    winnerTile = t;
    $('#winnerName').textContent = t.name;

    // 檢查是否有生效中的 Buff
    let buffAlert = $('#winnerBuffAlert');
    if (activeBuff) {
      buffAlert.textContent = `🔥 機會/命運加成生效中：${activeBuff.text}`;
      buffAlert.classList.remove('hidden');
    } else {
      buffAlert.classList.add('hidden');
    }

    $('#winnerDialog').showModal();
    $('#status').textContent = `本次幸運星：${t.name}`;
  }
}

// 投擲骰子與跑馬燈
async function roll() {
  if (busy) return;
  busy = true;
  hideBubble();
  let button = $('#roll'), dice = $('.dice-results');
  button.disabled = true;
  $('#dicePlus').disabled = true;
  $('#diceMinus').disabled = true;
  dice.classList.add('rolling');
  $('#status').textContent = '🎲 骰子轉動中…';

  let [max1, max2] = diceFaces();
  let spin = setInterval(() => {
    $('#die1').textContent = 1 + Math.floor(Math.random() * max1);
    $('#die2').textContent = max2 ? 1 + Math.floor(Math.random() * max2) : '–';
  }, 85);

  await new Promise(r => setTimeout(r, 1250));
  clearInterval(spin);

  let cur = position < 0 ? 0 : position;
  // 列出所有可能的骰子結果，再依暗中設定挑一組（顯示的點數＝實際步數）
  let options = [];
  for (let a = 1; a <= max1; a++) {
    if (!max2) options.push({ d1: a, d2: 0, steps: a });
    else for (let b = 1; b <= max2; b++) options.push({ d1: a, d2: b, steps: a + b });
  }
  let { opt } = planMove(options, cur);
  let d1 = opt.d1, d2 = opt.d2, steps = opt.steps;

  $('#die1').textContent = d1;
  $('#die2').textContent = d2 || '–';
  dice.classList.remove('rolling');
  button.disabled = false;
  $('#dicePlus').disabled = false;
  $('#diceMinus').disabled = false;

  if (position < 0) position = 0;
  $('#status').textContent = `擲出 ${steps} 點，逐格前進…`;
  busy = false;
  await moveSteps(steps);
}

async function race() {
  if (busy || position < 0) return;
  hideBubble();
  let cur = position < 0 ? 0 : position;
  // 跑馬燈一般前進 10~23 格；有指定目標時，若範圍內到不了，就多跑一圈直接停在他身上
  let options = [];
  for (let s = 10; s <= 23; s++) options.push({ steps: s });
  let target = currentTargetTile();
  if (target) {
    let n = tiles.length, diff = (tiles.indexOf(target) - cur + n) % n;
    while (diff < 10) diff += n;
    if (!options.some(o => o.steps === diff)) options.push({ steps: diff });
  }
  let { opt } = planMove(options, cur);
  let steps = opt.steps;

  $('#status').textContent = `跑馬燈前進 ${steps} 格…`;
  await moveSteps(steps, 110);
}

// ============================================================
// 課堂記點核心功能 (Scoring System)
// ============================================================
function addStudentScore(studentName, delta, reason = '課堂記點') {
  delta = parseInt(delta, 10);
  if (isNaN(delta) || !studentName) return;

  if (!todayScores[studentName]) {
    todayScores[studentName] = { total: 0, logs: [] };
  }
  todayScores[studentName].total += delta;
  todayScores[studentName].logs.push({
    delta,
    reason,
    time: new Date().toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' })
  });

  // 更新棋盤徽章
  renderBoard();
  setPosition(position);

  // 提示浮動提示
  let sign = delta > 0 ? `+${delta}` : `${delta}`;
  let cfg = getGoogleSheetConfig();
  let sheetNote = (cfg.enabled && cfg.url) ? ' ☁️試算表已同步' : '';
  toast(`${studentName} ${reason}（${sign}分，目前 ${todayScores[studentName].total}分）${sheetNote}`);

  // 即時同步至 Google 試算表
  syncScoreToGoogleSheet({
    time: new Date().toLocaleString('zh-TW', { hour12: false }),
    className: currentClassName,
    studentName,
    delta,
    reason,
    total: todayScores[studentName].total
  });
}

function addClassScore(delta, reason = '全班獎勵') {
  delta = parseInt(delta, 10);
  if (isNaN(delta)) return;

  let nowTime = new Date().toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
  let nowFullTime = new Date().toLocaleString('zh-TW', { hour12: false });

  state.names.forEach(name => {
    let clean = name.replace(/#.*$/, '').replace(/[\(（].*[\)）]/, '').trim();
    if (!clean) return;
    if (!todayScores[clean]) todayScores[clean] = { total: 0, logs: [] };
    todayScores[clean].total += delta;
    todayScores[clean].logs.push({
      delta,
      reason,
      time: nowTime
    });

    syncScoreToGoogleSheet({
      time: nowFullTime,
      className: currentClassName,
      studentName: clean,
      delta,
      reason,
      total: todayScores[clean].total
    });
  });

  renderBoard();
  setPosition(position);
  let cfg = getGoogleSheetConfig();
  let sheetNote = (cfg.enabled && cfg.url) ? ' ☁️已同步試算表' : '';
  toast(`🎉 全班每人 ${delta > 0 ? '+' : ''}${delta} 分！（${reason}）${sheetNote}`);
}

function showFloatPop(tileElement, delta) {
  if (!tileElement) return;
  let pop = document.createElement('div');
  pop.className = 'floating-score-pop ' + (delta >= 0 ? 'pos' : 'neg');
  pop.textContent = (delta >= 0 ? '+' : '') + delta;
  tileElement.append(pop);
  setTimeout(() => pop.remove(), 1100);
}

// ============================================================
// 方案 B：點擊棋盤格子「就地彈出小氣泡」 (Tile Bubble)
// ============================================================
function refreshBubbleHeader() {
  if (!currentBubbleTile) return;
  let t = currentBubbleTile.tile;
  let curScore = todayScores[t.name]?.total || 0;
  $('#bubbleStudentName').textContent = t.name;
  $('#bubbleStudentScore').textContent = `目前: ${curScore >= 0 ? '+' : ''}${curScore}分`;
}

function showTileBubble(studentTile, element) {
  currentBubbleTile = { tile: studentTile, el: element };
  let bubble = $('#tileBubble');
  let rect = element.getBoundingClientRect();

  refreshBubbleHeader();
  $('#customScoreInput').value = '';
  $('#customReasonInput').value = '';

  // 暫時顯示以獲取氣泡當前實際高度（預設約 280px）
  bubble.classList.remove('hidden');
  const bubbleHeight = bubble.offsetHeight || 280;
  const bubbleWidth = bubble.offsetWidth || 290;

  // 1. 垂直防遮擋：若上方空間小於氣泡高度（大富翁上排格子），自動翻轉到格子下方彈出
  const spaceAbove = rect.top;
  if (spaceAbove < bubbleHeight + 16) {
    bubble.classList.add('bubble-bottom');
    bubble.style.top = `${rect.bottom}px`;
  } else {
    bubble.classList.remove('bubble-bottom');
    bubble.style.top = `${rect.top}px`;
  }

  // 2. 水平防遮擋：避免左側或右側邊緣超出螢幕
  const halfWidth = bubbleWidth / 2;
  const targetCenterX = rect.left + rect.width / 2;
  const minX = halfWidth + 10;
  const maxX = window.innerWidth - halfWidth - 10;
  const clampedX = Math.max(minX, Math.min(targetCenterX, maxX));

  bubble.style.left = `${clampedX}px`;

  // 3. 箭頭微調：讓指示三角形始終精確指向學生格子中心
  const arrowShift = Math.max(-halfWidth + 20, Math.min(halfWidth - 20, targetCenterX - clampedX));
  bubble.style.setProperty('--arrow-shift', `${arrowShift}px`);
}

function hideBubble() {
  $('#tileBubble').classList.add('hidden');
  currentBubbleTile = null;
}

$('#bubbleClose').onclick = hideBubble;
document.addEventListener('click', (e) => {
  if (!e.target.closest('#tileBubble') && !e.target.closest('.student-tile')) {
    hideBubble();
  }
});

// 氣泡快速標籤點擊
$$('.bubble-tags .tag-btn').forEach(btn => {
  btn.onclick = () => {
    if (!currentBubbleTile) return;
    let score = +btn.dataset.score;
    let reason = btn.dataset.reason;
    addStudentScore(currentBubbleTile.tile.name, score, reason);
    showFloatPop(currentBubbleTile.el, score);
    hideBubble();
  };
});

// 氣泡自訂分數
$('#customScoreBtn').onclick = () => {
  if (!currentBubbleTile) return;
  let score = +$('#customScoreInput').value;
  let reason = $('#customReasonInput').value.trim() || (score >= 0 ? '表現優良' : '課堂提醒');
  if (isNaN(score) || score === 0) {
    toast('請輸入有效的分數 (如: 5 或 -2)');
    return;
  }
  addStudentScore(currentBubbleTile.tile.name, score, reason);
  showFloatPop(currentBubbleTile.el, score);
  hideBubble();
};

// 骰子旁的 ★ / ☆ 裝飾星星：點一下進入暗中設定，長按 2 秒開啟課前名單設定
[['#starMust', 'must'], ['#starNever', 'never']].forEach(([sel, mode]) => {
  let el = $(sel);
  if (!el) return;
  bindLongPress(el, 2000, openSecretDialog);
  el.addEventListener('click', (e) => {
    if (el._longFired) { el._longFired = false; return; }
    hideBubble();
    setStarMode(starMode === mode ? null : mode);
  });
});
bindLongPress($('#bannerClassTitle'), 2000, openSecretDialog);
$('#closeSecret').onclick = () => $('#secretDialog').close();
$('#secretResetPicked').onclick = () => {
  let s = loadStealth();
  s.lesson.picked = [];
  saveStealth(s);
  openSecretDialog();
  toast('已重設今天的已抽紀錄');
};

// ============================================================
// 方案 C：幸運星彈窗快捷評分 (Winner Scoring)
// ============================================================
$$('.scoring-buttons .score-btn').forEach(btn => {
  btn.onclick = () => {
    if (!winnerTile) return;
    let delta = +btn.dataset.score;
    let reason = btn.dataset.reason;

    // 若有生效中的 Buff
    if (activeBuff) {
      if (activeBuff.type === 'multiply' && delta > 0) {
        delta *= activeBuff.factor;
        reason += `（觸發加倍 ×${activeBuff.factor}）`;
      } else if (activeBuff.type === 'class_add') {
        addClassScore(activeBuff.delta, `幸運星加成：${activeBuff.text}`);
      }
      activeBuff = null;
      $('#buffBanner').classList.add('hidden');
    }

    if (delta !== 0) {
      addStudentScore(winnerTile.name, delta, reason);
    } else {
      toast(`已記錄 ${winnerTile.name}：${reason}`);
    }
    $('#winnerDialog').close();
    winnerTile = null;
  };
});

// 保留名單與移除此人
$('#keepWinner').onclick = () => {
  $('#winnerDialog').close();
  winnerTile = null;
};

$('#removeWinner').onclick = () => {
  if (winnerTile) {
    winnerTile.removed = true;
    let index = tiles.indexOf(winnerTile);
    renderBoard();
    setPosition(index);
    toast(`${winnerTile.name} 已暫時移除，點擊深色格可恢復`);
  }
  $('#winnerDialog').close();
  winnerTile = null;
};

new MutationObserver(() => {
  $('#winnerDialog').open ? startFireworks() : stopFireworks();
}).observe($('#winnerDialog'), { attributes: true, attributeFilter: ['open'] });

// ============================================================
// 機會與命運智能動態辨識與給分 (Dynamic Card Parser)
// ============================================================
function parseCardAction(text, targetStudent) {
  let actions = [];
  // 1. 全班加分: "全班每人加1分", "全班加5分", "全班各加2分"
  let matchClass = text.match(/全班.*(?:加|\+)\s*(\d+)\s*分?/);
  if (matchClass) {
    let d = +matchClass[1];
    actions.push({
      label: `⚡ 一鍵執行：全班各 +${d} 分`,
      action: () => addClassScore(d, `抽中卡牌：${text}`)
    });
  }

  // 2. 個人加分: "加1分", "加5分", "+3", "平時成績直接加5分"
  let matchAdd = text.match(/(?:加|\+)\s*(\d+)\s*分?/);
  if (matchAdd && !matchClass) {
    let d = +matchAdd[1];
    actions.push({
      label: `🎯 一鍵執行：幫 ${targetStudent} +${d} 分`,
      action: () => addStudentScore(targetStudent, d, `抽中卡牌：${text}`)
    });
  }

  // 3. 個人扣分: "扣1分", "扣3分", "-2", "睡覺-3"
  let matchSub = text.match(/(?:扣|\-)\s*(\d+)\s*分?/);
  if (matchSub) {
    let d = -Math.abs(+matchSub[1]);
    actions.push({
      label: `⚠️ 一鍵執行：幫 ${targetStudent} ${d} 分`,
      action: () => addStudentScore(targetStudent, d, `抽中卡牌：${text}`)
    });
  }

  // 4. 加倍
  if (text.includes('加倍') || text.includes('雙倍') || text.includes('翻倍')) {
    actions.push({
      label: `💥 掛上 Buff：下一位答對分數加倍！`,
      action: () => {
        activeBuff = { type: 'multiply', factor: 2, text: '答對分數翻倍！' };
        $('#buffBanner').textContent = '🔥 狀態生效中：下一位幸運星答對分數加倍 (×2)！';
        $('#buffBanner').classList.remove('hidden');
        toast('已啟用 Buff：下一位答對分數加倍！');
      }
    });
  }

  return actions;
}

function draw(kind, student = '下一位抽到的同學') {
  let cards = state[kind] || [];
  if (!cards.length) { toast('請先新增卡牌內容'); return; }

  let rawCard = cards[Math.floor(Math.random() * cards.length)];
  let text = rawCard.replaceAll('下一位抽到的同學', student);

  $('#resultType').textContent = kind === 'chance' ? '✦ 機會卡' : '✧ 命運卡';
  $('#resultText').textContent = text;
  $('#resultStudent').textContent = student === '下一位抽到的同學' ? '' : `指名對象：${student}`;

  // 智能按鈕解析
  let wrap = $('#autoActionWrap');
  let btnContainer = $('#autoActionButtons');
  btnContainer.replaceChildren();

  let actions = parseCardAction(text, student);
  if (actions.length) {
    actions.forEach(act => {
      let b = document.createElement('button');
      b.className = 'auto-btn';
      b.textContent = act.label;
      b.onclick = () => {
        act.action();
        $('#cardResult').close();
      };
      btnContainer.append(b);
    });
    wrap.classList.remove('hidden');
  } else {
    wrap.classList.add('hidden');
  }

  $('#cardResult').showModal();
  $('#' + (kind === 'chance' ? 'lastChance' : 'lastFate')).textContent = text;
  $('#status').textContent = `${student} 抽到${kind === 'chance' ? '機會' : '命運'}！`;
}

// 兜底自由給分列
$('#cardGivePlus1').onclick = () => { let s = $('#resultStudent').textContent.replace('指名對象：', '') || '同學'; addStudentScore(s, 1, '機會命運加分'); $('#cardResult').close(); };
$('#cardGivePlus2').onclick = () => { let s = $('#resultStudent').textContent.replace('指名對象：', '') || '同學'; addStudentScore(s, 2, '機會命運加分'); $('#cardResult').close(); };
$('#cardGivePlus5').onclick = () => { let s = $('#resultStudent').textContent.replace('指名對象：', '') || '同學'; addStudentScore(s, 5, '機會命運加分'); $('#cardResult').close(); };
$('#cardGiveClassPlus1').onclick = () => { addClassScore(1, '機會命運全班加分'); $('#cardResult').close(); };
$('#cardGiveClassPlus5').onclick = () => { addClassScore(5, '機會命運全班加分'); $('#cardResult').close(); };
$('#cardGiveMinus1').onclick = () => { let s = $('#resultStudent').textContent.replace('指名對象：', '') || '同學'; addStudentScore(s, -1, '機會命運扣分'); $('#cardResult').close(); };
$('#cardGiveMinus2').onclick = () => { let s = $('#resultStudent').textContent.replace('指名對象：', '') || '同學'; addStudentScore(s, -2, '機會命運扣分'); $('#cardResult').close(); };

$('#closeResult').onclick = () => $('#cardResult').close();
$('#resultOk').onclick = () => $('#cardResult').close();

function quickEditMemo() {
  let prog = getSlotProgressData(currentSlotIndex);
  let oldMemo = prog.nextHomework || '';
  let newMemo = prompt(`【${currentClassName}】輸入／修改備忘事項（下次待辦或作業）：`, oldMemo);
  if (newMemo !== null && newMemo.trim() !== oldMemo) {
    prog.nextHomework = newMemo.trim();
    memoMarkWritten(prog);
    saveSlotProgressData(currentSlotIndex, prog);
    updateProgressBanners();
    toast(`已更新【${currentClassName}】備忘事項！`);
  }
}

// ============================================================
// 下課進度結算與課堂日誌 (End of Class Checkout)
// ============================================================
function openCheckoutDialog() {
  updateProgressBanners();
  let prog = getSlotProgressData(currentSlotIndex);
  $('#todayProgressInput').value = '';
  // 今天寫的備忘照樣帶入；之前寫的備忘已經用過了，不再帶入（不填就會清掉），只用淡字提示
  let memoFromToday = prog.nextHomework && prog.memoDate === todayStr();
  $('#nextHomeworkInput').value = memoFromToday ? prog.nextHomework : '';
  $('#nextHomeworkInput').placeholder = (!memoFromToday && prog.nextHomework)
    ? `上次的備忘：${prog.nextHomework}（不填會清掉，需要的話請重新輸入）`
    : '例：習作 P.15~16、下次抽考單字';
  $('#todayRemarksInput').value = '';

  // 渲染今日學生記點清單
  let list = $('#scoreSummaryList');
  list.replaceChildren();

  let entries = Object.entries(todayScores).filter(([_, data]) => data.total !== 0 || data.logs.length > 0);
  if (!entries.length) {
    list.innerHTML = '<div class="empty-hint">今日尚無加扣分記錄</div>';
  } else {
    // 依分數高低排序
    entries.sort((a, b) => b[1].total - a[1].total);
    entries.forEach(([name, data]) => {
      let item = document.createElement('div');
      item.className = 'summary-item';
      let reasons = data.logs.map(l => `${l.reason}(${l.delta > 0 ? '+' : ''}${l.delta})`).join('、');
      item.innerHTML = `
        <div>
          <strong>${name}</strong>
          <small style="display:block;color:#788ea8;font-size:11px;">${reasons}</small>
        </div>
        <span class="score-tag ${data.total >= 0 ? 'pos' : 'neg'}">${data.total >= 0 ? '+' : ''}${data.total} 分</span>
      `;
      list.append(item);
    });
  }

  $('#checkoutDialog').showModal();
}

$('#endClassBtn').onclick = openCheckoutDialog;

$('#saveCheckoutBtn').onclick = () => {
  let todayProg = $('#todayProgressInput').value.trim();
  if (!todayProg) {
    toast('請輸入「今日授課進度」（如：第二章觀念結束）');
    $('#todayProgressInput').focus();
    return;
  }

  let todaySlide = +$('#todaySlideNumber').value || 0;
  if (!todaySlide) {
    let m = todayProg.match(/(?:p|page|第)?\s*(\d+)\s*(?:頁|p)?/i);
    if (m) todaySlide = +m[1];
  }
  if (!todaySlide) todaySlide = 1;

  let nextHw = $('#nextHomeworkInput').value.trim();
  let remarks = $('#todayRemarksInput').value.trim();
  let now = new Date();
  let dateStr = `${now.getMonth() + 1}/${now.getDate()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  let progData = getSlotProgressData(currentSlotIndex);
  let record = {
    date: dateStr,
    progress: todayProg,
    slide: todaySlide,
    homework: nextHw,
    remarks,
    scoresSummary: { ...todayScores }
  };

  progData.history.unshift(record);
  progData.lastProgress = todayProg;
  progData.lastSlide = todaySlide;
  if (nextHw) {
    progData.nextHomework = nextHw;
    memoMarkWritten(progData);
  } else if (!(progData.nextHomework && progData.memoDate === todayStr())) {
    progData.nextHomework = '';
    memoMarkWritten(progData);
  }
  progData.lastDate = dateStr;

  saveSlotProgressData(currentSlotIndex, progData);
  updateProgressBanners();
  $('#checkoutDialog').close();
  toast(`🎉 已成功保存【${currentClassName}】下課進度（第 ${todaySlide} 頁）！`);
};

// ============================================================
// 一鍵開啟 PPT 自動跳頁功能 (PowerPoint Auto-Jump)
// ============================================================
function launchPpt(slideNum) {
  memoMarkClassHeld(currentSlotIndex);
  let prog = getSlotProgressData(currentSlotIndex);
  let path = prog.pptPath;

  // 網頁 / iPad 版：PDF 用內建閱讀器；PPT 交給 PowerPoint / Keynote
  if (IS_WEB_BUILD) {
    if (!path) {
      toast('請先選擇這個班級上課用的 PDF 或 PPT');
      $('#pdfStorePicker').click();
      return;
    }
    if (/\.pptx?$/i.test(path)) {
      let isGame = !$('#game').classList.contains('hidden');
      let typed = parseInt((isGame ? $('#gameSlideInput') : $('#setupSlideInput'))?.value) || 0;
      openStoredPpt(slideNum || typed || prog.lastSlide || 1);
    } else {
      openPdfViewer(slideNum || prog.lastSlide || 1);
    }
    return;
  }

  if (!path) {
    $('#pptPathInput').value = '';
    $('#bindPptDialog').showModal();
    toast('請先設定此班級的 PPT 檔案路徑');
    return;
  }

  // 若未指定頁數，優先使用當前畫面上輸入框輸入的數值，若無則使用存檔中的上次頁數
  let isGameVisible = !$('#game').classList.contains('hidden');
  let currentInputVal = isGameVisible
    ? (parseInt($('#gameSlideInput')?.value) || 0)
    : (parseInt($('#setupSlideInput')?.value) || 0);

  let targetSlide = slideNum || currentInputVal || prog.lastSlide || 1;
  let uri = `pptjump://open?file=${encodeURIComponent(path)}&slide=${targetSlide}`;

  let appName = /\.pdf$/i.test(path) ? 'Adobe Acrobat' : 'PowerPoint';
  toast(`🚀 正在呼叫 ${appName}（第 ${targetSlide} 頁）... 若上方彈出「要開啟應用程式嗎？」請按【開啟】！`);

  // 使用隱藏 <a> 觸發以確保相容性
  let a = document.createElement('a');
  a.href = uri;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1200);
}

function quickSaveSlideProgress(slideNumber) {
  let s = Math.max(1, parseInt(slideNumber) || 1);
  memoMarkClassHeld(currentSlotIndex);
  let progData = getSlotProgressData(currentSlotIndex);
  let now = new Date();
  let dateStr = `${now.getMonth() + 1}/${now.getDate()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  
  progData.lastSlide = s;
  progData.lastDate = dateStr;
  progData.lastProgress = `授課至第 ${s} 頁`;

  // 寫入一條歷史記錄
  progData.history.unshift({
    date: dateStr,
    progress: `授課至第 ${s} 頁`,
    slide: s,
    homework: progData.nextHomework || '',
    remarks: `${bindKindLabel(progData)} 快捷儲存進度`,
    scoresSummary: { ...todayScores }
  });

  saveSlotProgressData(currentSlotIndex, progData);
  updateProgressBanners();
  let nextHint = (IS_WEB_BUILD && bindKindLabel(progData) === 'PPT')
    ? `下次開啟 PPT 時會提醒你第 ${s} 頁。`
    : `下次開啟${bindKindLabel(progData)}將直接從第 ${s} 頁開始。`;
  toast(`🎉 已成功儲存【${currentClassName}】進度至第 ${s} 頁！${nextHint}`);
}

$('#openPptBtn').onclick = () => launchPpt();
$('#gameOpenPptBtn').onclick = () => launchPpt();

if ($('#setupSaveSlideBtn')) {
  $('#setupSaveSlideBtn').onclick = () => quickSaveSlideProgress($('#setupSlideInput').value);
}
if ($('#gameSaveSlideBtn')) {
  $('#gameSaveSlideBtn').onclick = () => quickSaveSlideProgress($('#gameSlideInput').value);
}

$('#setupSlideInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') quickSaveSlideProgress($('#setupSlideInput').value);
});
$('#gameSlideInput')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') quickSaveSlideProgress($('#gameSlideInput').value);
});

$('#bindPptBtn').onclick = () => {
  if (IS_WEB_BUILD) { $('#pdfStorePicker').click(); return; }
  let prog = getSlotProgressData(currentSlotIndex);
  $('#pptPathInput').value = prog.pptPath || '';
  $('#bindPptDialog').showModal();
};

function saveBannerMemo() {
  let val = ($('#setupMemoInput')?.value || '').trim();
  let prog = getSlotProgressData(currentSlotIndex);
  if (prog.nextHomework !== val) {
    prog.nextHomework = val;
    memoMarkWritten(prog);
  }
  saveSlotProgressData(currentSlotIndex, prog);
  updateProgressBanners();
  toast(val ? `🎉 已成功儲存【${currentClassName}】備忘錄：${val}` : `已清空【${currentClassName}】備忘事項`);
}

if ($('#setupSaveMemoBtn')) $('#setupSaveMemoBtn').onclick = saveBannerMemo;
if ($('#setupMemoInput')) {
  $('#setupMemoInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBannerMemo();
  });
}

if ($('#headProgressBadge')) {
  $('#headProgressBadge').style.cursor = 'pointer';
  $('#headProgressBadge').onclick = quickEditMemo;
}

$('#pptFilePicker').onchange = (e) => {
  if (e.target.files.length) {
    $('#pptPathInput').value = e.target.files[0].name;
    toast(`已選取檔案：${e.target.files[0].name}（請確保該檔案在此工具資料夾內）`);
  }
};

$('#closeBindPpt').onclick = () => $('#bindPptDialog').close();

function savePptBinding() {
  let p = $('#pptPathInput').value.trim().replace(/^["']|["']$/g, '');
  if (!p) {
    toast('請輸入 PPT 或 PDF 的完整檔案路徑或檔案名稱');
    return null;
  }
  let prog = getSlotProgressData(currentSlotIndex);
  prog.pptPath = p;
  saveSlotProgressData(currentSlotIndex, prog);
  updateProgressBanners();
  return p;
}

$('#saveBindPpt').onclick = () => {
  if (savePptBinding()) {
    $('#bindPptDialog').close();
    toast(`已成功儲存此班 ${bindKindLabel(getSlotProgressData(currentSlotIndex))} 綁定！點擊按鈕即可一鍵跳頁。`);
  }
};

$('#saveAndTestPpt').onclick = () => {
  if (savePptBinding()) {
    $('#bindPptDialog').close();
    launchPpt();
  }
};

// ============================================================
// 內建 PDF 閱讀器（網頁 / iPad 版）：PDF 存在這台裝置裡，翻頁自動記住頁數
// ============================================================
const PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let pdfjsLoading = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfjsLoading) {
    pdfjsLoading = new Promise((resolve, reject) => {
      let s = document.createElement('script');
      s.src = PDFJS_BASE + 'pdf.min.js';
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';
        resolve(window.pdfjsLib);
      };
      s.onerror = () => { pdfjsLoading = null; s.remove(); reject(new Error('pdfjs')); };
      document.head.appendChild(s);
    });
  }
  return pdfjsLoading;
}

function pdfDb() {
  return new Promise((resolve, reject) => {
    let r = indexedDB.open('cockpit-pdf', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function pdfStoreGet(idx) {
  let db = await pdfDb();
  return new Promise((resolve, reject) => {
    let q = db.transaction('files', 'readonly').objectStore('files').get('slot-' + idx);
    q.onsuccess = () => resolve(q.result || null);
    q.onerror = () => reject(q.error);
  });
}
async function pdfStorePut(idx, rec) {
  let db = await pdfDb();
  return new Promise((resolve, reject) => {
    let tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(rec, 'slot-' + idx);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let pv = {
  doc: null, docSlot: null, docName: '', page: 1, openedAt: 1, total: 0,
  renderToken: 0, saveTimer: null, fadeTimer: null, hiresTimer: null,
  baseW: 0, baseH: 0, zoom: 1, renderZoom: 1, renderTarget: 1, x: 0, y: 0, canvas: null
};
const PV_MAX_ZOOM = 5;
const PV_MAX_PIXELS = 12e6; // iPad 的畫布有大小上限，放大時降低解析度避免當掉

function pvMsg(text) { $('#pdfMsg').textContent = text || ''; }
function pvShowBar() {
  $('#pdfBar').classList.remove('faded');
  clearTimeout(pv.fadeTimer);
  pv.fadeTimer = setTimeout(() => $('#pdfBar').classList.add('faded'), 3500);
}
function pvStageSize() {
  let s = $('#pdfStage');
  return [s.clientWidth || window.innerWidth, s.clientHeight || window.innerHeight];
}
function pvClamp() {
  let [W, H] = pvStageSize();
  let cw = pv.baseW * pv.zoom, ch = pv.baseH * pv.zoom;
  pv.x = cw <= W ? (W - cw) / 2 : Math.min(0, Math.max(W - cw, pv.x));
  pv.y = ch <= H ? (H - ch) / 2 : Math.min(0, Math.max(H - ch, pv.y));
}
function pvApply() {
  pvClamp();
  if (pv.canvas) pv.canvas.style.transform = `translate(${pv.x}px, ${pv.y}px) scale(${pv.zoom / pv.renderZoom})`;
  let zb = $('#pdfFit');
  if (zb) zb.textContent = pv.zoom > 1.01 ? `${Math.round(pv.zoom * 100)}%` : '全頁';
}
function pvScheduleHires() {
  clearTimeout(pv.hiresTimer);
  pv.hiresTimer = setTimeout(() => {
    if (Math.abs(pv.zoom - pv.renderTarget) > 0.05) pvRender(true);
  }, 250);
}
function pvSetZoom(z, cx, cy) {
  if (!pv.doc) return;
  let [W, H] = pvStageSize();
  if (cx == null) { cx = W / 2; cy = H / 2; }
  z = Math.min(PV_MAX_ZOOM, Math.max(1, z));
  let k = z / pv.zoom;
  pv.x = cx - (cx - pv.x) * k;
  pv.y = cy - (cy - pv.y) * k;
  pv.zoom = z;
  pvApply();
  pvScheduleHires();
}

async function openPdfViewer(startPage) {
  let viewer = $('#pdfViewer');
  viewer.classList.remove('hidden');
  viewer.setAttribute('aria-hidden', 'false');
  $('#pdfStage').replaceChildren();
  pv.canvas = null;
  pvMsg('PDF 載入中…');
  pvShowBar();
  try {
    let rec = await pdfStoreGet(currentSlotIndex);
    if (!rec || !rec.data) {
      pvMsg('這台裝置裡找不到這個班級的 PDF。\n請關閉後按「📁 選擇 PDF」重新選一次。');
      return;
    }
    if (!pv.doc || pv.docSlot !== currentSlotIndex || pv.docName !== rec.name) {
      let lib = await loadPdfJs();
      if (pv.doc) { try { pv.doc.destroy(); } catch {} }
      pv.doc = await lib.getDocument({ data: new Uint8Array(rec.data.slice(0)) }).promise;
      pv.docSlot = currentSlotIndex;
      pv.docName = rec.name;
    }
    pv.total = pv.doc.numPages;
    pv.page = Math.min(Math.max(1, parseInt(startPage) || 1), pv.total);
    pv.openedAt = pv.page;
    pvMsg('');
    await pvRender(false);
  } catch (e) {
    pvMsg(String(e && e.message) === 'pdfjs'
      ? 'PDF 閱讀器載入失敗，請確認網路連線後再試一次。'
      : 'PDF 無法開啟，請確認檔案沒有損壞，或重新選擇 PDF。');
  }
}

// keepView=false：換頁，回到全頁；keepView=true：保持目前的放大位置，只把畫面重新畫清楚
async function pvRender(keepView) {
  if (!pv.doc) return;
  let token = ++pv.renderToken;
  let pageNo = pv.page;
  $('#pdfPageInfo').textContent = `${pageNo} / ${pv.total}`;
  let page = await pv.doc.getPage(pageNo);
  if (token !== pv.renderToken) return;
  let [W, H] = pvStageSize();
  let base = page.getViewport({ scale: 1 });
  let fit = Math.min(W / base.width, H / base.height);
  pv.baseW = base.width * fit;
  pv.baseH = base.height * fit;
  if (!keepView) pv.zoom = 1;
  let rz = pv.zoom;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let px = (pv.baseW * rz * dpr) * (pv.baseH * rz * dpr);
  let cap = px > PV_MAX_PIXELS ? Math.sqrt(PV_MAX_PIXELS / px) : 1;
  let vp = page.getViewport({ scale: fit * rz * dpr * cap });
  let canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = (pv.baseW * rz) + 'px';
  canvas.style.height = (pv.baseH * rz) + 'px';
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  if (token !== pv.renderToken) return;
  pv.renderZoom = rz;
  pv.renderTarget = rz;
  pv.canvas = canvas;
  $('#pdfStage').replaceChildren(canvas);
  pvApply();
}

function pvAutoSave() {
  clearTimeout(pv.saveTimer);
  let slot = pv.docSlot, page = pv.page;
  pv.saveTimer = setTimeout(() => {
    let prog = getSlotProgressData(slot);
    prog.lastSlide = page;
    saveSlotProgressData(slot, prog);
    if (slot === currentSlotIndex) updateProgressBanners();
  }, 600);
}

function pvGo(delta) {
  if (!pv.doc) return;
  let next = Math.min(Math.max(1, pv.page + delta), pv.total);
  if (next === pv.page) return;
  pv.page = next;
  pvRender(false);
  pvAutoSave();
}

function closePdfViewer() {
  let viewer = $('#pdfViewer');
  if (viewer.classList.contains('hidden')) return;
  viewer.classList.add('hidden');
  viewer.setAttribute('aria-hidden', 'true');
  clearTimeout(pv.saveTimer);
  if (!pv.doc || pv.docSlot !== currentSlotIndex) return;
  if (pv.page !== pv.openedAt) {
    quickSaveSlideProgress(pv.page);
  } else {
    let prog = getSlotProgressData(pv.docSlot);
    prog.lastSlide = pv.page;
    saveSlotProgressData(pv.docSlot, prog);
    updateProgressBanners();
  }
}

$('#pdfPrev').onclick = (e) => { e.stopPropagation(); pvGo(-1); pvShowBar(); };
$('#pdfNext').onclick = (e) => { e.stopPropagation(); pvGo(1); pvShowBar(); };
$('#pdfZoomIn').onclick = (e) => { e.stopPropagation(); pvSetZoom(pv.zoom * 1.5); pvShowBar(); };
$('#pdfZoomOut').onclick = (e) => { e.stopPropagation(); pvSetZoom(pv.zoom / 1.5); pvShowBar(); };
$('#pdfFit').onclick = (e) => { e.stopPropagation(); pvSetZoom(1); pvShowBar(); };
$('#pdfClose').onclick = (e) => { e.stopPropagation(); closePdfViewer(); };
$('#pdfPageInfo').onclick = (e) => {
  e.stopPropagation();
  if (!pv.doc) return;
  let v = prompt(`跳到第幾頁？（1–${pv.total}）`, pv.page);
  let n = parseInt(v);
  if (n) pvGo(Math.min(Math.max(1, n), pv.total) - pv.page);
};
$('#pdfBar').addEventListener('pointerdown', e => e.stopPropagation());

// 手勢：
//  全頁時：點右邊三分之一下一頁、點左邊上一頁、左右滑動翻頁；點中間顯示按鈕，點中間兩下放大。
//  兩指開合：放大縮小。放大後：一指拖曳移動畫面，點兩下回到全頁（放大時點一下不會翻頁）。
(() => {
  let el = $('#pdfViewer');
  let pts = new Map();
  let g = null;
  let lastTap = 0, lastTapX = 0, lastTapY = 0, tapTimer = null;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  el.addEventListener('pointerdown', e => {
    if (!pv.doc) return;
    try { el.setPointerCapture(e.pointerId); } catch {}
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      g = { mode: 'one', sx: e.clientX, sy: e.clientY, ox: pv.x, oy: pv.y, moved: false };
    } else if (pts.size === 2) {
      let [a, b] = [...pts.values()];
      g = { mode: 'pinch', d0: dist(a, b) || 1, z0: pv.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, ox: pv.x, oy: pv.y };
      clearTimeout(tapTimer);
    }
  });

  el.addEventListener('pointermove', e => {
    if (!g || !pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.mode === 'pinch' && pts.size >= 2) {
      let [a, b] = [...pts.values()];
      let z = Math.min(PV_MAX_ZOOM, Math.max(1, g.z0 * dist(a, b) / g.d0));
      let k = z / g.z0;
      let mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      pv.zoom = z;
      pv.x = mx - (g.mx - g.ox) * k;
      pv.y = my - (g.my - g.oy) * k;
      pvApply();
    } else if (g.mode === 'one') {
      let dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) g.moved = true;
      if (pv.zoom > 1.01) {
        pv.x = g.ox + dx;
        pv.y = g.oy + dy;
        pvApply();
      }
    }
  });

  function handleTap(x, y) {
    let now = Date.now();
    let isDouble = now - lastTap < 320 && Math.hypot(x - lastTapX, y - lastTapY) < 50;
    if (pv.zoom > 1.01) {
      if (isDouble) { clearTimeout(tapTimer); lastTap = 0; pvSetZoom(1); return; }
      lastTap = now; lastTapX = x; lastTapY = y;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(pvShowBar, 320);
      return;
    }
    let r = x / window.innerWidth;
    if (r < 0.33) { lastTap = 0; pvGo(-1); return; }
    if (r > 0.67) { lastTap = 0; pvGo(1); return; }
    if (isDouble) { clearTimeout(tapTimer); lastTap = 0; pvSetZoom(2.5, x, y); return; }
    lastTap = now; lastTapX = x; lastTapY = y;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(pvShowBar, 320);
  }

  function end(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!g) return;
    if (g.mode === 'pinch') {
      if (pts.size === 1) {
        let p = [...pts.values()][0];
        g = { mode: 'one', sx: p.x, sy: p.y, ox: pv.x, oy: pv.y, moved: true };
      } else if (pts.size === 0) {
        g = null;
      }
      pvScheduleHires();
      return;
    }
    let gg = g;
    g = null;
    if (e.type === 'pointercancel') return;
    let dx = e.clientX - gg.sx, dy = e.clientY - gg.sy;
    if (pv.zoom > 1.01) {
      if (!gg.moved) handleTap(e.clientX, e.clientY);
      return;
    }
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) { pvGo(dx < 0 ? 1 : -1); return; }
    if (gg.moved) return;
    handleTap(e.clientX, e.clientY);
  }
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  // 筆電：Ctrl＋滾輪（或觸控板兩指開合）放大縮小；放大後滾輪移動畫面
  el.addEventListener('wheel', e => {
    if (!pv.doc) return;
    e.preventDefault();
    if (e.ctrlKey) {
      pvSetZoom(pv.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    } else if (pv.zoom > 1.01) {
      pv.x -= e.deltaX;
      pv.y -= e.deltaY;
      pvApply();
    }
  }, { passive: false });
})();

document.addEventListener('keydown', e => {
  if ($('#pdfViewer').classList.contains('hidden')) return;
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); pvGo(1); }
  else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); pvGo(-1); }
  else if (e.key === '+' || e.key === '=') { e.preventDefault(); pvSetZoom(pv.zoom * 1.5); }
  else if (e.key === '-') { e.preventDefault(); pvSetZoom(pv.zoom / 1.5); }
  else if (e.key === '0') { e.preventDefault(); pvSetZoom(1); }
  else if (e.key === 'Escape') { e.preventDefault(); closePdfViewer(); }
});
window.addEventListener('resize', () => {
  if (!$('#pdfViewer').classList.contains('hidden')) pvRender(true);
});

$('#pdfStorePicker').onchange = async (e) => {
  let file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  let isPpt = /\.pptx?$/i.test(file.name);
  if (!isPdf && !isPpt) {
    toast('請選擇 PDF 或 PPT（.pptx / .ppt）檔案');
    return;
  }
  let kind = isPdf ? 'PDF' : 'PPT';
  let slot = currentSlotIndex;
  try {
    toast(`正在存入 ${kind}…`);
    let data = await file.arrayBuffer();
    await pdfStorePut(slot, { name: file.name, type: file.type || webFileMime(file.name), size: file.size, savedAt: Date.now(), data });
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
    let prog = getSlotProgressData(slot);
    if (prog.pptPath !== file.name) prog.lastSlide = 1;
    prog.pptPath = file.name;
    saveSlotProgressData(slot, prog);
    if (pv.docSlot === slot) { pv.doc = null; pv.docSlot = null; }
    updateProgressBanners();
    toast(`已存入【${currentClassName}】的 ${kind}：${file.name}。按「🚀 開啟 ${kind}」就能上課。`);
  } catch {
    toast(`${kind} 存入失敗，可能是裝置空間不足，請換小一點的檔案再試。`);
  }
};

// ============================================================
// 網頁 / iPad 版的 PPT：存在這台裝置裡，按「開啟 PPT」交給 PowerPoint / Keynote 開
// （網頁不能指定其他 App 跳到第幾頁，所以會提醒上次的頁數）
// ============================================================
function webFileMime(name) {
  if (/\.pptx$/i.test(name)) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (/\.ppt$/i.test(name)) return 'application/vnd.ms-powerpoint';
  return 'application/pdf';
}
let pptOpenFile = null;

async function openStoredPpt(page) {
  let dlg = $('#pptOpenDialog');
  pptOpenFile = null;
  $('#pptOpenName').textContent = getSlotProgressData(currentSlotIndex).pptPath || '';
  $('#pptOpenPage').textContent = page;
  $('#pptOpenGo').disabled = true;
  $('#pptOpenGo').textContent = '準備中…';
  dlg.showModal();
  try {
    let rec = await pdfStoreGet(currentSlotIndex);
    if (!rec || !rec.data) {
      $('#pptOpenGo').textContent = '找不到檔案，請重新選擇';
      return;
    }
    pptOpenFile = new File([rec.data], rec.name, { type: rec.type || webFileMime(rec.name) });
    $('#pptOpenGo').disabled = false;
    $('#pptOpenGo').textContent = '📊 用 PowerPoint／Keynote 開啟';
  } catch {
    $('#pptOpenGo').textContent = '讀取失敗，請重新選擇檔案';
  }
}

$('#pptOpenGo').onclick = async () => {
  let f = pptOpenFile;
  if (!f) return;
  let canShareFile = false;
  try { canShareFile = !!(navigator.canShare && navigator.canShare({ files: [f] })); } catch {}
  let isTouch = navigator.maxTouchPoints > 1;
  if (canShareFile && isTouch) {
    try {
      await navigator.share({ files: [f] });
      $('#pptOpenDialog').close();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      downloadPptFile(f);
    }
    return;
  }
  downloadPptFile(f);
};
function downloadPptFile(f) {
  let url = URL.createObjectURL(f);
  let a = document.createElement('a');
  a.href = url;
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
  toast('已下載簡報，請在瀏覽器的下載清單點開它');
  $('#pptOpenDialog').close();
}
$('#pptOpenClose').onclick = () => $('#pptOpenDialog').close();

// ============================================================
// 新手引導（網頁 / iPad 版）：這一班還沒有名單時，在最上面顯示 3 個步驟
// ============================================================
var ngJustSaved = false;
function ngRosterIsSample(names) {
  return names.length === 0 || names.every(n => /^\d*\s*學生\d+$/.test(n.trim()));
}
function ngIsHomeScreenApp() {
  return !!(window.navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
}
function ngIsAppleTouch() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}
function updateNewbieGuide() {
  let box = $('#newbieGuide');
  if (!box) return;
  let off = false;
  try { off = localStorage.getItem('cockpit-guide-off') === '1'; } catch {}
  let saved = !!localStorage.getItem('draw-slot-' + currentSlotIndex);
  let names = roster();
  let needsRoster = !saved || ngRosterIsSample(names);
  let show = IS_WEB_BUILD && !off && (needsRoster || ngJustSaved);
  box.classList.toggle('hidden', !show);
  if (!show) return;
  $('#ngHomeTip').classList.toggle('hidden', !(ngIsAppleTouch() && !ngIsHomeScreenApp()));
  let step1 = !ngRosterIsSample(names);
  let step2 = saved && !needsRoster;
  $('#ngStep1').classList.toggle('done', step1);
  $('#ngStep2').classList.toggle('done', step2);
  $('#ngStep1').classList.toggle('current', !step1);
  $('#ngStep2').classList.toggle('current', step1 && !step2);
  $('#ngStep3').classList.toggle('current', step2);
  let nm = localStorage.getItem('draw-slot-' + currentSlotIndex + '-name') || '';
  if (document.activeElement !== $('#ngClassName')) {
    $('#ngClassName').value = /^班級 \d$/.test(nm) ? '' : nm;
  }
}

$('#ngPaste').onclick = () => {
  let ta = $('#names');
  if (ngRosterIsSample(roster())) ta.value = '';
  ta.classList.add('ng-highlight');
  ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => ta.focus(), 400);
  setTimeout(() => ta.classList.remove('ng-highlight'), 4000);
  updateNewbieGuide();
};
$('#names').addEventListener('input', () => { if (IS_WEB_BUILD) updateNewbieGuide(); });
$('#ngSave').onclick = () => {
  let names = roster();
  if (ngRosterIsSample(names)) {
    toast('請先在名單框貼上學生名單（第 1 步）');
    $('#ngPaste').click();
    return;
  }
  let name = $('#ngClassName').value.trim()
    || localStorage.getItem('draw-slot-' + currentSlotIndex + '-name')
    || `班級 ${currentSlotIndex + 1}`;
  ngJustSaved = true;
  $('#ngClassName').blur();
  saveSlot(currentSlotIndex, name);
  toast(`✅ 已儲存【${name}】，共 ${names.length} 位學生。下一步：按「▷ 開始上課」。`);
};
$('#ngStart').onclick = () => {
  if (ngRosterIsSample(roster())) {
    toast('請先貼上學生名單並儲存（第 1、2 步）');
    return;
  }
  if (!localStorage.getItem('draw-slot-' + currentSlotIndex)) $('#ngSave').click();
  ngJustSaved = false;
  $('#startGame').click();
};
$('#ngSkip').onclick = () => {
  try { localStorage.setItem('cockpit-guide-off', '1'); } catch {}
  ngJustSaved = false;
  updateNewbieGuide();
  toast('引導已關閉。需要時可以看使用說明。');
};

// 重置本日記點
$('#clearScoresBtn').onclick = () => {
  if (confirm('確定要清空今日的所有加扣分紀錄嗎？')) {
    todayScores = {};
    renderBoard();
    openCheckoutDialog();
    toast('今日分數已重置');
  }
};

// 匯出今日記點 CSV
$('#exportLogCsv').onclick = () => {
  let rows = [['班級', '學生', '本日總分', '記點明細記錄', '結算時間']];
  let timeStr = new Date().toLocaleString('zh-TW');

  Object.entries(todayScores).forEach(([name, data]) => {
    let details = data.logs.map(l => `[${l.time}] ${l.reason} (${l.delta})`).join('; ');
    rows.push([currentClassName, name, data.total, `"${details}"`, timeStr]);
  });

  if (rows.length === 1) {
    toast('今日尚無記點資料可匯出');
    return;
  }

  let csvContent = '\uFEFF' + rows.map(e => e.join(',')).join('\n');
  let blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  let a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${currentClassName}_課堂記點_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已匯出今日記點 CSV');
};

// ============================================================
// Google 試算表即時記點同步功能 (Google Sheet Sync)
// ============================================================
const GAS_TEMPLATE_CODE = `/**
 * ClassroomCockpit 課堂主控台 - Google 試算表即時記點同步服務
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return ContentService.createTextOutput(JSON.stringify({ status: "busy" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    var raw = e && e.postData ? e.postData.contents : "";
    if (!raw) {
      return ContentService.createTextOutput(JSON.stringify({ status: "empty" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var data = JSON.parse(raw);
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // 優先使用該班級名稱分頁，若無則使用目前使用中的分頁
    var sheet = ss.getActiveSheet();
    var firstClassName = Array.isArray(data) ? (data[0] && data[0].className) : (data && data.className);
    if (firstClassName) {
      var matchSheet = ss.getSheetByName(firstClassName);
      if (matchSheet) {
        sheet = matchSheet;
      }
    }

    // 若為全新工作表，自動填入標題列
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["登記時間", "班級", "學生姓名", "加扣分", "記點事由", "本日累計總分"]);
      sheet.getRange(1, 1, 1, 6).setBackground("#2862ee").setFontColor("#ffffff").setFontWeight("bold");
      sheet.setFrozenRows(1);
    }

    var rows = [];
    var nowStr = Utilities.formatDate(new Date(), "Asia/Taipei", "yyyy/MM/dd HH:mm:ss");

    if (Array.isArray(data)) {
      data.forEach(function(item) {
        if (!item) return;
        var d = item.delta;
        var signDelta = (d !== undefined && d !== null && d !== '') ? (d > 0 ? "+" + d : "" + d) : "";
        rows.push([
          item.time || nowStr,
          item.className || "",
          item.studentName || "",
          signDelta,
          item.reason || "",
          item.total !== undefined ? item.total : ""
        ]);
      });
    } else if (data) {
      var d = data.delta;
      var signDelta = (d !== undefined && d !== null && d !== '') ? (d > 0 ? "+" + d : "" + d) : "";
      rows.push([
        data.time || nowStr,
        data.className || "",
        data.studentName || "",
        signDelta,
        data.reason || "",
        data.total !== undefined ? data.total : ""
      ]);
    }

    if (rows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 6).setValues(rows);
    }

    return ContentService.createTextOutput(JSON.stringify({ status: "success", count: rows.length }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  return ContentService.createTextOutput("ClassroomCockpit Google 試算表即時記點同步服務正常運作中！");
}`;

const DEFAULT_GSHEET_SYNC_URL = ''; // 網頁版：試算表網址由「匯入全部備份」帶入或自行設定

function getGoogleSheetConfig() {
  let globalUrl = localStorage.getItem('cockpit-gsheet-url') || DEFAULT_GSHEET_SYNC_URL;
  let slotUrl = localStorage.getItem(`draw-slot-${currentSlotIndex}-gsheet-url`) || '';
  let enabled = localStorage.getItem('cockpit-gsheet-enabled') !== 'false';
  let url = slotUrl || globalUrl;
  return { url, globalUrl, slotUrl, enabled };
}

let syncQueue = [];
let isSyncing = false;

async function processSyncQueue() {
  if (isSyncing || syncQueue.length === 0) return;
  let cfg = getGoogleSheetConfig();
  if (!cfg.enabled || !cfg.url) {
    syncQueue = [];
    return;
  }

  isSyncing = true;
  let batch = syncQueue.splice(0, syncQueue.length);

  try {
    let payload = batch.length === 1 ? batch[0] : batch;
    await fetch(cfg.url, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    updateSheetSyncUI(true);
  } catch (err) {
    console.warn('Google Sheet Sync failed:', err);
    updateSheetSyncUI(false);
  } finally {
    isSyncing = false;
    if (syncQueue.length > 0) {
      setTimeout(processSyncQueue, 350);
    }
  }
}

function syncScoreToGoogleSheet(record) {
  let cfg = getGoogleSheetConfig();
  if (!cfg.enabled || !cfg.url) return;
  syncQueue.push(record);
  processSyncQueue();
}

function updateSheetSyncUI(isSuccess) {
  let cfg = getGoogleSheetConfig();
  let gameBtn = $('#gameSheetSyncBtn');
  if (gameBtn) {
    if (!cfg.url) {
      gameBtn.textContent = '📊 試算表：未綁定';
      gameBtn.className = 'button muted compact';
    } else if (!cfg.enabled) {
      gameBtn.textContent = '📊 試算表：已暫停';
      gameBtn.className = 'button orange compact';
    } else {
      gameBtn.textContent = isSuccess === false ? '📊 試算表：連線異常' : '📊 試算表：即時同步中';
      gameBtn.className = isSuccess === false ? 'button red compact' : 'button green compact';
    }
  }
}

function openGoogleSheetDialog() {
  let cfg = getGoogleSheetConfig();
  $('#googleSheetUrlInput').value = cfg.url;
  $('#sheetAutoSyncCheckbox').checked = cfg.enabled;
  $('#sheetApplyAllSlotsCheckbox').checked = !cfg.slotUrl;
  $('#bindGoogleSheetDialog').showModal();
}

if ($('#bindGoogleSheetBtn')) $('#bindGoogleSheetBtn').onclick = openGoogleSheetDialog;
if ($('#gameSheetSyncBtn')) $('#gameSheetSyncBtn').onclick = openGoogleSheetDialog;
if ($('#closeGoogleSheetDialog')) $('#closeGoogleSheetDialog').onclick = () => $('#bindGoogleSheetDialog').close();

if ($('#saveGoogleSheetBtn')) {
  $('#saveGoogleSheetBtn').onclick = () => {
    let url = $('#googleSheetUrlInput').value.trim();
    let enabled = $('#sheetAutoSyncCheckbox').checked;
    let applyAll = $('#sheetApplyAllSlotsCheckbox').checked;

    localStorage.setItem('cockpit-gsheet-enabled', enabled ? 'true' : 'false');
    if (applyAll) {
      localStorage.setItem('cockpit-gsheet-url', url);
      for (let i = 0; i < 5; i++) {
        localStorage.removeItem(`draw-slot-${i}-gsheet-url`);
      }
    } else {
      localStorage.setItem(`draw-slot-${currentSlotIndex}-gsheet-url`, url);
    }
    updateSheetSyncUI();
    $('#bindGoogleSheetDialog').close();
    toast(url ? '✅ Google 試算表同步設定已儲存！' : '已清除 Google 試算表網址');
  };
}

if ($('#copyGasCodeBtn')) {
  $('#copyGasCodeBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(GAS_TEMPLATE_CODE);
      toast('📋 已複製 Apps Script 程式碼！請至 Google 試算表貼上');
    } catch {
      let ta = document.createElement('textarea');
      ta.value = GAS_TEMPLATE_CODE;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('📋 已複製 Apps Script 程式碼！');
    }
  };
}

if ($('#testSheetSyncBtn')) {
  $('#testSheetSyncBtn').onclick = async () => {
    let url = $('#googleSheetUrlInput').value.trim();
    if (!url) {
      toast('請先輸入 Google Apps Script 網址');
      return;
    }
    toast('⏳ 正在向試算表發送測試資料...');
    try {
      let testData = {
        time: new Date().toLocaleString('zh-TW', { hour12: false }),
        className: currentClassName || '測試班級',
        studentName: '系統測試同學',
        delta: 1,
        reason: '連線測試成功',
        total: 1
      };
      await fetch(url, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(testData)
      });
      toast('🎉 測試資料已送出！請檢查試算表是否已新增一列「系統測試同學」');
      updateSheetSyncUI(true);
    } catch (err) {
      toast('❌ 測試發送失敗：' + err.message);
      updateSheetSyncUI(false);
    }
  };
}

if ($('#syncCheckoutToSheetBtn')) {
  $('#syncCheckoutToSheetBtn').onclick = () => {
    let cfg = getGoogleSheetConfig();
    if (!cfg.url) {
      openGoogleSheetDialog();
      toast('請先設定 Google 試算表 Web App 網址');
      return;
    }
    let nowStr = new Date().toLocaleString('zh-TW', { hour12: false });
    let count = 0;
    Object.entries(todayScores).forEach(([name, data]) => {
      data.logs.forEach(l => {
        syncScoreToGoogleSheet({
          time: nowStr,
          className: currentClassName,
          studentName: name,
          delta: l.delta,
          reason: l.reason,
          total: data.total
        });
        count++;
      });
    });
    if (count === 0) {
      toast('今日尚無任何記點記錄');
    } else {
      toast(`🚀 已將今日 ${count} 筆記點資料排入同步隊列！`);
    }
  };
}

// 歷史進度日誌彈窗
$('#viewHistory').onclick = () => {
  let select = $('#historySlotSelect');
  select.innerHTML = Array.from({ length: 5 }, (_, i) => {
    let n = localStorage.getItem('draw-slot-' + i + '-name') || `班級 ${i + 1}`;
    return `<option value="${i}" ${i === currentSlotIndex ? 'selected' : ''}>${n}</option>`;
  }).join('');

  renderHistoryTimeline(currentSlotIndex);
  $('#historyDialog').showModal();
};

$('#historySlotSelect').onchange = (e) => {
  renderHistoryTimeline(+e.target.value);
};

function renderHistoryTimeline(slotIdx) {
  let prog = getSlotProgressData(slotIdx);
  let timeline = $('#historyTimeline');
  timeline.replaceChildren();

  if (!prog.history.length) {
    timeline.innerHTML = '<div class="empty-hint">此班級尚無任何歷史進度記錄</div>';
    return;
  }

  prog.history.forEach(h => {
    let entry = document.createElement('div');
    entry.className = 'history-entry';
    let topScorers = Object.entries(h.scoresSummary || {})
      .filter(([_, d]) => d.total > 0)
      .map(([n, d]) => `${n}(+${d.total})`)
      .slice(0, 4)
      .join('、');

    entry.innerHTML = `
      <div class="history-date">📅 上課日期：${h.date}</div>
      <div class="history-prog">📌 授課進度：${h.progress}</div>
      <div class="history-hw">📝 作業交代：${h.homework || '無'}</div>
      ${h.remarks ? `<div class="history-summary">💬 課堂備註：${h.remarks}</div>` : ''}
      ${topScorers ? `<div class="history-summary">⭐ 表現優良：${topScorers}</div>` : ''}
    `;
    timeline.append(entry);
  });
}

$('#closeHistory').onclick = () => $('#historyDialog').close();

// 匯出全部歷史
$('#exportAllHistory').onclick = () => {
  let slotIdx = +$('#historySlotSelect').value;
  let prog = getSlotProgressData(slotIdx);
  let slotName = localStorage.getItem('draw-slot-' + slotIdx + '-name') || `班級 ${slotIdx + 1}`;

  if (!prog.history.length) {
    toast('尚無歷史進度可匯出');
    return;
  }

  let rows = [['班級', '日期時間', '授課進度', '下次作業', '課堂備註']];
  prog.history.forEach(h => {
    rows.push([slotName, h.date, `"${h.progress}"`, `"${h.homework || ''}"`, `"${h.remarks || ''}"`]);
  });

  let csvContent = '\uFEFF' + rows.map(e => e.join(',')).join('\n');
  let blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  let a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slotName}_完整歷史進度_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已匯出歷史進度 CSV');
};

// ============================================================
// 出缺勤快速勾選 (Attendance Dialog)
// ============================================================
$('#quickAttendanceBtn').onclick = () => {
  let list = $('#attendanceList');
  list.replaceChildren();
  let students = roster();

  if (!students.length) {
    toast('請先在左方輸入名單');
    return;
  }

  students.forEach(st => {
    let clean = st.replace(/#.*$/, '').replace(/[\(（].*[\)）]/, '').trim();
    if (!clean) return;

    let item = document.createElement('div');
    item.className = 'attendance-item' + (absentList.has(clean) ? ' absent' : '');
    item.textContent = clean + (absentList.has(clean) ? ' (缺席)' : ' (到課)');
    item.onclick = () => {
      if (absentList.has(clean)) {
        absentList.delete(clean);
        item.classList.remove('absent');
        item.textContent = clean + ' (到課)';
      } else {
        absentList.add(clean);
        item.classList.add('absent');
        item.textContent = clean + ' (缺席)';
      }
    };
    list.append(item);
  });

  $('#attendanceDialog').showModal();
};

$('#closeAttendance').onclick = () => {
  $('#attendanceDialog').close();
  toast(`已設定 ${absentList.size} 位同學缺席（抽籤將自動略過）`);
};

// ============================================================
// 原版功能事件綁定 (Setup, Slots, Controls)
// ============================================================
$('#quickSaveRosterBtn').onclick = () => {
  saveSlot(currentSlotIndex, currentClassName);
  toast(`已成功儲存【${currentClassName}】名單設定！`);
};

$('#startGame').onclick = () => {
  memoMarkClassHeld(currentSlotIndex);
  saveSlot(currentSlotIndex, currentClassName);
  buildBoard();
};
$('#backToSetup').onclick = () => {
  $('#game').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  hideBubble();
};

$('#shuffle').onclick = () => {
  if (!tiles.length) return;
  let ts = shuffle(tiles.filter(t => t.kind === 'student'));
  let k = 0;
  tiles = tiles.map(t => t.kind === 'student' ? ts[k++] : t);
  renderBoard();
  toast('棋盤上的名單位置已打亂');
};

$('#roll').onclick = roll;
$('#race').onclick = race;
$('#drawChance').onclick = () => draw('chance');
$('#drawFate').onclick = () => draw('fate');

// 骰子數 1~6：畫面上永遠只有兩顆骰子，多出來的骰子數併到這兩顆的點數範圍
// 例：3 顆 → 一顆 1~12、一顆 1~6；4 顆 → 兩顆都 1~12；5 顆 → 1~18 與 1~12
const DICE_MAX = 6;
function setDiceN(n) {
  diceN = Math.max(1, Math.min(DICE_MAX, n));
  $('#diceN').textContent = diceN;
  $('#game').dataset.dice = diceN;
  let [m1, m2] = diceFaces();
  $('#die2').textContent = m2 ? Math.min(+$('#die2').textContent || 1, m2) : '–';
  $('#die1').textContent = Math.min(+$('#die1').textContent || 1, m1);
}
$('#dicePlus').onclick = () => setDiceN(diceN + 1);
$('#diceMinus').onclick = () => setDiceN(diceN - 1);

$('#special').onclick = () => {
  ignoreSpecial = !ignoreSpecial;
  $('#special').textContent = `◎ 忽略特殊格：${ignoreSpecial ? '開' : '關'}`;
  $('#special').classList.toggle('green', ignoreSpecial);
};

// 機會命運卡編輯
$('#editCards').onclick = () => {
  $('#chanceCards').value = state.chance.join('\n');
  $('#fateCards').value = state.fate.join('\n');
  $('#cardsDialog').showModal();
};

$('#saveCards').onclick = (e) => {
  e.preventDefault();
  state.chance = lines($('#chanceCards').value);
  state.fate = lines($('#fateCards').value);
  $('#cardsDialog').close();
  toast('卡牌內容已更新');
};

// 班級槽位管理
$('#manageSlots').onclick = () => {
  $('#slotSelect').innerHTML = Array.from({ length: 5 }, (_, i) =>
    `<option value="${i}">槽位 ${i + 1}（${localStorage.getItem('draw-slot-' + i + '-name') || '空'}）</option>`
  ).join('');
  $('#slotSelect').value = currentSlotIndex;
  $('#slotName').value = localStorage.getItem('draw-slot-' + currentSlotIndex + '-name') || '';
  $('#slotsDialog').showModal();
};

$('#slotSelect').onchange = (e) => {
  $('#slotName').value = localStorage.getItem('draw-slot-' + e.target.value + '-name') || '';
};

$('#saveSlot').onclick = () => saveSlot($('#slotSelect').value, $('#slotName').value.trim());
$('#loadSlot').onclick = () => loadSlot($('#slotSelect').value);

// JSON 匯出與匯入
$('#exportJson').onclick = () => {
  let blob = new Blob([JSON.stringify(data(), null, 2)], { type: 'application/json' });
  let a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${currentClassName}_班級抽籤設定.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// 全部備份：5 個班級的名單、卡牌、進度歷史、名單設定（一定點／不點）、試算表設定，一個檔案搬到 iPad 或其他電腦
const BACKUP_KEY_PATTERN = /^(draw-slot-|cockpit-gsheet-)/;
$('#exportAllBackup').onclick = () => {
  let all = {};
  for (let i = 0; i < localStorage.length; i++) {
    let k = localStorage.key(i);
    if (BACKUP_KEY_PATTERN.test(k)) all[k] = localStorage.getItem(k);
  }
  // 試算表網址若是用程式內建預設值，也一併寫進備份，搬到 iPad 後同步照常運作
  if (!all['cockpit-gsheet-url'] && DEFAULT_GSHEET_SYNC_URL) all['cockpit-gsheet-url'] = DEFAULT_GSHEET_SYNC_URL;
  let payload = { type: 'classroom-cockpit-backup', version: 1, exportedAt: new Date().toISOString(), data: all };
  let blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  let a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `課堂控台全部備份_${todayStr()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('已匯出全部備份（包含 5 個班級與名單設定）');
};
$('#importAllBackup').onclick = () => $('#backupFile').click();
$('#backupFile').onchange = async (e) => {
  let file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    let parsed = JSON.parse(await file.text());
    if (parsed.type !== 'classroom-cockpit-backup' || !parsed.data) throw new Error('not backup');
    if (!confirm('匯入後會覆蓋這台裝置上目前的班級名單、進度與設定，確定要匯入嗎？')) return;
    Object.keys(localStorage).filter(k => BACKUP_KEY_PATTERN.test(k)).forEach(k => localStorage.removeItem(k));
    Object.entries(parsed.data).forEach(([k, v]) => { if (BACKUP_KEY_PATTERN.test(k)) localStorage.setItem(k, v); });
    loadSlot(0);
    renderQuick();
    toast('全部備份匯入完成');
  } catch {
    toast('這不是課堂控台的全部備份檔');
  }
};

$('#importJson').onclick = () => $('#jsonFile').click();
$('#jsonFile').onchange = async (e) => {
  try {
    let parsed = JSON.parse(await e.target.files[0].text());
    if (Array.isArray(parsed.classes)) {
      let classes = parsed.classes.slice(0, 5);
      classes.forEach((c, i) => {
        let item = {
          names: c.names || [],
          chanceCount: c.chanceCount ?? 3,
          fateCount: c.fateCount ?? 3,
          chance: c.chance || [...defaults.chance],
          fate: c.fate || [...defaults.fate]
        };
        localStorage.setItem('draw-slot-' + i, JSON.stringify(item));
        localStorage.setItem('draw-slot-' + i + '-name', c.className || `班級 ${i + 1}`);
      });
      if (classes.length) applyData({ ...classes[0], chance: classes[0].chance || [...defaults.chance], fate: classes[0].fate || [...defaults.fate] });
      renderQuick();
      toast(`已匯入 ${classes.length} 個班級至存檔槽`);
    } else {
      applyData(parsed);
      toast('班級設定匯入完成');
    }
  } catch {
    toast('JSON 檔案無法讀取');
  }
  e.target.value = '';
};

// CSV 名單匯入
$('#csvFile').onchange = async (e) => {
  try {
    let text = await e.target.files[0].text();
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    $('#names').value = text.split(/\r?\n/).map(s => s.split(',')[0].replace(/^\s*"|"\s*$/g, '').trim()).filter(Boolean).join('\n');
    toast('CSV 名單匯入完成');
  } catch {
    toast('CSV 檔案無法讀取');
  }
  e.target.value = '';
};

// 初始化載入第 0 槽
if (localStorage.getItem('draw-slot-0')) {
  
// ==========================================
// 預設三個原始班級資料 (機三孝 / 機三忠 / 普三忠)
// ==========================================
const ORIGINAL_THREE_CLASSES = []; // 網頁版不內建學生名單
const ORIGINAL_PROGRESS_DATA = {};

function restoreOriginalThreeClasses(force = false) {
  const currentSlot0Name = localStorage.getItem('draw-slot-0-name') || '';
  const currentSlot0 = localStorage.getItem('draw-slot-0') || '';
  const isDefaultOrEmpty = force || !localStorage.getItem('draw-slot-0') || currentSlot0Name === '班級 1' || currentSlot0Name === '' || currentSlot0.includes('學生1');

  if (isDefaultOrEmpty) {
    ORIGINAL_THREE_CLASSES.forEach((c, i) => {
      localStorage.setItem('draw-slot-' + i, JSON.stringify({
        names: c.names,
        chanceCount: c.chanceCount || 3,
        fateCount: c.fateCount || 3,
        chance: c.chance || defaults.chance,
        fate: c.fate || defaults.fate
      }));
      localStorage.setItem('draw-slot-' + i + '-name', c.className);
      if (ORIGINAL_PROGRESS_DATA[i] && (!localStorage.getItem('draw-slot-' + i + '-progress') || force)) {
        localStorage.setItem('draw-slot-' + i + '-progress', JSON.stringify(ORIGINAL_PROGRESS_DATA[i]));
      }
    });
    console.log('已自動回復原本的三個班級：機三孝、機三忠、普三忠！');
  }
}

// 執行自動檢查與還原
restoreOriginalThreeClasses(false);

loadSlot(0);
} else {
  // 若為第一次使用，提供範例名單供老師試用
  $('#names').value = Array.from({ length: 32 }, (_, i) => `${(i + 1).toString().padStart(2, '0')} 學生${i + 1}`).join('\n');
  renderQuick();
  updateProgressBanners();
}


// ==========================================
// 課堂倒數計時器與全螢幕整合模組
// ==========================================
const timerDialog = $('#timerDialog');
const openTimer = () => {
  if (timerDialog) {
    if (typeof timerDialog.showModal === 'function') {
      timerDialog.showModal();
    } else {
      timerDialog.setAttribute('open', '');
    }
  }
};
const closeTimer = () => {
  if (timerDialog) {
    if (typeof timerDialog.close === 'function') {
      timerDialog.close();
    } else {
      timerDialog.removeAttribute('open');
    }
  }
};
const toggleFullscreen = () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(err => {
      console.warn('全螢幕請求提示:', err);
    });
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
  }
};

if ($('#openTimerBtn')) $('#openTimerBtn').onclick = openTimer;
if ($('#gameTimerBtn')) $('#gameTimerBtn').onclick = openTimer;
if ($('#timerCloseBtn')) $('#timerCloseBtn').onclick = closeTimer;
if (timerDialog) timerDialog.addEventListener('click', (e) => { if (e.target === timerDialog) closeTimer(); });
if ($('#toggleFullscreenBtn')) $('#toggleFullscreenBtn').onclick = toggleFullscreen;
if ($('#gameFullscreenBtn')) $('#gameFullscreenBtn').onclick = toggleFullscreen;

if ($('#timerOpenNewWindowBtn')) {
  $('#timerOpenNewWindowBtn').onclick = () => {
    window.open('timer.html', '_blank', 'popup=yes,width=1200,height=800');
  };
}

// 鍵盤快捷鍵 (F: 全螢幕, T: 開啟/關閉計時器)
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'KeyF') {
    e.preventDefault();
    toggleFullscreen();
  } else if (e.code === 'KeyT') {
    e.preventDefault();
    if (timerDialog && timerDialog.open) {
      closeTimer();
    } else {
      openTimer();
    }
  }
});


if ($('#restoreDefaultSlotsBtn')) {
  $('#restoreDefaultSlotsBtn').onclick = () => {
    restoreOriginalThreeClasses(true);
    loadSlot(0);
    renderSlots();
    renderQuick();
    updateProgressBanners();
    toast('已成功回復原本三個班級：機三孝、機三忠、普三忠！');
  };
}
