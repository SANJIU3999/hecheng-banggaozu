/* ===========================================================
   合成大肥鱼 · 圆形刚体物理
   - 分步积分 + 多次约束迭代（墙体/地面 与 球-球 一起收敛）
   - 碰撞体积（圆）与法向弹跳
   - 摩擦把「滑动」转换成「滚动」（线速度 ⇄ 角速度）
   - 同级球接触即立即合成（无碰撞过程）
   =========================================================== */
(function (window) {
  'use strict';

  var World = function (opts) {
    opts = opts || {};
    this.gravity = opts.gravity != null ? opts.gravity : 1900;      // 重力加速度 px/s²
    this.restitution = opts.restitution != null ? opts.restitution : 0.10; // 弹性（软，球基本不弹）
    this.grip = opts.grip != null ? opts.grip : 0.55;               // 球-球摩擦抓地力 0..1
    this.gripFloor = opts.gripFloor != null ? opts.gripFloor : 0.75; // 地面摩擦抓地力
    this.iterations = opts.iterations != null ? opts.iterations : 8; // 约束迭代次数
    this.sleepLinear = opts.sleepLinear != null ? opts.sleepLinear : 16;
    this.sleepAngular = opts.sleepAngular != null ? opts.sleepAngular : 0.6;
    this.sleepTime = opts.sleepTime != null ? opts.sleepTime : 0.5;
    this.linDamp = opts.linDamp != null ? opts.linDamp : 0.995;    // 线速度阻尼
    this.angDamp = opts.angDamp != null ? opts.angDamp : 0.99;     // 角速度阻尼（更大，让球滚动后停住，不一直转）
    this.mergeMargin = opts.mergeMargin != null ? opts.mergeMargin : 3;  // 同级接触判定余量（切线相贴也算接触）
    this.bounds = { left: 0, right: 520, top: 0, bottom: 820 };
    this.bodies = [];
    this.merges = [];      // 本步检测到的同级接触对（接触即合成）
  };

  World.prototype.clear = function () {
    this.bodies.length = 0;
    this.merges.length = 0;
  };

  World.prototype.add = function (b) {
    b.world = this; b.sleeping = false; b.sleepTimer = 0;
    this.bodies.push(b);
    return b;
  };

  World.prototype.remove = function (b) {
    var i = this.bodies.indexOf(b);
    if (i >= 0) this.bodies.splice(i, 1);
    b.world = null;
    return b;
  };

  World.prototype.setBounds = function (l, t, r, b) {
    this.bounds.left = l; this.bounds.top = t; this.bounds.right = r; this.bounds.bottom = b;
  };

  World.prototype.isFree = function (x, y, r, skip) {
    for (var i = 0; i < this.bodies.length; i++) {
      var b = this.bodies[i];
      if (b === skip) continue;
      var dx = b.x - x, dy = b.y - y, rr = b.r + r;
      if (dx * dx + dy * dy < rr * rr) return false;
    }
    return true;
  };

  World.prototype.wake = function (b) { b.sleeping = false; b.sleepTimer = 0; };
  World.prototype.wakeAll = function () {
    for (var i = 0; i < this.bodies.length; i++) this.wake(this.bodies[i]);
  };
  World.prototype.wakeAround = function (x, y, radius) {
    for (var i = 0; i < this.bodies.length; i++) {
      var b = this.bodies[i];
      var dx = b.x - x, dy = b.y - y;
      if (Math.sqrt(dx * dx + dy * dy) < b.r + radius) this.wake(b);
    }
  };

  World.prototype.step = function (dt) {
    var bodies = this.bodies, B = this.bounds, i, j, k, b;
    var n = bodies.length;

    /* ---- 1. 积分（自由下落 + 阻尼 + 防穿透限速） ---- */
    for (i = 0; i < n; i++) {
      b = bodies[i];
      if (b.sleeping || b.dead) continue;
      b.vy += this.gravity * dt;
      var ld = Math.pow(this.linDamp, dt * 60);
      var ad = Math.pow(this.angDamp, dt * 60);
      b.vx *= ld; b.vy *= ld; b.spin *= ad;
      var sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      var maxV = b.r * 0.85 / dt;
      if (sp > maxV) { var s = maxV / sp; b.vx *= s; b.vy *= s; }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.rot += b.spin * dt;
    }

    /* ---- 2. 约束迭代：墙体/地面 与 球-球 一起求解 ---- */
    this.merges.length = 0;

    for (k = 0; k < this.iterations; k++) {
      var first = (k === 0);

      /* 墙体 + 地面（位置每次修正；速度只在第一轮处理） */
      for (i = 0; i < n; i++) {
        b = bodies[i];
        if (b.sleeping || b.dead) continue;
        var hit = false;

        if (b.x - b.r < B.left) {
          b.x = B.left + b.r;
          if (first) {
            if (b.vx < 0) b.vx = -b.vx * this.restitution;
            b.vy *= (1 - this.grip * 0.35);
          } else if (b.vx < 0) b.vx = 0;
          hit = true;
        } else if (b.x + b.r > B.right) {
          b.x = B.right - b.r;
          if (first) {
            if (b.vx > 0) b.vx = -b.vx * this.restitution;
            b.vy *= (1 - this.grip * 0.35);
          } else if (b.vx > 0) b.vx = 0;
          hit = true;
        }

        if (b.y + b.r >= B.bottom) {
          b.y = B.bottom - b.r;
          if (b.vy > 0) {
            if (first) {
              if (b.vy > 60) b.sleepTimer = 0;
              b.vy = (b.vy < 42) ? 0 : -b.vy * this.restitution;
            } else {
              b.vy = 0;   // 后续迭代：地面支撑力抵消向下速度
            }
          }
          if (first) {
            /* 地面滚动摩擦：把水平滑动转换为自转（滚动约束） */
            var vt = b.vx - b.spin * b.r;
            var denom = b.invMass + b.r * b.r * b.invInertia;
            var jt = -vt * this.gripFloor / denom;
            b.vx += jt * b.invMass;
            b.spin += -b.r * jt * b.invInertia;
          }
          hit = true;
        } else if (b.y - b.r < B.top) {
          b.y = B.top + b.r;
          if (first) {
            if (b.vy < 0) b.vy = -b.vy * this.restitution;
          } else if (b.vy < 0) b.vy = 0;
          hit = true;
        }

        if (first) b.contact = hit;
      }

      /* 球-球碰撞 */
      for (i = 0; i < n; i++) {
        var a = bodies[i];
        if (a.dead) continue;
        for (j = i + 1; j < n; j++) {
          b = bodies[j];
          if (b.dead) continue;
          var dx = b.x - a.x, dy = b.y - a.y;
          var rr = a.r + b.r;
          var d2 = dx * dx + dy * dy;

          /* 同级接触 → 立即合成（带余量，切线相贴也算），跳过碰撞解算、不产生碰撞效果 */
          if (a.tier === b.tier && d2 > 0) {
            var cm = rr + this.mergeMargin;
            if (d2 <= cm * cm) {
              if (first) this.merges.push({ a: a, b: b, tier: a.tier });
              continue;
            }
          }

          /* 只有真正穿透才做物理碰撞解算 */
          if (d2 >= rr * rr || d2 === 0) continue;
          var d = Math.sqrt(d2);
          var nx = dx / d, ny = dy / d;
          var overlap = rr - d;

          /* 睡眠处理：两个都睡着→静止堆跳过；只有一个睡着→被撞醒 */
          if (a.sleeping && b.sleeping) continue;
          if (a.sleeping) this.wake(a);
          if (b.sleeping) this.wake(b);

          /* 位置修正（每次迭代都做） */
          var imSum = a.invMass + b.invMass;
          var corr = overlap / imSum * 0.85;
          a.x -= nx * corr * a.invMass; a.y -= ny * corr * a.invMass;
          b.x += nx * corr * b.invMass; b.y += ny * corr * b.invMass;

          /* 触地点相对速度（含自转） */
          var rAx = nx * a.r, rAy = ny * a.r;
          var rBx = -nx * b.r, rBy = -ny * b.r;
          var vax = a.vx - a.spin * rAy, vay = a.vy + a.spin * rAx;
          var vbx = b.vx - b.spin * rBy, vby = b.vy + b.spin * rBx;
          var relx = vbx - vax, rely = vby - vay;

          /* 法向冲量：第一轮用弹性（弹跳），后续用非弹性（提供支撑力，抵消重力/重量） */
          var vn = relx * nx + rely * ny;
          if (vn < 0) {
            var e = first ? this.restitution : 0;
            if (first && vn < -60) { a.sleepTimer = 0; b.sleepTimer = 0; }
            var jn = -(1 + e) * vn / imSum;
            a.vx -= nx * jn * a.invMass; a.vy -= ny * jn * a.invMass;
            b.vx += nx * jn * b.invMass; b.vy += ny * jn * b.invMass;
          }

          if (first) {
            /* 切向摩擦（把滑动转为滚动），只第一轮做一次 */
            var tx = -ny, ty = nx;
            var vt2 = relx * tx + rely * ty;
            var denomT = a.invMass + b.invMass + a.r * a.r * a.invInertia + b.r * b.r * b.invInertia;
            var jt = vt2 * this.grip / denomT;
            a.vx += tx * jt * a.invMass; a.vy += ty * jt * a.invMass;
            a.spin += a.r * jt * a.invInertia;
            b.vx -= tx * jt * b.invMass; b.vy -= ty * jt * b.invMass;
            b.spin += b.r * jt * b.invInertia;
          }

          a.contact = true; b.contact = true;
        }
      }
    }

    /* ---- 2.5 速度钳制：防止深重叠异常冲量把球弹飞 ---- */
    for (i = 0; i < n; i++) {
      b = bodies[i];
      if (b.dead || b.sleeping) continue;
      var sp2 = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      var maxV2 = b.r * 1.0 / dt;
      if (sp2 > maxV2) { var s2 = maxV2 / sp2; b.vx *= s2; b.vy *= s2; }
    }

    /* ---- 3. 睡眠（低速度且受支撑时） ---- */
    for (i = 0; i < n; i++) {
      b = bodies[i];
      if (b.sleeping || b.dead) continue;
      var speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      var onFloor = b.y + b.r > B.bottom - 0.7;
      if (speed < this.sleepLinear && Math.abs(b.spin) < this.sleepAngular && (b.contact || onFloor)) {
        b.sleepTimer += dt;
        if (b.sleepTimer > this.sleepTime) {
          b.sleeping = true;
          b.vx = 0; b.vy = 0; b.spin = 0;
        }
      } else {
        b.sleepTimer = 0;
      }
    }
  };

  var Body = function (opts) {
    this.x = opts.x || 0;
    this.y = opts.y || 0;
    this.vx = opts.vx || 0;
    this.vy = opts.vy || 0;
    this.rot = opts.rot || 0;
    this.spin = opts.spin || 0;
    this.r = opts.r || 20;
    this.tier = opts.tier || 0;
    this.mass = this.r * this.r;
    this.invMass = 1 / this.mass;
    this.inertia = 0.5 * this.mass * this.r * this.r;   // 圆盘转动惯量
    this.invInertia = 1 / this.inertia;
    this.sleeping = false;
    this.sleepTimer = 0;
    this.contact = false;
    this.dead = false;
    this.spawnScale = opts.spawnScale != null ? opts.spawnScale : 1;
    this.bornAt = opts.bornAt || 0;
    this.id = Body.uid++;
    this.world = null;
  };
  Body.uid = 1;

  window.Phys = { World: World, Body: Body };
})(window);
