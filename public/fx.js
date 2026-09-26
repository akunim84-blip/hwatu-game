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
  function done() { EVS.forEach((e) => document.removeEventListener(e, unlock, true)); setTimeout(() => { try { bgmApply(); loadVoices(); } catch (e) {} }, 0); }
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

  // ================= 연출 사운드 (SHOW_V1) — 전부 Web Audio로 직접 합성 (외부 음원 파일 없음) =================
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function osc(c, type, f, t, dur, peak, dest, att) {
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t);
    const g = env(c, t, peak, dur, att || 0.004);
    o.connect(g); g.connect(dest || master); o.start(t); o.stop(t + dur + 0.02);
    return o;
  }
  // ---- 장구 비슷한 타악: 쿵(북편) · 덕(채편) · 덩(둘 다) ----
  function kung(c, t, vol, dest) {
    const o = c.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(128, t); o.frequency.exponentialRampToValueAtTime(58, t + 0.18);
    const g = env(c, t, 0.9 * vol, 0.32, 0.003); o.connect(g); g.connect(dest); o.start(t); o.stop(t + 0.35);
    const n = noise(c, t, 0.5); const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
    const g2 = env(c, t, 0.35 * vol, 0.08); n.connect(lp); lp.connect(g2); g2.connect(dest);
  }
  function deok(c, t, vol, dest) {
    const n = noise(c, t, 1.1); const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2300; bp.Q.value = 2.2;
    const g = env(c, t, 0.9 * vol, 0.07, 0.001); n.connect(bp); bp.connect(g); g.connect(dest);
    osc(c, 'triangle', 520, t, 0.05, 0.25 * vol, dest, 0.001);
  }
  // ---- 가야금 비슷한 뜯는 소리 (살짝 높게 시작해 제음으로 — 농현 느낌) ----
  function pluck(c, t, midi, dur, vol, dest) {
    const f = mtof(midi);
    [['triangle', 1, 1], ['sine', 2, 0.35], ['sine', 3, 0.12]].forEach(([ty, mul, a]) => {
      const o = c.createOscillator(); o.type = ty;
      o.frequency.setValueAtTime(f * mul * 1.012, t); o.frequency.exponentialRampToValueAtTime(f * mul, t + 0.06);
      if (dur > 0.5 && mul === 1) { // 긴 음은 떨어 주기(농현)
        const lfo = c.createOscillator(), lg = c.createGain(); lfo.frequency.value = 5.2; lg.gain.setValueAtTime(0, t); lg.gain.linearRampToValueAtTime(f * 0.012, t + dur * 0.6);
        lfo.connect(lg); lg.connect(o.frequency); lfo.start(t); lfo.stop(t + dur + 0.05);
      }
      const g = env(c, t, vol * a, Math.min(1.6, dur + 0.25), 0.003); o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + 0.3);
    });
  }
  function jing(c, t, vol, dest) { // 징: 느리게 사라지는 금속 울림
    [[196, 1], [293, 0.5], [392, 0.25], [587, 0.12]].forEach(([f, a]) => osc(c, 'sine', f, t, 2.2, vol * a, dest, 0.02));
  }

  // ---- 배경음악: 5음 음계 + 장구 장단, 대기실/게임 두 곡 (반복) ----
  const SCALE = [55, 57, 59, 62, 64, 67, 69, 71, 74, 76, 79]; // G A B D E (G장조 5음 음계)
  const TRACKS = {
    // 대기실: 느긋한 세마치 느낌
    lobby: { step: 0.3, vol: 0.55, drums: ['K', '', '', '', '', '', 't', '', '', 'T', '', ''],
      bass: [0, 3, 0, 4, 5, 3, 1, 0],
      mel: [[[0, 5, 6], [6, 7, 6]], [[0, 6, 3], [3, 5, 3], [6, 4, 6]], [[0, 3, 6], [6, 4, 3], [9, 5, 3]], [[0, 4, 12]],
        [[0, 7, 6], [6, 8, 6]], [[0, 7, 3], [3, 6, 3], [6, 5, 6]], [[0, 4, 3], [3, 5, 3], [6, 3, 3], [9, 2, 3]], [[0, 3, 9], [9, 2, 3]]] },
    // 게임: 경쾌한 굿거리 느낌
    game: { step: 0.215, vol: 0.62, drums: ['D', '', 't', 'T', '', 'K', '', 'T', '', 'K', 't', 'T'], jing: 4,
      bass: [0, 3, 0, 4, 3, 1, 4, 0],
      mel: [[[0, 5, 3], [3, 6, 2], [5, 7, 1], [6, 8, 3], [9, 7, 3]], [[0, 6, 3], [3, 5, 3], [6, 4, 3], [9, 5, 3]],
        [[0, 7, 3], [3, 8, 2], [5, 9, 1], [6, 8, 3], [9, 7, 3]], [[0, 6, 6], [6, 5, 3], [9, 4, 3]],
        [[0, 3, 3], [3, 4, 2], [5, 5, 1], [6, 6, 3], [9, 5, 3]], [[0, 4, 3], [3, 3, 3], [6, 2, 3], [9, 3, 3]],
        [[0, 4, 3], [3, 5, 3], [6, 6, 2], [8, 7, 1], [9, 6, 3]], [[0, 5, 9]]] },
  };
  const BGK = 'hw_bgm';
  let bgmOn = true;
  try { bgmOn = localStorage.getItem(BGK) !== '0'; } catch (e) {}
  const bgm = { want: null, cur: null, bus: null, duck: null, timer: null, next: 0, pos: 0 };
  const BGM_VOL = 0.13;
  function bgmBus(c) {
    if (!bgm.bus) {
      bgm.bus = c.createGain(); bgm.bus.gain.value = 0;
      bgm.duck = c.createGain(); bgm.duck.gain.value = 1;
      bgm.bus.connect(bgm.duck); bgm.duck.connect(master);
    }
    return bgm.bus;
  }
  function bgmTick() {
    const c = ctx;
    if (!c || c.state !== 'running' || !bgm.cur || document.hidden) return;
    const T = TRACKS[bgm.cur], bus = bgmBus(c), stepsPerBar = 12, total = T.mel.length * stepsPerBar;
    if (bgm.next < c.currentTime) bgm.next = c.currentTime + 0.05;
    while (bgm.next < c.currentTime + 0.35) {
      const t = bgm.next, p = bgm.pos % total, bar = Math.floor(p / stepsPerBar), st = p % stepsPerBar;
      const d = T.drums[st];
      if (d === 'D' || d === 'K') kung(c, t, d === 'D' ? 0.8 : 0.6, bus);
      if (d === 'D' || d === 'T') deok(c, t, 0.45, bus);
      if (d === 't') deok(c, t, 0.18, bus);
      if (T.jing && st === 0 && bar % T.jing === 0) jing(c, t, 0.1, bus);
      if (st === 0 || st === 6) { const r = SCALE[T.bass[bar]] - 12; osc(c, 'sine', mtof(r), t, T.step * 5.5, 0.22, bus, 0.03); }
      for (const [s0, deg, len] of T.mel[bar]) if (s0 === st && deg >= 0) pluck(c, t, SCALE[deg], len * T.step, 0.32 * T.vol / 0.6, bus);
      bgm.pos++; bgm.next += T.step;
    }
  }
  function bgmApply() {
    const c = ctx;
    const play = bgmOn && !muted && bgm.want && c && c.state === 'running';
    if (!c) return;
    const bus = bgmBus(c), t = c.currentTime;
    if (play && bgm.cur !== bgm.want) { bgm.cur = bgm.want; bgm.pos = 0; bgm.next = t + 0.1; }
    bus.gain.cancelScheduledValues(t); bus.gain.setValueAtTime(bus.gain.value, t);
    bus.gain.linearRampToValueAtTime(play ? BGM_VOL : 0, t + (play ? 1.2 : 0.3));
    if (play && !bgm.timer) bgm.timer = setInterval(bgmTick, 90);
    if (!play && bgm.timer) { const tm = bgm.timer; bgm.timer = null; setTimeout(() => { if (!bgm.timer) { clearInterval(tm); bgm.cur = null; } else clearInterval(tm); }, 350); }
  }
  // track: 'lobby' | 'game' | null — 첫 터치(오디오 잠금 해제) 전에는 예약만
  function music(track) { if (bgm.want === track && (bgm.timer || !bgmOn || muted)) return; bgm.want = track; bgmApply(); }
  function setBgm(on) { bgmOn = !!on; try { localStorage.setItem(BGK, bgmOn ? '1' : '0'); } catch (e) {} if (bgmOn) unlock(); bgmApply(); }
  function duck(sec) {
    if (!ctx || !bgm.duck) return;
    const g = bgm.duck.gain, t = ctx.currentTime;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(0.22, t + 0.06);
    g.setValueAtTime(0.22, t + (sec || 1.3)); g.linearRampToValueAtTime(1, t + (sec || 1.3) + 0.6);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(bgmApply, 50); });

  // ---- 목소리 비슷한 외침 (한글을 자모로 쪼개 모음 포먼트 + 자음 소리로 합성 — 녹음·TTS 아님) ----
  const V_F = [[800, 1250], [750, 1750], [700, 1300], [620, 1800], [550, 1000], [520, 1800], [600, 1100], [480, 1900], [450, 800], [700, 1150], [650, 1500], [450, 1700], [480, 900], [350, 800], [500, 1000], [400, 1700], [350, 1900], [350, 800], [380, 1400], [350, 1500], [300, 2300]];
  // 초성: 0 ㄱ 1 ㄲ 2 ㄴ 3 ㄷ 4 ㄸ 5 ㄹ 6 ㅁ 7 ㅂ 8 ㅃ 9 ㅅ 10 ㅆ 11 ㅇ 12 ㅈ 13 ㅉ 14 ㅊ 15 ㅋ 16 ㅌ 17 ㅍ 18 ㅎ
  const CHO = ['p', 'P', 'n', 'p', 'P', 'n', 'n', 'p', 'P', 's', 'S', '', 'c', 'C', 'c', 'p', 'p', 'p', 'h'];
  const DIG = { 0: '영', 1: '일', 2: '이', 3: '삼', 4: '사', 5: '오', 6: '육', 7: '칠', 8: '팔', 9: '구' };
  function voice(text, opts) {
    const c = ready(); if (!c) return 0;
    opts = opts || {};
    const syl = [];
    for (const ch of String(text).replace(/[0-9]/g, (d) => DIG[d])) {
      const k = ch.charCodeAt(0) - 0xac00;
      if (k < 0 || k > 11171) continue;
      syl.push({ cho: Math.floor(k / 588), jung: Math.floor((k % 588) / 28), jong: k % 28 });
    }
    if (!syl.length) return 0;
    const out = c.createGain(); out.gain.value = opts.vol || 0.5; out.connect(master);
    let t = c.currentTime + (opts.delay || 0.02);
    const base = opts.pitch || 230, n = syl.length, sd = Math.max(0.12, Math.min(0.2, 0.62 / n));
    syl.forEach((s, i) => {
      const last = i === n - 1, dur = last ? sd * 1.7 : sd;
      const cons = CHO[s.cho];
      if (cons) { // 자음: 짧은 소음(파열·마찰)
        const hard = cons === cons.toUpperCase() && cons !== 'h';
        const cd = cons.toLowerCase() === 's' ? 0.07 : cons === 'n' ? 0.03 : 0.025;
        if (cons !== 'n') {
          const nz = noise(c, t, 1); const f = c.createBiquadFilter(); f.type = cons.toLowerCase() === 's' ? 'highpass' : 'bandpass';
          f.frequency.value = cons.toLowerCase() === 's' ? 4200 : cons === 'h' ? 1500 : 2600; f.Q.value = 1;
          const g = env(c, t, hard ? 0.8 : 0.5, cd, 0.002); nz.connect(f); f.connect(g); g.connect(out);
        }
        t += cd * (hard ? 1.3 : 0.8);
      }
      // 모음: 톱니파 → 포먼트 2개 (억양: 외침은 올랐다 내려옴, opts.rise면 끝을 올림)
      const [f1, f2] = V_F[s.jung] || V_F[0];
      const o = c.createOscillator(); o.type = 'sawtooth';
      const p0 = base * (1 + 0.1 * (n - i) / n), p1 = last ? (opts.rise ? p0 * 1.35 : p0 * 0.72) : p0 * 0.97;
      o.frequency.setValueAtTime(p0, t); o.frequency.exponentialRampToValueAtTime(p1, t + dur);
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.9, t + 0.02);
      const closed = s.jong === 1 || s.jong === 7 || s.jong === 17 || s.jong === 19; // ㄱ ㄷ ㅂ ㅅ 받침: 뚝 끊김
      g.gain.setValueAtTime(0.9, t + dur * (closed ? 0.55 : 0.7)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur * (closed ? 0.65 : 1));
      [[f1, 6, 1], [f2, 8, 0.55]].forEach(([f, q, a]) => {
        const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
        const ga = c.createGain(); ga.gain.value = a * 2.2; o.connect(bp); bp.connect(ga); ga.connect(g);
      });
      g.connect(out); o.start(t); o.stop(t + dur + 0.05);
      t += dur * (closed ? 0.8 : 1);
    });
    return t - c.currentTime;
  }

  // ---- 사람 목소리 외침 (VOICE_V1): /voice/<key>.webm|mp3 (manifest.json). 첫 터치 뒤 미리 받아 두고, 없으면 합성음으로 대신 ----
  // 직접 녹음으로 바꾸려면 public/voice/<key>.mp3 (+ .webm)를 같은 이름으로 덮어쓰면 됨 (key 목록: manifest.json)
  const VOICE_KEY = { '고': 'go', '스톱': 'stop', '뻑': 'ppeok', '뻑먹기': 'ppeok_eat', '삼뻑': 'ppeok3', '3뻑': 'ppeok3', '따닥': 'ttadak', '쪽': 'jjok', '싹쓸이': 'sseul', '쓸': 'sseul',
    '흔들기': 'shake', '폭탄': 'bomb', '고도리': 'godori', '홍단': 'hongdan', '청단': 'cheongdan', '초단': 'chodan', '삼광': 'gwang3', '비삼광': 'bigwang3', '사광': 'gwang4', '오광': 'gwang5',
    '광박': 'gwangbak', '피박': 'pibak', '고박': 'gobak', '나가리': 'nagari', '선': 'seon', '시작': 'start', '판시작': 'start', '승리': 'win', '패배': 'lose',
    '38광땡': 'sd_38', '18광땡': 'sd_18', '13광땡': 'sd_13', '장땡': 'sd_jang', '암행어사': 'sd_amhaeng', '땡잡이': 'sd_ddaengjabi', '멍텅구리구사': 'sd_mgusa', '구사': 'sd_gusa',
    '알리': 'sd_ali', '독사': 'sd_doksa', '구삥': 'sd_gubbing', '장삥': 'sd_jangbbing', '장사': 'sd_jangsa', '세륙': 'sd_seryuk', '갑오': 'sd_gabo', '망통': 'sd_mangtong' };
  function voiceKey(t) {
    t = String(t || '').replace(/[\s!.~]/g, '');
    if (VOICE_KEY[t]) return VOICE_KEY[t];
    let m = /^(\d+)고$/.exec(t); if (m) return +m[1] >= 1 && +m[1] <= 5 ? 'go' + m[1] : 'go';
    m = /^([1-9])땡$/.exec(t); if (m) return 'sd_d' + m[1];
    m = /^([1-8])끗$/.exec(t); if (m) return 'sd_k' + m[1];
    return null;
  }
  const vclip = { man: null, buf: {}, started: false, failed: 0 };
  function decodeAB(c, ab) { return new Promise((res) => { try { const p = c.decodeAudioData(ab, res, () => res(null)); if (p && p.catch) p.catch(() => res(null)); } catch (e) { res(null); } }); }
  async function loadVoices() {
    if (vclip.started || !ctx || !window.fetch) return;
    vclip.started = true;
    try { const r = await fetch('/voice/manifest.json'); if (!r.ok) throw 0; vclip.man = await r.json(); } catch (e) { vclip.man = null; return; }
    let webm = false;
    try { webm = document.createElement('audio').canPlayType('audio/webm; codecs=opus') !== ''; } catch (e) {}
    const keys = Object.keys(vclip.man.clips || {});
    let i = 0;
    const worker = async () => {
      while (i < keys.length) {
        const k = keys[i++];
        for (const ext of webm ? ['webm', 'mp3'] : ['mp3']) {
          try { const r = await fetch('/voice/' + k + '.' + ext); if (!r.ok) continue; const b = await decodeAB(ctx, await r.arrayBuffer()); if (b) { vclip.buf[k] = b; break; } } catch (e) {}
        }
        if (!vclip.buf[k]) vclip.failed++;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }
  function playClip(key, delay, vol) {
    const c = ready(); if (!c || !key) return false;
    const b = vclip.buf[key]; if (!b) return false;
    try {
      const s = c.createBufferSource(); s.buffer = b;
      const g = c.createGain(); g.gain.value = vol || 0.9;
      s.connect(g); g.connect(master); s.start(c.currentTime + (delay || 0));
      duck(b.duration + 0.5);
      return true;
    } catch (e) { return false; }
  }
  // 외침: 녹음(클립)이 있으면 사람 목소리, 아직 못 받았거나 실패하면 예전 합성음
  function say(text, opts) {
    opts = opts || {};
    if (playClip(voiceKey(text), opts.delay, opts.vol)) return 'clip';
    voice(text, opts); return 'synth';
  }
  // 도장 찍힐 때: 좋은 일(황금 금관 + 북) / 나쁜 일(축 처지는 소리) / 고(올라감) / 스톱(쾅쾅)
  function stampSnd(kind, text) {
    const c = ready(); if (!c) return;
    const t = c.currentTime + 0.01;
    duck(1.6);
    const bus = c.createGain(); bus.gain.value = 0.55; bus.connect(master);
    kung(c, t, 1, bus);
    if (kind === 'bad') {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(330, t); o.frequency.exponentialRampToValueAtTime(110, t + 0.6);
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(1800, t); lp.frequency.exponentialRampToValueAtTime(300, t + 0.6);
      const g = env(c, t, 0.35, 0.7, 0.01); o.connect(lp); lp.connect(g); g.connect(bus); o.start(t); o.stop(t + 0.75);
    } else {
      const root = kind === 'go' ? 62 : kind === 'stop' ? 55 : 67;
      [0, 4, 7, 12].forEach((iv, k) => {
        [-6, 6].forEach((dt) => {
          const o = c.createOscillator(); o.type = 'sawtooth'; o.detune.value = dt;
          const tt = t + (kind === 'go' ? k * 0.05 : 0);
          o.frequency.setValueAtTime(mtof(root + iv), tt);
          if (kind === 'go') o.frequency.exponentialRampToValueAtTime(mtof(root + iv + 5), tt + 0.35);
          const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(600, tt); lp.frequency.linearRampToValueAtTime(3200, tt + 0.08); lp.frequency.exponentialRampToValueAtTime(900, tt + 0.5);
          const g = env(c, tt, 0.07, 0.55, 0.012); o.connect(lp); lp.connect(g); g.connect(bus); o.start(tt); o.stop(tt + 0.6);
        });
      });
      const n = noise(c, t, 0.7); const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5000;
      const g = env(c, t, 0.25, 0.14); n.connect(hp); hp.connect(g); g.connect(bus);
      if (kind === 'stop') kung(c, t + 0.16, 1, bus);
    }
    if (text) say(text, { delay: 0.12, rise: kind === 'go', pitch: kind === 'bad' ? 190 : 240 });
  }
  function coin(vol) { // 동전 짤랑
    const c = ready(); if (!c) return;
    const t = c.currentTime + 0.005, f = 1800 + Math.random() * 500;
    osc(c, 'sine', f, t, 0.18, 0.12 * (vol || 1)); osc(c, 'sine', f * 1.5, t + 0.03, 0.22, 0.08 * (vol || 1));
  }
  function jingle(win) {
    const c = ready(); if (!c) return;
    duck(2.4);
    const t = c.currentTime + 0.02, bus = c.createGain(); bus.gain.value = 0.6; bus.connect(master);
    const seq = win ? [62, 64, 67, 69, 71, 74, 79] : [71, 69, 67, 64, 62];
    seq.forEach((m, k) => pluck(c, t + k * (win ? 0.09 : 0.2), m, win ? 0.5 : 0.7, win ? 0.4 : 0.3, bus));
    if (win) { kung(c, t, 1, bus); deok(c, t + 0.27, 0.6, bus); kung(c, t + 0.54, 1, bus); jing(c, t + 0.62, 0.35, bus); }
    else jing(c, t + 0.9, 0.12, bus);
  }
  function rub() { // 패 조일 때 스치는 소리
    const c = ready(); if (!c) return;
    const t = c.currentTime + 0.005, n = noise(c, t, 0.5);
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 0.7;
    const g = env(c, t, 0.08, 0.12, 0.03); n.connect(bp); bp.connect(g); g.connect(master);
  }

  function setMuted(m) { muted = !!m; try { localStorage.setItem(LSK, muted ? '1' : '0'); } catch (e) {} if (!muted) unlock(); bgmApply(); }

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

  window.HwatuFX = { getLayer, tak, tick, shuffle, swish, beep, unlock, isMuted: () => muted, setMuted, fly, clearLayer, canAnimate,
    music, setBgm, isBgmOn: () => bgmOn, duck, voice, say, voiceKey, stampSnd, coin, jingle, rub,
    _voice: () => ({ loaded: Object.keys(vclip.buf).length, total: vclip.man ? Object.keys(vclip.man.clips || {}).length : 0, failed: vclip.failed }),
    _bgm: () => ({ want: bgm.want, cur: bgm.cur, playing: !!bgm.timer, ctx: ctx ? ctx.state : null }) };
})();
