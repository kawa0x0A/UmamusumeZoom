'use strict';

/* =========================================================
   ウマ娘 ズームクイズ
   拡大された一部分だけを見てキャラクターを当てる。
   画像は公式ポータルの URL を参照（ダウンロード・再配布はしない）。
   ========================================================= */

const DATA = window.UMA_DATA;
const $ = (id) => document.getElementById(id);

/* ---------- 難易度 ---------- */
// frac = 画像の短辺に対して表示する範囲の割合（小さいほど拡大）
const DIFFICULTY = {
  easy:    { frac: 0.20, name: 'やさしい',   label: '短辺の20%を表示。ぱっと見でわかることも。' },
  normal:  { frac: 0.12, name: 'ふつう',     label: '短辺の12%を表示。髪飾りや瞳の色が手がかり。' },
  hard:    { frac: 0.070, name: 'むずかしい', label: '短辺の7%を表示。かなりの上級者向け。' },
  extreme: { frac: 0.040, name: '鬼',        label: '短辺の4%を表示。もはや色当てクイズ。' },
};
const MAX_ZOOMOUTS = 3;
const ZOOMOUT_STEP = 1.7;
const PENALTY_ZOOM = 25;
const PENALTY_HINT = 20;
const AUTOZOOM_MS = 10000;

/* ---------- 文字列の正規化 ---------- */
const IGNORE = /[\s・ー\-'’．.･。、!！?？]/;

/** カタカナ→ひらがな＋小文字化＋記号除去。元文字列への位置対応表つき。 */
function normalize(src) {
  const s = String(src || '');
  let n = '';
  const map = [];
  for (let i = 0; i < s.length; i++) {
    let c = s[i];
    if (IGNORE.test(c)) continue;
    const code = c.charCodeAt(0);
    if (code >= 0x30a1 && code <= 0x30f6) c = String.fromCharCode(code - 0x60); // カナ→かな
    else if (code >= 0xff21 && code <= 0xff5a) c = String.fromCharCode(code - 0xfee0); // 全角英字
    n += c.toLowerCase();
    map.push(i);
  }
  return { n, map };
}
const norm = (s) => normalize(s).n;

/* ---------- キャラクターデータ ---------- */
const CHARS = DATA.characters.map((c) => ({
  ...c,
  keys: [norm(c.ja), norm(c.en), norm(c.id)].filter((k, i, a) => k && a.indexOf(k) === i),
}));

const imgUrl = (u, opt) => DATA.base + u + '?fm=webp&q=' + (opt && opt.q ? opt.q : 85) + (opt && opt.w ? '&w=' + opt.w : '');

/* ---------- 設定 ---------- */
const SETTINGS_KEY = 'umazoom.settings';
const settings = Object.assign(
  { difficulty: 'normal', pool: 'uma', count: 10, autozoom: false },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
);
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

/* ---------- 状態 ---------- */
let session = null;
let current = null;
let upcoming = null;
let autozoomTimer = null;

if (!DIFFICULTY[settings.difficulty]) settings.difficulty = 'normal';

/* =========================================================
   画像の読み込みと「見どころ」の抽出
   ========================================================= */

function loadImage(src, withCors) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (withCors) img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('load failed: ' + src));
    img.src = src;
  });
}

/**
 * 透明な余白を避け、色の変化が大きい（＝情報量のある）位置を重み付きで選ぶ。
 * 画像は CORS 付きで読めているので縮小してピクセルを調べられる。
 */
function pickSpot(img) {
  const fallback = { x: img.naturalWidth / 2, y: img.naturalHeight * 0.28 };
  const W = 72;
  const H = Math.max(2, Math.round((W * img.naturalHeight) / img.naturalWidth));
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let data;
  try {
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);
    data = ctx.getImageData(0, 0, W, H).data;
  } catch (e) {
    return fallback; // CORS が効かなかった場合
  }

  const n = W * H;
  const alpha = new Float32Array(n);
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    alpha[i] = data[i * 4 + 3] / 255;
    lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  const weights = new Float32Array(n);
  let total = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      let amin = 1;
      for (let dy = -1; dy <= 1 && amin >= 0.85; dy++) {
        for (let dx = -1; dx <= 1; dx++) amin = Math.min(amin, alpha[(y + dy) * W + (x + dx)]);
      }
      if (amin < 0.85) continue; // 周囲に透明が混ざる位置は避ける
      const grad = Math.abs(lum[i] - lum[i + 1]) + Math.abs(lum[i] - lum[i + W]);
      const w = 0.35 + Math.min(grad, 90) / 45;
      weights[i] = w;
      total += w;
    }
  }
  if (total <= 0) return fallback;

  let r = Math.random() * total;
  let pick = -1;
  for (let i = 0; i < n; i++) {
    r -= weights[i];
    if (r <= 0 && weights[i] > 0) { pick = i; break; }
  }
  if (pick < 0) return fallback;

  const px = pick % W;
  const py = (pick - px) / W;
  return {
    x: ((px + Math.random()) / W) * img.naturalWidth,
    y: ((py + Math.random()) / H) * img.naturalHeight,
  };
}

/* =========================================================
   出題
   ========================================================= */

const shuffle = (a) => {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

function buildPool() {
  return settings.pool === 'uma' ? CHARS.filter((c) => c.cat === 'ウマ娘') : CHARS.slice();
}

function makeQuestion(char) {
  return {
    char,
    image: char.images[Math.floor(Math.random() * char.images.length)],
    frac: DIFFICULTY[settings.difficulty].frac,
    zoomOuts: 0,
    hintUsed: false,
    img: null,
    cx: 0,
    cy: 0,
  };
}

/** 画像を読み込み、拡大位置を決めるところまで。失敗したら別キャラに差し替える。 */
async function prepare(q, depth) {
  if (q.img) return q;
  try {
    const img = await loadImage(imgUrl(q.image.u), true);
    q.img = img;
    const spot = pickSpot(img);
    q.cx = spot.x;
    q.cy = spot.y;
    return q;
  } catch (e) {
    if ((depth || 0) >= 3) throw e;
    const alt = session.pool[Math.floor(Math.random() * session.pool.length)];
    const next = makeQuestion(alt);
    Object.assign(q, next);
    return prepare(q, (depth || 0) + 1);
  }
}

/* =========================================================
   ステージ描画
   ========================================================= */

const stage = $('stage');
const marker = $('crop-marker');

const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.min(Math.max(v, lo), hi));

function cropBox(q) {
  const nw = q.img.naturalWidth;
  const nh = q.img.naturalHeight;
  const size = q.frac * Math.min(nw, nh);
  return {
    nw, nh, size,
    cx: clamp(q.cx, size / 2, nw - size / 2),
    cy: clamp(q.cy, size / 2, nh - size / 2),
  };
}

function renderZoom(q, animate) {
  const V = stage.clientWidth;
  lastStageW = V;
  const b = cropBox(q);
  const scale = V / b.size;
  const tx = V / 2 - b.cx * scale;
  const ty = V / 2 - b.cy * scale;
  applyTransform(q.img, tx, ty, scale, animate);

  const times = Math.min(b.nw, b.nh) / b.size;
  $('zoom-label').textContent =
    `拡大 ×${times.toFixed(1)}　ズームアウト ${q.zoomOuts}/${MAX_ZOOMOUTS}`;
}

function renderWhole(q) {
  const V = stage.clientWidth;
  lastStageW = V;
  const b = cropBox(q);
  const scale = Math.min(V / b.nw, V / b.nh) * 0.94;
  const tx = (V - b.nw * scale) / 2;
  const ty = (V - b.nh * scale) / 2;
  applyTransform(q.img, tx, ty, scale, true);

  const s = b.size * scale;
  marker.style.left = tx + (b.cx - b.size / 2) * scale + 'px';
  marker.style.top = ty + (b.cy - b.size / 2) * scale + 'px';
  marker.style.width = s + 'px';
  marker.style.height = s + 'px';
  marker.classList.remove('hidden');
  $('zoom-label').textContent = 'この部分が出題されていました';
}

function applyTransform(img, tx, ty, scale, animate) {
  img.style.transition = animate ? '' : 'none';
  img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  if (!animate) {
    void img.offsetWidth; // reflow して transition を戻す
    img.style.transition = '';
  }
}

function mountImage(q) {
  stage.querySelectorAll('img').forEach((el) => el.remove());
  const img = q.img;
  img.style.width = img.naturalWidth + 'px';
  img.style.height = img.naturalHeight + 'px';
  stage.insertBefore(img, stage.firstChild);
  renderZoom(q, false);
}

/* =========================================================
   ゲーム進行
   ========================================================= */

function showScreen(id) {
  ['screen-title', 'screen-game', 'screen-result'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
}

function startGame() {
  stopAutoZoom();
  upcoming = null;
  current = null;
  const pool = buildPool();
  session = {
    pool,
    order: settings.count > 0 ? shuffle(pool).slice(0, Math.min(settings.count, pool.length)) : shuffle(pool),
    index: 0,
    score: 0,
    streak: 0,
    correct: 0,
    total: 0,
    misses: [],
    log: [],
    endless: settings.count === 0,
  };
  showScreen('screen-game');
  nextQuestion();
}

/** index を進めずに次に出題されるキャラを見る（エンドレスなら一巡ごとにシャッフルし直す） */
function peekCharacter() {
  if (session.endless && session.index >= session.order.length) {
    session.order = shuffle(session.pool);
    session.index = 0;
  }
  return session.order[session.index];
}

/** 先読み済みの問題があればそれを使う */
function takeQuestion() {
  const char = peekCharacter();
  if (!char) return null;
  const q = upcoming && upcoming.char.id === char.id ? upcoming : makeQuestion(char);
  upcoming = null;
  session.index++;
  return q;
}

async function nextQuestion() {
  if (!session.endless && session.index >= session.order.length) return finishGame();

  current = takeQuestion();
  if (!current) return finishGame();

  // 入力欄まわりをリセット
  $('answer-area').classList.remove('hidden');
  $('result-area').classList.add('hidden');
  $('hint-box').classList.add('hidden');
  marker.classList.add('hidden');
  $('input-msg').textContent = '';
  $('answer-input').value = '';
  $('answer-input').disabled = true;
  $('btn-zoomout').disabled = false;
  $('btn-hint').disabled = false;
  closeSuggest();
  $('stage-loading').textContent = '読み込み中…';
  $('stage-loading').classList.remove('hidden');
  updateHud();

  try {
    await prepare(current);
  } catch (e) {
    $('stage-loading').textContent = '画像を読み込めませんでした。次の問題へ…';
    setTimeout(nextQuestion, 1200);
    return;
  }

  $('stage-loading').classList.add('hidden');
  mountImage(current);
  $('answer-input').disabled = false;
  $('answer-input').focus();
  startAutoZoom();
  preloadNext();
}

/** 次の問題を先に決めて画像を裏で取っておく */
function preloadNext() {
  const char = peekCharacter();
  if (!char) { upcoming = null; return; }
  upcoming = makeQuestion(char);
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.src = imgUrl(upcoming.image.u);
}

function updateHud() {
  const total = session.endless ? '∞' : session.order.length;
  $('hud-progress').textContent = `${Math.min(session.index, session.order.length)} / ${total}`;
  $('hud-score').textContent = session.score;
  $('hud-streak').textContent = session.streak;
}

/* ---------- ズームアウト / ヒント ---------- */

function startAutoZoom() {
  stopAutoZoom();
  if (!settings.autozoom) return;
  autozoomTimer = setInterval(() => {
    if (!current || current.answered) return stopAutoZoom();
    if (current.zoomOuts >= MAX_ZOOMOUTS) return stopAutoZoom();
    zoomOut();
  }, AUTOZOOM_MS);
}
function stopAutoZoom() {
  if (autozoomTimer) clearInterval(autozoomTimer);
  autozoomTimer = null;
}

function zoomOut() {
  if (!current || current.answered || current.zoomOuts >= MAX_ZOOMOUTS) return;
  current.zoomOuts++;
  current.frac = Math.min(current.frac * ZOOMOUT_STEP, 1);
  renderZoom(current, true);
  $('btn-zoomout').disabled = current.zoomOuts >= MAX_ZOOMOUTS;
}

function showHint() {
  if (!current || current.answered || current.hintUsed) return;
  current.hintUsed = true;
  const c = current.char;
  const box = $('hint-box');
  box.innerHTML = `CV: <b>${escapeHtml(c.cv || '不明')}</b>　/　区分: <b>${escapeHtml(c.cat)}</b>　/　衣装: <b>${escapeHtml(current.image.t || '—')}</b>`;
  box.classList.remove('hidden');
  $('btn-hint').disabled = true;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

/* ---------- 回答 ---------- */

function submitAnswer(charOrNull) {
  if (!current || current.answered) return;
  current.answered = true;
  stopAutoZoom();
  closeSuggest();

  const correct = charOrNull && charOrNull.id === current.char.id;
  const streakBefore = session.streak;
  let gained = 0;

  session.total++;
  if (correct) {
    const base = Math.max(10, 100 - PENALTY_ZOOM * current.zoomOuts - (current.hintUsed ? PENALTY_HINT : 0));
    gained = base + Math.min(streakBefore, 5) * 10;
    session.score += gained;
    session.streak++;
    session.correct++;
  } else {
    session.streak = 0;
    session.misses.push({ char: current.char, guess: charOrNull });
  }
  session.log.push(
    correct ? (current.zoomOuts || current.hintUsed ? '🟨' : '🟩') : charOrNull ? '🟥' : '⬜'
  );

  $('answer-area').classList.add('hidden');
  $('result-area').classList.remove('hidden');

  const v = $('verdict');
  v.className = 'verdict ' + (correct ? 'ok' : 'ng');
  v.innerHTML = correct
    ? `正解！ +${gained}<small>${streakBefore >= 1 ? `連続ボーナス +${Math.min(streakBefore, 5) * 10}` : ''}</small>`
    : `不正解<small>${charOrNull ? 'あなたの回答: ' + escapeHtml(charOrNull.ja) : 'パスしました'}</small>`;

  $('answer-ja').textContent = current.char.ja;
  $('answer-en').textContent = current.char.en;
  $('answer-meta').textContent = (current.char.cv ? 'CV: ' + current.char.cv : '') + '　' + current.char.cat;
  $('answer-costume').textContent = current.image.t ? '衣装: ' + current.image.t : '';

  updateHud();
  renderWhole(current);
  $('btn-next').textContent = !session.endless && session.index >= session.order.length ? '結果を見る' : '次へ';
  $('btn-next').focus();
}

function finishGame() {
  stopAutoZoom();
  showScreen('screen-result');
  $('final-score').textContent = session.score;
  const acc = session.total ? Math.round((session.correct / session.total) * 100) : 0;

  const bestKey = `umazoom.best.${settings.difficulty}.${settings.pool}.${settings.count}`;
  const best = Number(localStorage.getItem(bestKey) || 0);
  let bestNote = '';
  if (session.score > best) {
    localStorage.setItem(bestKey, String(session.score));
    bestNote = '　🎉 自己ベスト更新！';
  } else if (best > 0) {
    bestNote = `　自己ベスト ${best}点`;
  }
  $('final-sub').textContent = `${session.correct} / ${session.total} 問正解（正答率 ${acc}%）${bestNote}`;

  $('share-squares').textContent = squareRows().join('\n');
  $('share-grid').classList.toggle('hidden', session.log.length === 0);
  $('share-squares').style.whiteSpace = 'pre-wrap';

  const list = $('miss-list');
  list.innerHTML = '';
  if (session.misses.length) {
    const head = document.createElement('p');
    head.className = 'result-sub';
    head.style.gridColumn = '1 / -1';
    head.style.margin = '0';
    head.textContent = '間違えたキャラ';
    list.appendChild(head);
  }
  session.misses.forEach((m) => {
    const div = document.createElement('div');
    div.className = 'miss';
    div.innerHTML =
      `<img src="${imgUrl(m.char.thumb || m.char.images[0].u, { w: 200, q: 75 })}" alt="" loading="lazy">` +
      `<b>${escapeHtml(m.char.ja)}</b>` +
      (m.guess ? `<span>→ ${escapeHtml(m.guess.ja)}</span>` : `<span>パス</span>`);
    list.appendChild(div);
  });
}

/* =========================================================
   共有（X / Web Share / クリップボード）
   ========================================================= */

const SHARE_MAX = 40; // 絵文字が長くなりすぎないよう上限を設ける

/** 10個ごとに改行した絵文字の行 */
function squareRows() {
  const marks = session.log.slice(0, SHARE_MAX);
  const rows = [];
  for (let i = 0; i < marks.length; i += 10) rows.push(marks.slice(i, i + 10).join(''));
  if (session.log.length > SHARE_MAX) rows.push(`…他${session.log.length - SHARE_MAX}問`);
  return rows;
}

function shareText() {
  const acc = session.total ? Math.round((session.correct / session.total) * 100) : 0;
  const poolName = settings.pool === 'uma' ? 'ウマ娘のみ' : '全キャラ';
  return [
    `ウマ娘 ズームクイズ 🔍`,
    `${DIFFICULTY[settings.difficulty].name} / ${poolName}`,
    `${session.score}点　${session.correct}/${session.total}問正解（${acc}%）`,
    '',
    ...squareRows(),
    '',
    '#ウマ娘ズームクイズ',
  ].join('\n');
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), 1800);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // file:// や非セキュアコンテキスト向けのフォールバック
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }
}

$('btn-share-x').addEventListener('click', () => {
  // 投稿画面を開くだけで、実際のポストはユーザーが確認して行う
  const url = 'https://x.com/intent/post?text=' + encodeURIComponent(shareText());
  window.open(url, '_blank', 'noopener,noreferrer');
});

$('btn-copy').addEventListener('click', async () => {
  toast((await copyText(shareText())) ? '結果をコピーしました' : 'コピーできませんでした');
});

if (navigator.share) {
  const btn = $('btn-share-native');
  btn.classList.remove('hidden');
  btn.addEventListener('click', async () => {
    try {
      await navigator.share({ title: 'ウマ娘 ズームクイズ', text: shareText() });
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('共有できませんでした');
    }
  });
}

/* =========================================================
   サジェスト付き入力
   ========================================================= */

const input = $('answer-input');
const suggestEl = $('suggest');
let suggestItems = [];
let suggestIndex = -1;

function closeSuggest() {
  suggestEl.classList.add('hidden');
  suggestEl.innerHTML = '';
  suggestItems = [];
  suggestIndex = -1;
}

function highlight(text, query) {
  const { n, map } = normalize(text);
  const i = n.indexOf(query);
  if (i < 0 || !query) return escapeHtml(text);
  const s = map[i];
  const e = map[i + query.length - 1] + 1;
  return escapeHtml(text.slice(0, s)) + '<mark>' + escapeHtml(text.slice(s, e)) + '</mark>' + escapeHtml(text.slice(e));
}

function updateSuggest() {
  const q = norm(input.value);
  if (!q) return closeSuggest();

  const pool = session ? session.pool : CHARS;
  const starts = [];
  const contains = [];
  for (const c of pool) {
    if (c.keys.some((k) => k.startsWith(q))) starts.push(c);
    else if (c.keys.some((k) => k.includes(q))) contains.push(c);
  }
  suggestItems = starts.concat(contains).slice(0, 8);
  if (!suggestItems.length) return closeSuggest();

  suggestEl.innerHTML = suggestItems
    .map((c, i) => `<li data-i="${i}"><span>${highlight(c.ja, q)}</span><span class="s-en">${escapeHtml(c.en)}</span></li>`)
    .join('');
  suggestEl.classList.remove('hidden');
  suggestIndex = 0;
  paintSuggest();
}

function paintSuggest() {
  [...suggestEl.children].forEach((li, i) => li.classList.toggle('on', i === suggestIndex));
  const on = suggestEl.children[suggestIndex];
  if (on) on.scrollIntoView({ block: 'nearest' });
}

function resolveTyped() {
  const q = norm(input.value);
  if (!q) return null;
  const pool = session ? session.pool : CHARS;
  const exact = pool.filter((c) => c.keys.includes(q));
  return exact.length === 1 ? exact[0] : null;
}

input.addEventListener('input', updateSuggest);
input.addEventListener('blur', () => setTimeout(closeSuggest, 150));
input.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!suggestItems.length) return;
    e.preventDefault();
    suggestIndex = (suggestIndex + (e.key === 'ArrowDown' ? 1 : -1) + suggestItems.length) % suggestItems.length;
    paintSuggest();
  } else if (e.key === 'Enter') {
    if (e.isComposing || e.keyCode === 229) return; // IME 変換中の確定は邪魔しない
    e.preventDefault();
    const picked = suggestItems[suggestIndex] || resolveTyped();
    if (picked) submitAnswer(picked);
    else $('input-msg').textContent = 'キャラクターが特定できません。候補から選んでください。';
  } else if (e.key === 'Escape') {
    closeSuggest();
  }
});
suggestEl.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  e.preventDefault();
  submitAnswer(suggestItems[Number(li.dataset.i)]);
});

/* =========================================================
   設定 UI とイベント
   ========================================================= */

function setupSegmented(id, key, onChange) {
  const box = $(id);
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const raw = btn.dataset.value;
    settings[key] = key === 'count' ? Number(raw) : raw;
    [...box.children].forEach((b) => b.classList.toggle('on', b === btn));
    saveSettings();
    if (onChange) onChange();
  });
  [...box.children].forEach((b) => {
    const v = key === 'count' ? Number(b.dataset.value) : b.dataset.value;
    b.classList.toggle('on', v === settings[key]);
  });
}

function describeSettings() {
  $('difficulty-desc').textContent = DIFFICULTY[settings.difficulty].label;
  const n = buildPool().length;
  $('pool-desc').textContent = `${n}人が出題対象（全${CHARS.length}人中）`;
}

setupSegmented('set-difficulty', 'difficulty', describeSettings);
setupSegmented('set-pool', 'pool', describeSettings);
setupSegmented('set-count', 'count');
$('set-autozoom').checked = !!settings.autozoom;
$('set-autozoom').addEventListener('change', (e) => {
  settings.autozoom = e.target.checked;
  saveSettings();
});
describeSettings();

$('btn-start').addEventListener('click', startGame);
$('btn-zoomout').addEventListener('click', zoomOut);
$('btn-hint').addEventListener('click', showHint);
$('btn-pass').addEventListener('click', () => submitAnswer(null));
$('btn-next').addEventListener('click', nextQuestion);
$('btn-retry').addEventListener('click', startGame);
$('btn-home').addEventListener('click', () => showScreen('screen-title'));
$('btn-settings').addEventListener('click', () => {
  if (!$('screen-game').classList.contains('hidden')) {
    if (session && session.total > 0) return finishGame();
    stopAutoZoom();
  }
  showScreen('screen-title');
});

document.addEventListener('keydown', (e) => {
  if ($('screen-game').classList.contains('hidden')) return;
  if (e.key === 'Enter' && !$('result-area').classList.contains('hidden')) {
    if (document.activeElement === $('btn-next')) return; // ボタン自身が click を発火するので二重送りしない
    e.preventDefault();
    nextQuestion();
  }
});

// ステージの実寸が変わったら拡大率を計算し直す。
// window の resize だけではアドレスバーの伸縮や向き変更を取りこぼし、
// 拡大率が前のサイズのまま残ってしまうため ResizeObserver で監視する。
let resizeTimer = null;
let lastStageW = 0;

function refreshStage() {
  if (!current || !current.img) return;
  const w = stage.clientWidth;
  if (!w || w === lastStageW) return;
  lastStageW = w;
  if (current.answered) renderWhole(current);
  else renderZoom(current, false);
}

const scheduleRefresh = () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(refreshStage, 100);
};

let stageObserver = null;
if (window.ResizeObserver) {
  stageObserver = new ResizeObserver(scheduleRefresh);
  stageObserver.observe(stage);
}
window.addEventListener('resize', scheduleRefresh);
window.addEventListener('orientationchange', scheduleRefresh);
