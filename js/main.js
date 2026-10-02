/* ===========================================================
   合成邦高祖 · 主逻辑
   角色球 + 真实滚动物理 + 碰撞合成
   =========================================================== */
(function () {
  'use strict';

  var W = 520, H = 820;            // 逻辑世界尺寸（固定不变）
  var BALL_SCALE = 0.85;           // 球大小：大=0.85（球小、界面显大），小=1.2（球大、界面显小）
  var RIM = 8;                     // 鱼缸玻璃厚度
  var SPAWN_Y = 96;                // 抛球口
  var DANGER_Y = 120;              // 警戒线
  var DROP_COOLDOWN = 0.28;
  var COMBO_WINDOW = 1.6;
  var MAX_TIER = 10;
  var STEP = 1 / 120;              // 物理定步长

  /* 越靠前越常出现 */
  var SPAWN_WEIGHTS = [0, 5, 4, 3, 2.2, 1.5, 1, 0.6, 0.3, 0.12, 0.03];

  /* 10 个等级：从小到大（名字用于 BGM / 图鉴；图片在 assets/ball-01..10.png） */
  var BALLS = [
    { name: '千早爱音', color: '#ff5c6c', r: 27 },
    { name: '仓田真白', color: '#ff8a3d', r: 35 },
    { name: '美竹兰',   color: '#ffc53d', r: 42 },
    { name: '丸山彩',   color: '#a8d64c', r: 53 },
    { name: '丰川祥子', color: '#3dd68c', r: 63 },
    { name: '高松灯',   color: '#37c8e8', r: 80 },
    { name: '友希那',   color: '#4d7cff', r: 98 },
    { name: '和奏瑞依', color: '#9b5cff', r: 120 },
    { name: '弦卷心',   color: '#e84da8', r: 152 },
    { name: '户山香橙', color: '#f2f4f8', r: 188 }
  ];

  /* ---- 颜色工具 ---- */
  function hexRgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mixHex(a, b, t) {
    var A = hexRgb(a), B = hexRgb(b), o = '#';
    for (var i = 0; i < 3; i++) {
      var v = Math.round(A[i] + (B[i] - A[i]) * t);
      o += ('0' + v.toString(16)).slice(-2);
    }
    return o;
  }
  function lighten(h, t) { return mixHex(h, '#ffffff', t); }
  function darken(h, t) { return mixHex(h, '#0a0c11', t); }

  var $ = function (s) { return document.querySelector(s); };
  var canvas = $('#game');
  var ctx = canvas.getContext('2d');
  var nextCanvas = $('#nextCanvas');

  /* 合成出最大球（户山香橙）时的全屏爆炸特效 */
  var fxBoom = $('#fxBoom');
  function playBoom() {
    if (!fxBoom) return;
    try {
      fxBoom.currentTime = 0;
      fxBoom.classList.add('on');
      var p = fxBoom.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }
  if (fxBoom) fxBoom.addEventListener('ended', function () { fxBoom.classList.remove('on'); });

  var world = new Phys.World({
    gravity: 1900,
    restitution: 0.10,
    grip: 0.55,
    gripFloor: 0.75,
    iterations: 6,
    sleepLinear: 16,
    sleepAngular: 0.6,
    sleepTime: 0.5
  });
  world.setBounds(RIM, RIM, W - RIM, H - RIM);

  var imageMap = {};   // tier -> Image（预留，放图自动用）

  var G = {
    state: 'ready',
    score: 0,
    best: 0,
    combo: 0,
    comboTimer: 0,
    maxTier: 0,
    found: {},
    active: [],
    particles: [],
    popups: [],
    held: null,
    heldTier: 1,
    nextTier: 1,
    aimX: W / 2,
    pointerDown: false,
    cooldown: 0,
    overTimer: 0,
    time: 0,
    shake: 0,
    statMerges: 0,
    statSpawned: 0,
    debug: false
  };

  /* ============================ 缩放 ============================ */
  var view = { scale: 1, w: 0, h: 0, dpr: 1 };
  function resize() {
    var rect = canvas.parentElement.getBoundingClientRect();
    var dpr = Math.min(2.5, window.devicePixelRatio || 1);
    var scale = Math.min(rect.width / W, rect.height / H);
    var w = Math.round(W * scale), h = Math.round(H * scale);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    view.scale = scale * dpr;
    view.w = w; view.h = h; view.dpr = dpr;
  }
  window.addEventListener('resize', resize);
  if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas.parentElement);

  /* ============================ 工具 ============================ */
  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function fmt(n) { n = Math.round(n); return String(n); }

  function pickTier() {
    if (forceSpawn && forceSpawn.length) return clamp(forceSpawn.shift(), 1, MAX_TIER);
    /* 生成的球大小不超过 3（只随机 1~3） */
    var cap = Math.min(3, MAX_TIER);
    var total = 0, i;
    for (i = 1; i <= cap; i++) total += SPAWN_WEIGHTS[i];
    var r = Math.random() * total;
    for (i = 1; i <= cap; i++) { r -= SPAWN_WEIGHTS[i]; if (r <= 0) return i; }
    return 1;
  }
  var forceSpawn = null;

  function scoreFor(tier) { return tier * tier; }

  /* ============================ BGM 系统 ============================
     文件预留位置：
       assets/bgm/menu.mp3        主界面 BGM
       assets/bgm/bgm-01.mp3 … bgm-10.mp3   每个角色的专属 BGM
     放好文件刷新页面即生效；没有文件时静默跳过。 */
  var Bgm = {
    el: null,
    sfxEl: null,
    enabled: true,
    current: '',
    get: function () {
      if (!this.el) this.el = new Audio();
      return this.el;
    },
    getSfx: function () {
      if (!this.sfxEl) this.sfxEl = new Audio();
      return this.sfxEl;
    },
    play: function (src, vol) {
      if (!this.enabled || !src) return;
      var el = this.get();
      var v = vol != null ? vol : 0.6;
      if (this.current === src) {
        el.volume = v;
        if (el.paused) el.play().catch(function () {});
        return;
      }
      this.current = src;
      el.src = src;
      el.loop = true;
      el.volume = v;
      el.play().catch(function () {});
    },
    sfx: function () {
      if (!this.enabled) return;
      var el = this.getSfx();
      el.src = 'assets/bgm/merge.mp4';
      el.loop = false;
      el.volume = 0.8;
      try { el.currentTime = 0; } catch (e) {}
      el.play().catch(function () {});
    },
    menu: function () { this.play('assets/bgm/menu.mp4', 0.3); },
    tier: function (t) {
      if (t < 1 || t > MAX_TIER) return;
      this.play('assets/bgm/bgm-' + (t < 10 ? '0' : '') + t + '.mp4', 0.48);
    },
    stop: function () {
      var el = this.get();
      el.pause();
      this.current = '';
    },
    setEnabled: function (v) {
      this.enabled = v;
      if (!v) this.stop();
      else if (G.state === 'playing') this.tier(G.maxTier);
      else this.menu();
    }
  };

  /* 用户一进入网页就尝试放主界面 BGM；若被浏览器自动播放策略拦截，首次交互时补放 */
  function unlockBgm() {
    if (G.state === 'ready') Bgm.menu();
  }
  document.addEventListener('pointerdown', unlockBgm);
  document.addEventListener('keydown', unlockBgm);

  /* ============================ 粒子 / 飘字 ============================ */
  function burst(x, y, tier) {
    var color = BALLS[tier - 1].color;
    var n = Math.min(24, 6 + tier * 2);
    for (var i = 0; i < n; i++) {
      var a = rand(0, Math.PI * 2), sp = rand(50, 180) + tier * 6;
      G.particles.push({
        x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40,
        r: rand(2, 3.5 + tier * 0.5), life: rand(0.4, 0.9), max: 0.9,
        color: i % 3 === 0 ? '#ffffff' : color
      });
    }
    G.particles.push({ ring: true, x: x, y: y, r: 5 + tier * 2, vr: 240 + tier * 22, life: 0.4, max: 0.4, color: '#ffffff' });
  }
  function popup(x, y, text, color, size) {
    G.popups.push({ x: x, y: y, text: text, color: color || '#ffffff', size: size || 18, life: 1, max: 1 });
  }

  /* 出现「新的最大球」就触发：合成走音效+BGM，投放只走 BGM */
  function onNewMax(tier, isMerge) {
    if (tier > G.maxTier) {
      G.maxTier = tier;
      if (isMerge) Bgm.sfx();
      Bgm.tier(tier);
    }
  }

  /* ============================ 投放 ============================ */
  function ballR(tier) { return BALLS[tier - 1].r * BALL_SCALE; }

  function spawnHeld(tier, x) {
    var b = new Phys.Body({ x: x, y: SPAWN_Y, r: ballR(tier), tier: tier });
    b.spawnScale = 1;
    b.bornAt = G.time;
    return b;
  }

  function drop() {
    if (G.state !== 'playing' || G.cooldown > 0 || !G.held) return;
    var b = G.held;
    var r = b.r;   /* 使用实际（已缩放）半径 */
    var x = clamp(G.aimX, RIM + r + 1, W - RIM - r - 1);
    /* 不再限制最高点放置：始终允许投放 */
    b.x = x; b.y = SPAWN_Y;
    b.vy = 120;
    b.spawnScale = 0.6;
    world.add(b);
    world.wakeAround(x, SPAWN_Y, r + 40);
    G.active.push(b);
    G.held = null;
    G.statSpawned++;
    G.cooldown = DROP_COOLDOWN;

    /* 发现新等级 + 若投出的是「新的最大球」就切换 BGM（防止前期出大球不换歌） */
    if (!G.found[G.heldTier]) { G.found[G.heldTier] = true; updateProgress(); }
    onNewMax(G.heldTier, false);

    for (var i = 0; i < 6; i++) {
      G.particles.push({
        x: x + rand(-r * 0.5, r * 0.5), y: SPAWN_Y,
        vx: rand(-80, 80), vy: rand(-180, -60),
        r: rand(1.5, 3), life: rand(0.3, 0.55), max: 0.55, color: 'rgba(255,255,255,.85)'
      });
    }

    G.heldTier = G.nextTier;
    G.nextTier = pickTier();
    G.held = spawnHeld(G.heldTier, G.aimX);
    updateNextUI();
  }

  function updateNextUI() {
    drawBallPreview(nextCanvas, G.nextTier);
    var el = $('#nextTier');
    if (el) el.textContent = G.nextTier;
  }

  var toastTimer = 0;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1200);
  }

  /* ============================ 合成 ============================ */
  function removeActive(b) {
    var i = G.active.indexOf(b);
    if (i >= 0) G.active.splice(i, 1);
  }

  function merge(a, b, tier) {
    a.dead = b.dead = true;
    world.remove(a); world.remove(b);
    removeActive(a); removeActive(b);
    G.statMerges++;

    var nt = Math.min(MAX_TIER, tier + 1);
    var cfg = BALLS[nt - 1];
    var nr = ballR(nt);
    var mx = clamp((a.x + b.x) / 2, RIM + nr, W - RIM - nr);
    var my = clamp((a.y + b.y) / 2, RIM + nr, H - RIM - nr);
    var nb = new Phys.Body({
      x: mx, y: my, r: nr, tier: nt,
      vx: (a.vx + b.vx) / 2,
      vy: (a.vy + b.vy) / 2 - 30,
      spin: (a.spin + b.spin) / 2
    });
    nb.spawnScale = 0.5;
    nb.bornAt = G.time;
    world.add(nb);
    world.wakeAround(mx, my, nr + 60);
    G.active.push(nb);

    /* 分数 + 连击 */
    G.comboTimer = COMBO_WINDOW;
    G.combo++;
    var gain = scoreFor(nt) * (1 + Math.min(G.combo - 1, 8) * 0.2);
    G.score += gain;

    burst(mx, my, nt);
    popup(mx, my - nr * 0.4, '+' + Math.round(gain), '#fff59a', 16 + Math.min(nt, 6));
    G.shake = Math.max(G.shake, 2 + nt * 0.5);

    /* 出现「新的最大球」：合成音效 + 切换该角色 BGM（循环到下一个更大球） */
    onNewMax(nt, true);
    /* 合成出最大的球（户山香橙）时全屏播放爆炸特效 */
    if (nt >= MAX_TIER) playBoom();
    if (!G.found[nt]) { G.found[nt] = true; updateProgress(); }
    updateHUD();
  }

  function processMerges() {
    var ms = world.merges;
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      if (m.a.dead || m.b.dead) continue;
      merge(m.a, m.b, m.tier);
    }
    ms.length = 0;
  }

  /* ============================ 流程 ============================ */
  function reset() {
    world.clear();
    G.active.length = 0;
    G.particles.length = 0;
    G.popups.length = 0;
    G.score = 0;
    G.combo = 0;
    G.comboTimer = 0;
    G.maxTier = 0;
    G.found = {};
    G.cooldown = 0;
    G.overTimer = 0;
    G.shake = 0;
    G.statMerges = 0;
    G.statSpawned = 0;
    G.aimX = W / 2;
    G.heldTier = 1;             /* 第一个球一定是最小的 */
    G.nextTier = pickTier();
    G.held = spawnHeld(G.heldTier, G.aimX);
    G.state = 'playing';
    Bgm.stop();                 /* 结束主界面音乐，等待第一个球触发新的最大球 BGM */
    $('#overlayStart').hidden = true;
    $('#overlayOver').hidden = true;
    updateNextUI();
    updateProgress();
    updateHUD();
    updateTopbar();
  }

  function gameOver() {
    if (G.state === 'over') return;
    G.state = 'over';
    G.shake = 12;
    G.best = Math.max(G.best, Math.round(G.score));
    try { localStorage.setItem('feiyu_best', String(G.best)); } catch (e) {}
    $('#finalScore').textContent = fmt(G.score);
    $('#finalBest').textContent = fmt(G.best);
    $('#overlayOver').hidden = false;
    updateHUD();
    updateTopbar();
  }

  /* 从游戏内返回主界面 */
  function goToMenu() {
    if (G.state === 'ready') return;
    G.state = 'ready';
    world.clear();
    G.active.length = 0;
    G.particles.length = 0;
    G.popups.length = 0;
    G.score = 0;
    G.combo = 0;
    G.comboTimer = 0;
    G.maxTier = 0;
    G.found = {};
    G.cooldown = 0;
    G.overTimer = 0;
    G.shake = 0;
    G.statMerges = 0;
    G.statSpawned = 0;
    G.held = null;
    Bgm.stop();
    Bgm.menu();
    $('#overlayStart').hidden = false;
    $('#overlayOver').hidden = true;
    updateProgress();
    updateHUD();
    updateTopbar();
  }

  function updateHUD() {
    var scoreEl = $('#score'), bestEl = $('#best');
    if (scoreEl) scoreEl.textContent = fmt(G.score);
    if (bestEl) bestEl.textContent = fmt(G.best);
  }

  /* 主界面隐藏「下一个球」，进游戏后显示；大小按钮只在主界面显示；返回按钮只在游戏内显示 */
  function updateTopbar() {
    var inMenu = (G.state === 'ready');
    var nextEl = document.querySelector('.next');
    var sizeBtn = $('#btnSize');
    var menuBtn = $('#btnMenu');
    if (nextEl) nextEl.style.display = inMenu ? 'none' : '';
    if (sizeBtn) sizeBtn.style.display = inMenu ? '' : 'none';
    if (menuBtn) menuBtn.style.display = inMenu ? 'none' : '';
  }

  function updateProgress() {
    var row = $('#progress');
    row.innerHTML = '';
    BALLS.forEach(function (cfg, i) {
      var t = i + 1;
      var d = document.createElement('i');
      d.className = 'dot' + (G.found[t] ? ' on' : '');
      d.style.background = cfg.color;
      d.title = '等级 ' + t + ' · ' + cfg.name;
      row.appendChild(d);
    });
  }

  /* ============================ 输入 ============================ */
  function pointerToWorld(clientX) {
    var rect = canvas.getBoundingClientRect();
    return (clientX - rect.left) / rect.width * W;
  }
  function setAim(clientX) {
    if (!G.held) return;
    var r = G.held.r;
    G.aimX = clamp(pointerToWorld(clientX), RIM + r, W - RIM - r);
  }

  canvas.addEventListener('pointerdown', function (e) {
    if (G.state !== 'playing') return;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    G.pointerDown = true;
    setAim(e.clientX);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', function (e) {
    if (G.state !== 'playing') return;
    if (!G.pointerDown && e.pointerType !== 'mouse') return;
    setAim(e.clientX);
    e.preventDefault();
  });
  canvas.addEventListener('pointerup', function (e) {
    if (G.state !== 'playing') return;
    G.pointerDown = false;
    setAim(e.clientX);
    drop();
    e.preventDefault();
  });
  canvas.addEventListener('pointercancel', function () { G.pointerDown = false; });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  window.addEventListener('keydown', function (e) {
    var r = G.held ? G.held.r : ballR(G.heldTier);
    var step = e.shiftKey ? 3 : 9;
    switch (e.key) {
      case 'ArrowLeft': case 'a': case 'A':
        G.aimX = Math.max(RIM + r, G.aimX - step); e.preventDefault(); break;
      case 'ArrowRight': case 'd': case 'D':
        G.aimX = Math.min(W - RIM - r, G.aimX + step); e.preventDefault(); break;
      case ' ': case 'Enter':
        drop(); e.preventDefault(); break;
      case 'r': case 'R':
        if (G.state === 'over') reset(); e.preventDefault(); break;
    }
  });

  $('#btnRestart').addEventListener('click', reset);
  $('#btnStart').addEventListener('click', reset);
  $('#btnRetry').addEventListener('click', reset);
  var btnMenu = $('#btnMenu');
  if (btnMenu) btnMenu.addEventListener('click', goToMenu);

  var btnSound = $('#btnSound');
  if (btnSound) {
    btnSound.addEventListener('click', function () {
      Bgm.setEnabled(!Bgm.enabled);
      btnSound.textContent = Bgm.enabled ? '🔊' : '🔇';
      btnSound.classList.toggle('off', !Bgm.enabled);
    });
  }

  /* 游戏大小切换：大 / 小（只改球大小，界面不变；大=球小，小=球大） */
  var smallSize = false;
  try { smallSize = localStorage.getItem('feiyu_small') === '1'; } catch (e) {}
  var btnSize = $('#btnSize');
  function applySize() {
    BALL_SCALE = smallSize ? 1.2 : 0.85;
    if (btnSize) btnSize.textContent = smallSize ? '小' : '大';
    try { localStorage.setItem('feiyu_small', smallSize ? '1' : '0'); } catch (e) {}
  }
  if (btnSize) {
    btnSize.addEventListener('click', function () {
      smallSize = !smallSize;
      applySize();
    });
  }
  applySize();

  /* ============================ 更新 ============================ */
  function physicsStep(dt) {
    G.time += dt;
    if (G.cooldown > 0) G.cooldown = Math.max(0, G.cooldown - dt);
    if (G.shake > 0) G.shake = Math.max(0, G.shake - dt * 24);
    if (G.comboTimer > 0) { G.comboTimer -= dt; if (G.comboTimer <= 0) G.combo = 0; }

    if (G.held && G.state === 'playing') {
      G.held.x = G.aimX;
      G.held.y = SPAWN_Y;
      if (G.held.jiggle > 0) G.held.jiggle -= dt * 2.2;
    }

    if (G.state === 'playing' || G.state === 'over') {
      world.step(dt);
      processMerges();
    }
  }

  function updatePerFrame(dt) {
    /* 粒子 */
    for (var i = G.particles.length - 1; i >= 0; i--) {
      var p = G.particles[i];
      p.life -= dt;
      if (p.ring) { p.r += p.vr * dt; }
      else {
        p.vy += 500 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vx *= 0.99;
        if (p.y > H - RIM) { p.y = H - RIM; p.vy *= -0.35; }
      }
      if (p.life <= 0) G.particles.splice(i, 1);
    }
    /* 飘字 */
    for (i = G.popups.length - 1; i >= 0; i--) {
      var q = G.popups[i];
      q.life -= dt; q.y -= dt * 44;
      if (q.life <= 0) G.popups.splice(i, 1);
    }

    if (G.state !== 'playing') return;

    /* 警戒线判定：有球碰到线（顶边 <= 线）连续 3 秒即失败 */
    var touching = false;
    for (i = 0; i < G.active.length; i++) {
      var b = G.active[i];
      if (b.dead) continue;
      if (b.y - b.r <= DANGER_Y) { touching = true; break; }
    }
    if (touching) {
      G.overTimer += dt;
      if (G.overTimer >= 3) gameOver();
    } else {
      G.overTimer = 0;
    }
  }

  /* ============================ 绘制 ============================ */
  var bubbles = [];
  for (var bi = 0; bi < 14; bi++) {
    bubbles.push({ x: rand(RIM, W - RIM), y: rand(0, H), r: rand(1.5, 4), sp: rand(14, 46), ph: rand(0, 6.28) });
  }

  function drawBackground(g) {
    /* 半透明暗色薄纱：让背景视频隐约透进来，球体保持清晰 */
    var wg = g.createLinearGradient(0, 0, 0, H);
    wg.addColorStop(0, 'rgba(10,13,20,0.22)');
    wg.addColorStop(0.5, 'rgba(10,13,20,0.28)');
    wg.addColorStop(1, 'rgba(8,11,18,0.34)');
    g.fillStyle = wg;
    g.fillRect(0, 0, W, H);

    /* 微弱水波光 */
    g.save();
    g.globalAlpha = 0.04;
    g.fillStyle = '#ffffff';
    for (var i = 0; i < 4; i++) {
      var x = ((G.time * 10 + i * 190) % (W + 260)) - 130;
      g.beginPath();
      g.moveTo(x, 0); g.lineTo(x + 60, 0); g.lineTo(x + 170, H); g.lineTo(x + 50, H);
      g.closePath(); g.fill();
    }
    g.restore();

    /* 气泡 */
    g.save();
    for (i = 0; i < bubbles.length; i++) {
      var b = bubbles[i];
      b.y -= b.sp * 0.016;
      b.x += Math.sin(G.time * 1.2 + b.ph) * 0.3;
      if (b.y < -10) { b.y = H + rand(0, 50); b.x = rand(RIM, W - RIM); }
      g.strokeStyle = 'rgba(255,255,255,0.10)';
      g.lineWidth = 1;
      g.beginPath(); g.arc(b.x, b.y, b.r, 0, Math.PI * 2); g.stroke();
    }
    g.restore();
  }

  function drawDangerZone(g) {
    var p = Math.min(1, G.overTimer / 3);   // 0..1 随触碰时间增强
    g.save();
    g.setLineDash([10, 9]);
    g.lineDashOffset = -(G.time * 30 % 19);
    g.strokeStyle = 'rgba(255,90,110,' + (0.45 + p * 0.55) + ')';
    g.lineWidth = 2 + p * 2;
    g.beginPath();
    g.moveTo(RIM + 4, DANGER_Y);
    g.lineTo(W - RIM - 4, DANGER_Y);
    g.stroke();
    g.restore();
  }

  function drawWalls(g) {
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = RIM;
    g.beginPath();
    if (g.roundRect) g.roundRect(RIM / 2, RIM / 2, W - RIM, H - RIM, 22);
    else g.rect(RIM / 2, RIM / 2, W - RIM, H - RIM);
    g.stroke();
    g.restore();
  }

  function drawBall(ctx2, x, y, r, tier, rot, t, opts) {
    opts = opts || {};
    var cfg = BALLS[tier - 1];
    var sc = opts.scale != null ? opts.scale : 1;
    var rr = r * sc;

    /* 阴影 */
    ctx2.save();
    ctx2.globalAlpha = 0.22;
    ctx2.fillStyle = '#000';
    ctx2.beginPath();
    ctx2.ellipse(x, y + r * 0.88, r * 0.72, r * 0.16, 0, 0, Math.PI * 2);
    ctx2.fill();
    ctx2.restore();

    ctx2.save();
    ctx2.translate(x, y);

    var img = imageMap[tier];
    if (img && img.complete && img.naturalWidth > 0) {
      /* 图片：裁成圆显示，随球自转（滚动可见），cover 居中裁剪不拉伸 */
      ctx2.save();
      ctx2.rotate(rot);
      ctx2.beginPath(); ctx2.arc(0, 0, rr, 0, Math.PI * 2); ctx2.clip();
      var iw = img.naturalWidth, ih = img.naturalHeight;
      var s = Math.max((rr * 2) / iw, (rr * 2) / ih);
      var dw = iw * s, dh = ih * s;
      ctx2.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      ctx2.restore();
      ctx2.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx2.lineWidth = Math.max(1.5, rr * 0.045);
      ctx2.beginPath(); ctx2.arc(0, 0, rr - ctx2.lineWidth / 2, 0, Math.PI * 2); ctx2.stroke();
    } else {
      /* 3D 球体：径向渐变 + 高光 + 自转标记 */
      var g = ctx2.createRadialGradient(-rr * 0.35, -rr * 0.4, rr * 0.08, 0, 0, rr * 1.05);
      g.addColorStop(0, lighten(cfg.color, 0.5));
      g.addColorStop(0.42, cfg.color);
      g.addColorStop(1, darken(cfg.color, 0.5));
      ctx2.fillStyle = g;
      ctx2.beginPath(); ctx2.arc(0, 0, rr, 0, Math.PI * 2); ctx2.fill();

      ctx2.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx2.lineWidth = Math.max(1, rr * 0.035);
      ctx2.beginPath(); ctx2.arc(0, 0, rr - ctx2.lineWidth / 2, 0, Math.PI * 2); ctx2.stroke();

      /* 自转标记（让滚动可见） */
      ctx2.save();
      ctx2.rotate(rot);
      ctx2.globalAlpha = 0.30;
      ctx2.fillStyle = darken(cfg.color, 0.55);
      ctx2.beginPath(); ctx2.arc(rr * 0.52, 0, rr * 0.15, 0, Math.PI * 2); ctx2.fill();
      ctx2.restore();

      /* 高光 */
      ctx2.globalAlpha = 0.5;
      ctx2.fillStyle = '#fff';
      ctx2.beginPath(); ctx2.ellipse(-rr * 0.34, -rr * 0.42, rr * 0.26, rr * 0.16, -0.7, 0, Math.PI * 2); ctx2.fill();
      ctx2.globalAlpha = 1;

      /* 等级数字 */
      ctx2.fillStyle = 'rgba(255,255,255,0.95)';
      ctx2.font = '700 ' + Math.max(11, Math.round(rr * 0.85)) + 'px system-ui, sans-serif';
      ctx2.textAlign = 'center'; ctx2.textBaseline = 'middle';
      ctx2.shadowColor = 'rgba(0,0,0,0.55)';
      ctx2.shadowBlur = rr * 0.08;
      ctx2.fillText(String(tier), 0, rr * 0.03);
      ctx2.shadowBlur = 0;
    }

    ctx2.restore();
  }

  function drawBallPreview(cv, tier) {
    var css = cv.clientWidth || 46;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var px = Math.round(css * dpr);
    if (cv.width !== px) { cv.width = px; cv.height = px; }
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, css, css);
    drawBall(g, css / 2, css / 2, Math.max(6, css / 2 - 4), tier, 0, G.time);
  }

  function drawActive(g) {
    /* 位置低的画在上面，层次自然 */
    var arr = G.active.slice().sort(function (a, b) { return (a.y + a.r) - (b.y + b.r); });
    for (var i = 0; i < arr.length; i++) {
      var b = arr[i];
      if (b.dead) continue;
      /* 出生缩放动画 */
      if (b.spawnScale < 1) {
        var t = Math.min(1, (G.time - b.bornAt) / 0.18);
        var e = 1 - Math.pow(1 - t, 3);
        b.spawnScale = 0.5 + 0.5 * e + (t < 1 ? Math.sin(t * Math.PI) * 0.08 : 0);
        if (t >= 1) b.spawnScale = 1;
      }
      drawBall(g, b.x, b.y, b.r, b.tier, b.rot, G.time, {
        scale: b.spawnScale
      });
    }
    /* 待投放的球 */
    if (G.held && G.state === 'playing') {
      var bob = Math.sin(G.time * 3.2) * 2.5;
      var jig = G.held.jiggle > 0 ? Math.sin(G.time * 40) * 4 * G.held.jiggle : 0;
      drawBall(g, G.held.x + jig, G.held.y + bob, G.held.r, G.held.tier, G.time * 0.8, G.time);
    }
  }

  function drawAim(g) {
    if (!G.held || G.state !== 'playing') return;
    var r = G.held.r;
    g.save();
    g.setLineDash([7, 8]);
    g.lineDashOffset = -(G.time * 50 % 15);
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(255,255,255,0.28)';
    g.beginPath();
    g.moveTo(G.aimX, SPAWN_Y + r);
    g.lineTo(G.aimX, H - RIM - 4);
    g.stroke();
    g.restore();
  }

  function drawParticles(g) {
    for (var i = 0; i < G.particles.length; i++) {
      var p = G.particles[i];
      var a = Math.max(0, p.life / p.max);
      g.save();
      g.globalAlpha = a;
      if (p.ring) {
        g.strokeStyle = p.color;
        g.lineWidth = 2.5 * a + 0.5;
        g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.stroke();
      } else {
        g.fillStyle = p.color;
        g.beginPath(); g.arc(p.x, p.y, p.r * (0.4 + a * 0.6), 0, Math.PI * 2); g.fill();
      }
      g.restore();
    }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (i = 0; i < G.popups.length; i++) {
      var q = G.popups[i];
      g.save();
      g.globalAlpha = Math.min(1, q.life / q.max * 1.5);
      g.font = '800 ' + q.size + 'px system-ui, sans-serif';
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(0,0,0,0.4)';
      g.strokeText(q.text, q.x, q.y);
      g.fillStyle = q.color;
      g.fillText(q.text, q.x, q.y);
      g.restore();
    }
  }

  function render() {
    var g = ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.save();
    var sh = G.shake;
    var ox = sh ? rand(-sh, sh) : 0, oy = sh ? rand(-sh, sh) : 0;
    g.setTransform(view.scale, 0, 0, view.scale, ox * view.dpr, oy * view.dpr);
    drawBackground(g);
    drawDangerZone(g);
    drawActive(g);
    drawAim(g);
    drawParticles(g);
    drawWalls(g);
    g.restore();
  }

  /* ============================ 主循环 ============================ */
  var last = performance.now();
  var acc = 0;

  function frame(now) {
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    acc += dt;
    var guard = 0;
    while (acc >= STEP && guard < 16) {
      physicsStep(STEP);
      acc -= STEP;
      guard++;
    }
    if (guard >= 16) acc = 0;
    updatePerFrame(dt);
    render();
    requestAnimationFrame(frame);
  }

  /* ============================ 图片预留 ============================ */
  function loadBallImages() {
    BALLS.forEach(function (cfg, i) {
      var tier = i + 1;
      var img = new Image();
      img.onload = function () { imageMap[tier] = img; };
      img.onerror = function () { imageMap[tier] = null; };
      img.src = 'assets/ball-' + (tier < 10 ? '0' : '') + tier + '.png';
    });
  }

  /* ============================ 调试/演示参数 ============================ */
  function urlParams() {
    var o = {};
    location.search.replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      o[decodeURIComponent(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? '1' : decodeURIComponent(kv.slice(i + 1));
    });
    return o;
  }
  var dropQueue = [];
  function debugAutoplay(p) {
    G.debug = !!p.debug;
    if (p.small !== undefined) { smallSize = (p.small === '1'); applySize(); }
    if (p.boom) setTimeout(playBoom, 400);   // 调试：直接播一次爆炸特效
    if (p.spawn) forceSpawn = p.spawn.split(',').map(Number);   // 先定出鱼顺序，reset 时就会用
    if (p.auto) reset();
    if (p.drop) {
      var xs = p.drop.split(',').map(Number);
      if (G.state !== 'playing') reset();
      dropQueue = xs.map(function (x, idx) { return { t: 0.30 * idx, x: x }; });
    }
    if (p.force) {
      var frames = Math.max(1, Math.min(30000, Number(p.force) || 0));
      for (var f = 0; f < frames; f++) {
        for (var q = dropQueue.length - 1; q >= 0; q--) {
          dropQueue[q].t -= STEP;
          if (dropQueue[q].t <= 0) {
            G.aimX = dropQueue[q].x; G.cooldown = 0; drop();
            dropQueue.splice(q, 1);
          }
        }
        physicsStep(STEP);
        updatePerFrame(STEP);
      }
      if (p.still) { G.particles.length = 0; G.popups.length = 0; G.shake = 0; }
      render();
    }
  }

  function boot() {
    try { G.best = parseInt(localStorage.getItem('feiyu_best') || '0', 10) || 0; } catch (e) {}
    loadBallImages();
    resize();
    updateProgress();
    updateTopbar();
    G.heldTier = 1;             /* 第一个球一定是最小的 */
    G.nextTier = pickTier();
    G.held = spawnHeld(G.heldTier, G.aimX);
    updateNextUI();
    updateHUD();
    $('#overlayStart').hidden = false;
    $('#overlayOver').hidden = true;
    $('#btnStart').addEventListener('click', reset);
    /* 进入网页就尝试播放主界面 BGM（被自动播放策略拦截时会由首次交互补放） */
    Bgm.menu();
    requestAnimationFrame(frame);
    try { debugAutoplay(urlParams()); } catch (e) { console.warn(e); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__FISH_GAME__ = G;
})();
