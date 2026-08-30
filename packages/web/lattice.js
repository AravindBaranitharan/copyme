/**
 * Kinetic lattice — a spring-mass grid that reacts to the pointer and to
 * shockwaves the app fires when something actually happens.
 *
 * Ported from a React component to plain canvas: the original only used React
 * to hold refs, and every line that matters is Canvas 2D, so nothing is lost by
 * dropping the framework.
 *
 * Monochrome by design. Ink and ground are read from CSS custom properties, so
 * it follows the page's theme rather than carrying a palette of its own.
 */

const SPACING = 52;
const SPRING_K = 26;
const DAMPING = 0.85;
const POINTER_RADIUS = 200;
const MAX_PULSES = 34;

export function createLattice(canvas, { onFrame } = {}) {
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return { destroy() {}, shockwave() {}, setRunning() {} };

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let nodes = [];
  let pulses = [];
  let waves = [];
  let dims = { width: 0, height: 0, cols: 0, rows: 0 };
  let running = !reduced;
  let raf = 0;
  let last = performance.now();

  const pointer = { x: -2000, y: -2000, px: -2000, py: -2000, vx: 0, vy: 0, down: false };

  /** Reads ink and ground from the stylesheet so themes stay in one place. */
  function palette() {
    const s = getComputedStyle(document.documentElement);
    return {
      ground: s.getPropertyValue("--bg").trim() || "#000000",
      ink: s.getPropertyValue("--ink").trim() || "#ffffff",
    };
  }

  function build(width, height) {
    const cols = Math.ceil(width / SPACING) + 1;
    const rows = Math.ceil(height / SPACING) + 1;
    const next = [];
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const x = c * SPACING;
        const y = r * SPACING;
        next.push({
          x, y, vx: 0, vy: 0, baseX: x, baseY: y, col: c, row: r,
          label: `0x${((c * 17 + r * 31) % 256).toString(16).padStart(2, "0").toUpperCase()}`,
          tension: 0,
          phase: Math.random() * Math.PI * 2,
        });
      }
    }
    dims = { width, height, cols, rows };
    nodes = next;
    pulses = [];
  }

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (!width || !height) continue;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      build(width, height);
    }
  });
  observer.observe(canvas.parentElement ?? canvas);

  /* ------------------------------------------------------------- pointer */

  const onMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
  };
  const onLeave = () => { pointer.x = -2000; pointer.y = -2000; pointer.down = false; };
  const onDown = (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer.down = true;
    shockwave(e.clientX - rect.left, e.clientY - rect.top, 1.1, 380);
  };
  const onUp = () => { pointer.down = false; };

  addEventListener("pointermove", onMove, { passive: true });
  addEventListener("pointerdown", onDown, { passive: true });
  addEventListener("pointerup", onUp, { passive: true });
  document.addEventListener("pointerleave", onLeave);

  /* ------------------------------------------------------------ commands */

  /** Fire a ring from a point, or from an element's centre. */
  function shockwave(x, y, power = 0.9, maxRadius = 460) {
    waves.push({ x, y, radius: 8, maxRadius, power });
  }

  function shockwaveFrom(element, power = 1.2) {
    const rect = canvas.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    shockwave(box.left + box.width / 2 - rect.left, box.top + box.height / 2 - rect.top, power);
  }

  /* -------------------------------------------------------------- render */

  function link(n1, n2, ink) {
    const d = Math.hypot(n1.x - n2.x, n1.y - n2.y);
    const stretch = Math.abs(d - SPACING) / SPACING;
    // Clamped: stretch is unbounded when a shockwave flings nodes far, and an
    // unclamped glow drives lineWidth past 14px, which reads as broken rather
    // than energetic.
    const glow = Math.min(1, Math.max(n1.tension, n2.tension, stretch * 2));

    if (glow > 0.05) {
      ctx.strokeStyle = ink;
      ctx.globalAlpha = Math.min(1, 0.22 + glow * 0.78);
      ctx.lineWidth = 0.7 + glow * 1.1;
    } else {
      ctx.strokeStyle = ink;
      ctx.globalAlpha = 0.07;
      ctx.lineWidth = 0.65;
    }
    ctx.beginPath();
    ctx.moveTo(n1.x, n1.y);
    ctx.lineTo(n2.x, n2.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.033);
    last = now;
    raf = requestAnimationFrame(frame);
    if (!running) return;

    const { width, height, cols, rows } = dims;
    if (!width) return;
    const { ground, ink } = palette();

    pointer.vx = (pointer.x - pointer.px) / (dt * 1000 || 1);
    pointer.vy = (pointer.y - pointer.py) / (dt * 1000 || 1);
    pointer.px = pointer.x;
    pointer.py = pointer.y;
    const speed = Math.hypot(pointer.vx, pointer.vy);

    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, width, height);

    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i];
      w.radius += 400 * dt;
      w.power *= Math.pow(0.12, dt);
      if (w.radius > w.maxRadius || w.power < 0.01) waves.splice(i, 1);
    }

    for (const n of nodes) {
      n.phase += dt * 3.2;

      const dx = pointer.x - n.x;
      const dy = pointer.y - n.y;
      const dist = Math.hypot(dx, dy);
      if (dist < POINTER_RADIUS && dist > 0) {
        const ratio = 1 - dist / POINTER_RADIUS;
        const force = ratio * (1500 + speed * 170 + (pointer.down ? 2200 : 0));
        const a = Math.atan2(dy, dx);
        n.vx -= Math.cos(a) * force * dt;
        n.vy -= Math.sin(a) * force * dt;
        n.tension = Math.min(1, n.tension + ratio * 0.5);
      }

      for (const w of waves) {
        const wd = Math.hypot(n.x - w.x, n.y - w.y);
        const delta = Math.abs(wd - w.radius);
        if (delta < 55) {
          const force = (1 - delta / 55) * w.power * 1700;
          const a = Math.atan2(n.y - w.y, n.x - w.x);
          n.vx += Math.cos(a) * force * dt;
          n.vy += Math.sin(a) * force * dt;
          n.tension = 1;
        }
      }

      n.vx += (n.baseX - n.x) * SPRING_K * dt;
      n.vy += (n.baseY - n.y) * SPRING_K * dt;
      n.vx *= DAMPING;
      n.vy *= DAMPING;
      n.x += n.vx * dt * 60;
      n.y += n.vy * dt * 60;
      n.tension = Math.max(0, n.tension - dt * 0.9);
    }

    if (Math.random() < 0.28 && nodes.length && pulses.length < MAX_PULSES) {
      const fromIdx = Math.floor(Math.random() * nodes.length);
      const from = nodes[fromIdx];
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const [dc, dr] = dirs[Math.floor(Math.random() * 4)];
      const tc = from.col + dc;
      const tr = from.row + dr;
      if (tc >= 0 && tc < cols && tr >= 0 && tr < rows) {
        const toIdx = tc * rows + tr;
        if (nodes[toIdx]) pulses.push({ from: fromIdx, to: toIdx, t: 0, speed: 1.6 + Math.random() * 2.2 });
      }
    }

    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const n = nodes[c * rows + r];
        if (!n) continue;
        const right = nodes[(c + 1) * rows + r];
        const down = nodes[c * rows + r + 1];
        if (c < cols - 1 && right) link(n, right, ink);
        if (r < rows - 1 && down) link(n, down, ink);
      }
    }

    ctx.fillStyle = ink;
    for (let p = pulses.length - 1; p >= 0; p--) {
      const pulse = pulses[p];
      pulse.t += dt * pulse.speed;
      const a = nodes[pulse.from];
      const b = nodes[pulse.to];
      if (!a || !b || pulse.t >= 1) {
        if (b) b.tension = Math.min(1, b.tension + 0.35);
        pulses.splice(p, 1);
        continue;
      }
      ctx.beginPath();
      ctx.arc(a.x + (b.x - a.x) * pulse.t, a.y + (b.y - a.y) * pulse.t, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const n of nodes) {
      const dist = Math.hypot(pointer.x - n.x, pointer.y - n.y);
      const near = dist < POINTER_RADIUS;
      const radius = near ? 1.4 * 2.2 + n.tension * 1.5 : 1.4 + Math.sin(n.phase) * 0.25;

      if (near || n.tension > 0.1) {
        ctx.fillStyle = ink;
        ctx.globalAlpha = Math.min(1, 0.2 + n.tension * 0.6);
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius * 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      ctx.fillStyle = ink;
      ctx.globalAlpha = near || n.tension > 0.1 ? 1 : 0.26;
      ctx.beginPath();
      ctx.arc(n.x, n.y, Math.max(0.8, radius), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      if (dist < 88) {
        const ring = ((n.phase * 20) % 32) + 4;
        ctx.strokeStyle = ink;
        ctx.globalAlpha = (1 - ring / 36) * 0.35;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(n.x, n.y, ring, 0, Math.PI * 2);
        ctx.stroke();

        ctx.globalAlpha = 0.8;
        ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(n.label, n.x + 9, n.y - 9);
        ctx.globalAlpha = 1;
      }
    }

    onFrame?.();
  }

  raf = requestAnimationFrame(frame);

  return {
    shockwave,
    shockwaveFrom,
    setRunning(next) { running = next; },
    isRunning() { return running; },
    destroy() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerdown", onDown);
      removeEventListener("pointerup", onUp);
      document.removeEventListener("pointerleave", onLeave);
    },
  };
}
