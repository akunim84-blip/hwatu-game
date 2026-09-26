/* 친구끼리 화투 - 효과음(Web Audio 합성) + 카드 날리기 애니메이션 헬퍼. HWATU_FX_V1 */
(function () {
  const LSK = 'hw_mute';
  let muted = false;
  try { muted = localStorage.getItem(LSK) === '1'; } catch (e) {}
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null, master = null, noiseBuf = null;

  function ensure() {
    if (!AC) return null;
    if (!ctx) {
      try {
        ctx = new AC();
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -10; comp.knee.value = 6; comp.ratio.value = 4;
        comp.attack.value = 0.001; comp.release.value = 0.08;
        master = ctx.createGain(); master.gain.value = 0.9;
        master.connect(comp); comp.connect(ctx.destination);
        // 0.25초 화이트 노이즈 (카드 '탁' 소리의 재료)
        const len = Math.floor(ctx.sampleRate * 0.25);
        noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      } catch (e) { ctx = null; return null; }
    }
    return ctx;
  }
  // 모바일 자동재생 제한: 첫 터치에서 AudioContext 생성/resume + 무음 버퍼 재생 (iOS/카톡 인앱)
  function unlock() {
    const c = ensure();
    if (!c) return done();
    try {
      if (c.state !== 'running') { const pr = c.resume(); if (pr && pr.then) pr.then(() => { if (c.state === 'running') done(); }).catch(() => {}); }
      const b = c.createBuffer(1, 1, 22050), s = c.createBufferSource();
      s.buffer = b; s.connect(c.destination); s.start(0);
    } catch (e) {}
    if (c.state === 'running') done();
  }
  const EVS = ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'keydown', 'click'];
  function done() { EVS.forEach((e) => document.removeEventListener(e, unlock, true)); }
  EVS.forEach((e) => document.addEventListener(e, unlock, { capture: true, passive: true }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx && ctx.state !== 'running') { try { ctx.resume(); } catch (e) {} } });

  function ready() {
    if (muted) return null;
    const c = ensure();
    if (!c) return null;
    if (c.state !== 'running') { try { c.resume(); } catch (e) {} if (c.state !== 'running') return null; }
    return c;
  }
  function noise(c, t, rate) {
    const s = c.createBufferSource();
    s.buffer = noiseBuf; s.playbackRate.value = rate || 1;
    s.start(t, Math.random() * 0.1); s.stop(t + 0.15);
    return s;
  }
  function env(c, t, peak, dec, att) {
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + (att || 0.0015));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
    return g;
  }
  // 바닥에 패를 '탁' 내려치는 소리: 대역 노이즈(찰싹) + 고역 클릭 + 낮은 쿵
  function tak(vol) {
    const c = ready(); if (!c) return;
    vol = vol == null ? 1 : vol;
    const t = c.currentTime + 0.005, v = 0.85 + Math.random() * 0.3;
    // 1) 몸통: 밴드패스 노이즈, 빠른 감쇠
    const n1 = noise(c, t, v);
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500 * v; bp.Q.value = 1.1;
    const g1 = env(c, t, 1.1 * vol, 0.07);
    n1.connect(bp); bp.connect(g1); g1.connect(master);
    // 2) 찰싹 하는 고역 클릭
    const n2 = noise(c, t, 1);
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4200;
    const g2 = env(c, t, 0.55 * vol, 0.022, 0.0008);
    n2.connect(hp); hp.connect(g2); g2.connect(master);
    // 3) 담요(군용 모포) 위에 떨어지는 낮은 쿵
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(170 * v, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.09);
    const g3 = env(c, t, 0.75 * vol, 0.11, 0.002);
    o.connect(g3); g3.connect(master); o.start(t); o.stop(t + 0.13);
  }
  // 패 돌릴 때 부드러운 '틱'
  function tick() {
    const c = ready(); if (!c) return;
    const t = c.currentTime + 0.003, v = 0.9 + Math.random() * 0.2;
    const n = noise(c, t, v);
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2800 * v; bp.Q.value = 1.6;
    const g = env(c, t, 0.32, 0.03, 0.001);
    n.connect(bp); bp.connect(g); g.connect(master);
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(260, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.04);
    const g2 = env(c, t, 0.12, 0.045);
    o.connect(g2); g2.connect(master); o.start(t); o.stop(t + 0.06);
  }
  // 셔플 소리: 반으로 가를 때 '슥' + 리플(촤라락) 연속 틱 + 정리할 때 '톡톡'
  function shuffle(total) {
    const c = ready(); if (!c) return;
    total = (total || 1000) / 1000;
    const t0 = c.currentTime + 0.01;
    // 슥 (가르기)
    const n0 = noise(c, t0, 0.6);
    const bp0 = c.createBiquadFilter(); bp0.type = 'bandpass'; bp0.frequency.setValueAtTime(900, t0); bp0.frequency.linearRampToValueAtTime(2500, t0 + 0.14); bp0.Q.value = 0.8;
    const g0 = env(c, t0, 0.22, 0.16, 0.03);
    n0.connect(bp0); bp0.connect(g0); g0.connect(master);
    // 촤라락: 점점 빨라지는 짧은 노이즈 틱들
    const rs = t0 + total * 0.34, re = t0 + total * 0.74;
    let t = rs, gap = 0.022;
    while (t < re) {
      const nn = noise(c, t, 0.9 + Math.random() * 0.4);
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600 + Math.random() * 1600; bp.Q.value = 1.4;
      const gg = env(c, t, 0.13 + Math.random() * 0.08, 0.018, 0.0008);
      nn.connect(bp); bp.connect(gg); gg.connect(master);
      t += gap; gap = Math.max(0.008, gap * 0.93);
    }
    // 톡톡 (패 가지런히)
    [0.8, 0.9].forEach((f, k) => {
      const tt = t0 + total * f;
      const nn = noise(c, tt, 1);
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1300 - k * 200; bp.Q.value = 1.2;
      const gg = env(c, tt, 0.45, 0.05);
      nn.connect(bp); bp.connect(gg); gg.connect(master);
    });
  }
  // 먹은 패를 쓸어 담는 '스윽' (steal=true: 더 짧고 높게)
  function swish(vol, steal) {
    const c = ready(); if (!c) return;
    vol = vol == null ? 1 : vol;
    const t = c.currentTime + 0.005, d = steal ? 0.22 : 0.34;
    const n = noise(c, t, steal ? 1.2 : 0.8);
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(steal ? 1400 : 700, t);
    bp.frequency.exponentialRampToValueAtTime(steal ? 5200 : 3400, t + d * 0.8);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.28 * vol, t + d * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    n.connect(bp); bp.connect(g); g.connect(master);
    // 끝에 살짝 '톡' (더미에 쌓임)
    const n2 = noise(c, t + d * 0.9, 1);
    const bp2 = c.createBiquadFilter(); bp2.type = 'bandpass'; bp2.frequency.value = 1800; bp2.Q.value = 1.3;
    const g2 = env(c, t + d * 0.9, 0.18 * vol, 0.035);
    n2.connect(bp2); bp2.connect(g2); g2.connect(master);
  }
  function beep(freq, dur) {
    const c = ready(); if (!c) return;
    try {
      const t = c.currentTime;
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = freq || 660; o.type = 'triangle';
      g.gain.setValueAtTime(0.08, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + (dur || 0.12));
      o.connect(g); g.connect(master); o.start(t); o.stop(t + (dur || 0.12));
    } catch (e) {}
  }
  function setMuted(m) { muted = !!m; try { localStorage.setItem(LSK, muted ? '1' : '0'); } catch (e) {} if (!muted) unlock(); }

  // ---------- 카드 날리기 (Web Animations API) ----------
  let layer = null;
  function getLayer() {
    if (!layer || !layer.isConnected) {
      layer = document.createElement('div');
      layer.id = 'fly-layer';
      document.body.appendChild(layer);
    }
    return layer;
  }
  const canAnimate = !!(Element.prototype.animate);
  // from/to: DOMRect 비슷한 {left,top,width,height}. html: 날아갈 카드 HTML. 반환: {cancel()}
  function fly(html, from, to, opts) {
    opts = opts || {};
    const L = getLayer();
    const w = to.width, h = to.height;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const el = wrap.firstElementChild;
    el.classList.add('flyer');
    el.style.width = w + 'px'; el.style.height = h + 'px';
    L.appendChild(el);
    const sx = from.left + from.width / 2 - w / 2, sy = from.top + from.height / 2 - h / 2;
    const ex = to.left, ey = to.top;
    const s0 = Math.max(0.3, Math.min(1.6, from.width / w));
    const rot0 = opts.rot0 != null ? opts.rot0 : -8, rot1 = opts.rot1 || 0;
    const end = opts.shrink ? ` scale(${opts.shrink})` : '';
    let finished = false, anim = null;
    const finish = (cancelled) => {
      if (finished) return; finished = true;
      if (!cancelled && opts.onLand) opts.onLand();
      // linger: 도착한 자리에 대상 카드가 없으면(바로 먹힌 경우) 잠깐 보였다가 사라짐
      if (!cancelled && opts.linger && canAnimate) {
        try {
          const a2 = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, delay: 160, fill: 'forwards' });
          a2.onfinish = () => el.remove();
          return;
        } catch (e) {}
      }
      el.remove();
    };
    if (!canAnimate) { setTimeout(() => finish(false), 0); return { cancel: () => finish(true) }; }
    el.style.transform = `translate(${sx}px,${sy}px) scale(${s0}) rotate(${rot0}deg)`;
    const kf = [
      { transform: `translate(${sx}px,${sy}px) scale(${s0}) rotate(${rot0}deg)`, opacity: 1 },
      { transform: `translate(${(sx + ex) / 2}px,${Math.min(sy, ey) - (opts.arc || 18)}px) scale(${opts.lift || 1.12}) rotate(${(rot0 + rot1) / 2}deg)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${ex}px,${ey}px) rotate(${rot1}deg)${end}`, opacity: opts.fade ? 0 : 1 },
    ];
    try {
      anim = el.animate(kf, { duration: opts.duration || 320, delay: opts.delay || 0, easing: 'cubic-bezier(.3,.7,.35,1)', fill: 'both' });
      anim.onfinish = () => finish(false);
    } catch (e) { setTimeout(() => finish(false), 0); }
    return { cancel: () => { try { anim && anim.cancel(); } catch (e) {} finish(true); } };
  }
  function clearLayer() { if (layer) layer.innerHTML = ''; }

  window.HwatuFX = { getLayer, tak, tick, shuffle, swish, beep, unlock, isMuted: () => muted, setMuted, fly, clearLayer, canAnimate };
})();
