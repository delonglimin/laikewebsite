/* =============================================================================
 * 莱柯官网 · 首页 Hero「数据中枢」3D 动画
 * -----------------------------------------------------------------------------
 * 纯 Canvas 2D + 手写三维投影（绕 Y 偏航 / 绕 X 俯仰 + 透视），零第三方依赖。
 *
 * 视觉原则 —— 干净、锐利、克制：
 *   · 全部用矢量实心绘制（arc / line），不使用任何模糊贴图，边缘清晰不糊
 *   · 元素数量克制：实心节点球 + 稀疏连线 + 2 条轨道环 + 刻度环，无噪点
 *   · 白底 + 品牌蓝 #0152D9；远近用「颜色深浅」表达（近处实心深蓝、远处淡蓝），
 *     不靠大量半透明叠加，避免整体发灰发虚
 *
 * 交互：鼠标视差倾斜 / 拖拽旋转（松手带惯性）/ 点击脉冲波
 * 性能：devicePixelRatio ≤ 3；离屏与页面隐藏时暂停；prefers-reduced-motion 只绘一帧
 * ============================================================================= */
(() => {
  'use strict';

  const canvas = document.getElementById('lk-hero-3d');
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const host = canvas.parentElement || canvas;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const hint = document.getElementById('lk-hero-3d-hint');
  const mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduceMotion = !!(mq && mq.matches);

  /* ---------------------------------------------------------------- 品牌色 */
  const BLUE = '1,82,217'; // #0152D9 主题蓝
  const DEEP = '0,52,164'; // 品牌深蓝（近处节点 / 核心）
  const ACCENT = '8,211,187'; // #08D3BB 点缀
  const rgb = (c, a) => 'rgba(' + c + ',' + a + ')';

  /* ------------------------------------------------------------ 视图与姿态 */
  const FOV = 7.2; // 透视焦距，越大越接近正交
  const UNIT = 0.163; // 世界单位 → 像素
  const TAU = Math.PI * 2;
  let W = 1, H = 1, S = 1, dotScale = 1, hudR = 40;

  let spin = 0.6; // 自动偏航角
  let yawExtra = 0; // 拖拽累积偏航
  let yawVel = 0; // 拖拽惯性
  let tiltBase = -0.14; // 基础俯仰
  let mouseYaw = 0, mouseTilt = 0, mouseYawT = 0, mouseTiltT = 0; // 视差
  let dragTilt = 0, shock = 0; // 拖拽俯仰 / 点击脉冲增益
  let dragging = false, movedPx = 0, lastX = 0, lastY = 0;
  const pulses = [];
  let running = true, visible = true, last = 0;

  /* ---------------------------------------------------------------- 球面节点 */
  const N = 150; // 克制：150 个实心节点，密度刚好不糊
  const nodeX = new Float32Array(N), nodeY = new Float32Array(N), nodeZ = new Float32Array(N);
  const nodeS = new Float32Array(N), nodePh = new Float32Array(N);
  const nodeAccent = new Uint8Array(N);
  (() => {
    const ga = Math.PI * (3 - Math.sqrt(5)); // 黄金角
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const th = ga * i;
      nodeX[i] = Math.cos(th) * rr;
      nodeY[i] = y;
      nodeZ[i] = Math.sin(th) * rr;
      nodeS[i] = 0.85 + ((i * 37) % 100) / 100;
      nodePh[i] = (i * 1.7) % TAU;
      nodeAccent[i] = i % 17 === 3 ? 1 : 0; // 少量青色节点点缀
    }
  })();

  /* ------------------------------------------------------------- 两条轨道环 */
  const ringDefs = [
    { r: 1.36, rx: 0.46, rz: 0.18, n: 64, spd: 0.48, packets: 3, col: DEEP },
    { r: 1.74, rx: -0.3, rz: -0.6, n: 76, spd: -0.34, packets: 2, col: ACCENT },
  ];
  const rings = ringDefs.map((d, ri) => {
    const cx = Math.cos(d.rx), sx = Math.sin(d.rx), cz = Math.cos(d.rz), sz = Math.sin(d.rz);
    const at = (a) => {
      const x = Math.cos(a) * d.r, y = 0, z = Math.sin(a) * d.r;
      const y1 = y * cx - z * sx, z1 = y * sx + z * cx;
      return [x * cz - y1 * sz, x * sz + y1 * cz, z1];
    };
    const pts = [];
    for (let i = 0; i < d.n; i++) pts.push(at((i / d.n) * TAU));
    const packets = [];
    for (let i = 0; i < d.packets; i++) packets.push((i / d.packets) * TAU + ri * 1.1);
    return { d, at, pts, packets, dir: d.spd >= 0 ? 1 : -1 };
  });

  /* ------------------------------------------------------- 稀疏连线 + 数据流 */
  const links = [];
  (() => {
    const maxLinks = 22;
    for (let i = 0; i < N && links.length < maxLinks; i += 5) {
      let best = -1, bd = Infinity;
      for (let j = i + 1; j < N; j++) {
        const dx = nodeX[i] - nodeX[j], dy = nodeY[i] - nodeY[j], dz = nodeZ[i] - nodeZ[j];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; best = j; }
      }
      if (best > 0 && bd < 0.22) {
        links.push({
          a: i, b: best, ph: (links.length * 0.7) % 1,
          spd: 0.16 + (links.length % 5) * 0.05, dir: links.length % 2 ? 1 : -1,
        });
      }
    }
  })();

  const pxs = new Float32Array(N), pys = new Float32Array(N);
  const pzs = new Float32Array(N), pks = new Float32Array(N);
  const order = new Uint16Array(N);
  for (let i = 0; i < N; i++) order[i] = i;

  /* ------------------------------------------------------------ 三维投影 */
  let cy = 1, sy = 0, cx = 1, sx = 0;
  const proj = (x, y, z) => {
    const x1 = x * cy + z * sy;
    const z1 = -x * sy + z * cy;
    const y1 = y * cx - z1 * sx;
    const z2 = y * sx + z1 * cx;
    const k = FOV / (FOV - z2);
    return { x: W / 2 + x1 * k * S, y: H / 2 + y1 * k * S, z: z2, k };
  };

  /* -------------------------------------------------------- 实心圆快捷绘制 */
  const dot = (x, y, r, col, a) => {
    if (r < 0.3 || a <= 0.02) return;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = rgb(col, a > 1 ? 1 : a);
    ctx.fill();
  };

  /* -------------------------------------------------------------- 尺寸自适应 */
  const resize = () => {
    const rect = host.getBoundingClientRect();
    W = Math.max(1, rect.width);
    H = Math.max(1, rect.height);
    const m = Math.min(W, H);
    S = m * UNIT;
    dotScale = m / 560;
    hudR = m * 0.462;
    const dpr = Math.min(window.devicePixelRatio || 1, 3); // 上限 3，保证高分屏清晰
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  /* ------------------------------------------------------------ 各层绘制函数 */
  const drawHud = (t) => {
    ctx.save();
    ctx.translate(W / 2, H / 2);

    // 外圈刻度
    ctx.lineWidth = Math.max(0.8, dotScale * 0.9);
    ctx.strokeStyle = rgb(BLUE, 0.4);
    ctx.beginPath();
    for (let i = 0; i < 72; i++) {
      const a = (i * Math.PI) / 36;
      const len = i % 6 === 0 ? 9 * dotScale : 4.5 * dotScale;
      const c1 = Math.cos(a), s1 = Math.sin(a);
      ctx.moveTo(c1 * hudR, s1 * hudR);
      ctx.lineTo(c1 * (hudR + len), s1 * (hudR + len));
    }
    ctx.stroke();

    // 内圈细环
    ctx.strokeStyle = rgb(BLUE, 0.16);
    ctx.beginPath();
    ctx.arc(0, 0, hudR - 12 * dotScale, 0, TAU);
    ctx.stroke();

    // 单条扫描弧（渐隐；不做双向，避免杂乱）
    const base = t * 0.36;
    const span = 0.72;
    ctx.lineWidth = Math.max(1, 1.7 * dotScale);
    for (let s = 0; s < 14; s++) {
      const a0 = base + span * (s / 14);
      const a1 = base + span * ((s + 1) / 14);
      ctx.beginPath();
      ctx.arc(0, 0, hudR - 5 * dotScale, a0, a1);
      ctx.strokeStyle = rgb(DEEP, 0.05 + 0.4 * (s / 14));
      ctx.stroke();
    }
    ctx.restore();
  };

  const drawRings = (t, dt) => {
    for (let ri = 0; ri < rings.length; ri++) {
      const R = rings[ri];
      const d = R.d;

      // 环线
      ctx.beginPath();
      for (let i = 0; i <= R.pts.length; i++) {
        const q = R.pts[i % R.pts.length];
        const p = proj(q[0], q[1], q[2]);
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      }
      ctx.strokeStyle = rgb(BLUE, 0.3);
      ctx.lineWidth = Math.max(0.8, dotScale * 0.9);
      ctx.stroke();

      // 环上等分小点（隔点绘制，保持疏朗）
      for (let i = 0; i < R.pts.length; i += 2) {
        const q = R.pts[i];
        const p = proj(q[0], q[1], q[2]);
        const nz = (p.z / d.r + 1) / 2;
        dot(p.x, p.y, 1.15 * dotScale * p.k, BLUE, 0.3 + 0.5 * nz);
      }

      // 数据包 + 短拖尾
      for (let i = 0; i < R.packets.length; i++) {
        R.packets[i] += d.spd * dt;
        const a0 = R.packets[i];
        for (let s = 3; s >= 0; s--) {
          const a = a0 - R.dir * s * 0.07;
          const q = R.at(a);
          const p = proj(q[0], q[1], q[2]);
          const f = 1 - s / 4;
          const nz = (p.z / d.r + 1) / 2;
          dot(p.x, p.y, (s === 0 ? 3.1 : 2.3 * f + 0.5) * dotScale * p.k, d.col,
            (s === 0 ? 0.98 : 0.5 * f * f) * (0.55 + 0.45 * nz));
        }
      }
    }
  };

  const drawLinks = (t) => {
    const boost = shock * 1.4;
    ctx.lineWidth = Math.max(0.7, dotScale * 0.85);
    for (let i = 0; i < links.length; i++) {
      const L = links[i];
      const pa = proj(nodeX[L.a], nodeY[L.a], nodeZ[L.a]);
      const pb = proj(nodeX[L.b], nodeY[L.b], nodeZ[L.b]);
      const nz = (pa.z + pb.z) / 4 + 0.5; // 0(远) → 1(近)
      if (nz <= 0.05) continue;
      const breathe = 0.85 + 0.15 * Math.sin(t * 1.2 + L.ph * 6.28);

      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.strokeStyle = rgb(BLUE, Math.min(0.9, (0.26 + 0.48 * nz) * breathe + boost * 0.2));
      ctx.stroke();

      // 线上流动的数据点
      const f = (t * L.spd + L.ph) % 1;
      const g = L.dir > 0 ? f : 1 - f;
      const x = pa.x + (pb.x - pa.x) * g;
      const y = pa.y + (pb.y - pa.y) * g;
      const z = pa.z + (pb.z - pa.z) * g;
      const flash = 0.6 + 0.4 * Math.sin(f * Math.PI);
      dot(x, y, 1.5 * dotScale * (FOV / (FOV - z)), DEEP, 0.85 * nz * flash + boost * 0.3);
    }
  };

  const drawNodes = (t) => {
    for (let i = 0; i < N; i++) {
      // 内联投影，避免每帧创建临时对象
      const x0 = nodeX[i], y0 = nodeY[i], z0 = nodeZ[i];
      const x1 = x0 * cy + z0 * sy;
      const z1 = -x0 * sy + z0 * cy;
      const y1 = y0 * cx - z1 * sx;
      const z2 = y0 * sx + z1 * cx;
      const k = FOV / (FOV - z2);
      pxs[i] = W / 2 + x1 * k * S;
      pys[i] = H / 2 + y1 * k * S;
      pzs[i] = z2;
      pks[i] = k;
    }
    order.sort((a, b) => pzs[a] - pzs[b]); // 远 → 近，后画的压住前面的

    for (let m = 0; m < N; m++) {
      const i = order[m];
      const nz = (pzs[i] + 1) / 2;
      const r = (1.05 + 2.1 * nz) * nodeS[i] * dotScale * pks[i];
      if (r < 0.35) continue;
      const tw = 0.88 + 0.12 * Math.sin(t * 1.5 + nodePh[i]);
      let col, a;
      if (nodeAccent[i]) {
        col = ACCENT; a = 0.55 + 0.45 * nz;
      } else if (nz > 0.74) {
        col = DEEP; a = 1; // 近处实心深蓝，清晰锐利
      } else if (nz > 0.42) {
        col = BLUE; a = 0.66 + 0.34 * ((nz - 0.42) / 0.32);
      } else {
        col = BLUE; a = 0.16 + 0.5 * (nz / 0.42); // 远处淡蓝后退
      }
      dot(pxs[i], pys[i], r, col, a * tw);
    }
  };

  const drawPulses = (dt) => {
    const m = Math.min(W, H);
    for (let i = pulses.length - 1; i >= 0; i--) {
      const q = pulses[i];
      q.t += dt;
      const k = q.t / 1.4;
      if (k >= 1) { pulses.splice(i, 1); continue; }
      const e = 1 - (1 - k) * (1 - k);
      const r = m * (0.06 + 0.42 * e);
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, r, 0, TAU);
      ctx.strokeStyle = rgb(BLUE, 0.32 * (1 - k) * (1 - k));
      ctx.lineWidth = Math.max(0.9, (2 - 1.4 * k) * dotScale);
      ctx.stroke();
    }
  };

  /* ---------------------------------------------------------------- 主渲染 */
  let looping = false;
  const start = () => {
    if (looping || reduceMotion) return;
    looping = true;
    last = 0;
    requestAnimationFrame(frame);
  };

  const frame = (now) => {
    if (!running || reduceMotion) { looping = false; return; }
    requestAnimationFrame(frame);
    if (!visible) { last = 0; return; }

    if (!last) last = now;
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.05) dt = 0.05;
    const t = now / 1000;

    spin += 0.2 * dt;
    yawExtra += yawVel * dt;
    yawVel *= Math.pow(0.14, dt);
    if (Math.abs(yawVel) < 0.002) yawVel = 0;
    mouseYaw += (mouseYawT - mouseYaw) * Math.min(1, dt * 6);
    mouseTilt += (mouseTiltT - mouseTilt) * Math.min(1, dt * 6);
    shock *= Math.pow(0.1, dt);

    const totalYaw = spin + yawExtra + mouseYaw;
    const totalTilt = tiltBase + dragTilt + mouseTilt;
    cy = Math.cos(totalYaw); sy = Math.sin(totalYaw);
    cx = Math.cos(totalTilt); sx = Math.sin(totalTilt);

    ctx.clearRect(0, 0, W, H); // 透明底，直接浮于页面白底

    drawHud(t);

    // 顺序：连线 → 节点 → 轨道环 → 中心 → 脉冲
    drawLinks(t);
    drawNodes(t);
    drawRings(t, dt);

    // 中心：小实心点 + 细环
    dot(W / 2, H / 2, 2.4 * dotScale, DEEP, 0.9);
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, Math.min(W, H) * 0.052, 0, TAU);
    ctx.strokeStyle = rgb(BLUE, 0.16);
    ctx.lineWidth = Math.max(0.8, dotScale);
    ctx.stroke();

    drawPulses(dt);
  };

  /* ------------------------------------------------------------------ 交互 */
  const markInteracted = () => {
    if (hint && hint.style.opacity !== '0') hint.style.opacity = '0';
  };

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const nx = ((e.clientX - r.left) / r.width) * 2 - 1;
    const ny = ((e.clientY - r.top) / r.height) * 2 - 1;
    mouseYawT = nx * 0.3;
    mouseTiltT = -ny * 0.26;
    if (dragging) {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      movedPx += Math.abs(dx) + Math.abs(dy);
      yawExtra += dx * 0.006;
      dragTilt = Math.max(-0.95, Math.min(0.95, dragTilt + dy * 0.005));
      yawVel = dx * 0.28;
      markInteracted();
    }
  });
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    movedPx = 0;
    lastX = e.clientX; lastY = e.clientY;
    yawVel = 0;
    canvas.style.cursor = 'grabbing';
    if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (_) {} }
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = 'grab';
    if (movedPx < 6) {
      pulses.push({ t: 0 });
      shock = Math.min(1, shock + 0.9);
      markInteracted();
    }
    if (e && canvas.releasePointerCapture) { try { canvas.releasePointerCapture(e.pointerId); } catch (_) {} }
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (dragging) { dragging = false; canvas.style.cursor = 'grab'; }
    mouseYawT = 0; mouseTiltT = 0;
  });
  canvas.style.cursor = 'grab';

  /* --------------------------------------------------- 尺寸 / 可见性 / 生命周期 */
  if (window.ResizeObserver) {
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(resize);
    }).observe(host);
  } else {
    window.addEventListener('resize', resize);
  }

  if (window.IntersectionObserver) {
    new IntersectionObserver((es) => {
      visible = es[0].isIntersecting;
      last = 0;
      if (visible) start();
    }, { threshold: 0 }).observe(canvas);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) running = false;
    else { running = true; start(); }
  });

  resize();
  running = !reduceMotion;
  if (reduceMotion) {
    // 静态一帧
    spin = 0.7; tiltBase = -0.14; yawExtra = 0;
    cy = Math.cos(spin); sy = Math.sin(spin);
    cx = Math.cos(tiltBase); sx = Math.sin(tiltBase);
    ctx.clearRect(0, 0, W, H);
    drawHud(0);
    drawLinks(0); drawNodes(1.2); drawRings(0, 0);
    dot(W / 2, H / 2, 2.4 * dotScale, DEEP, 0.9);
    if (hint) hint.style.opacity = '0';
  } else {
    start();
  }
})();
