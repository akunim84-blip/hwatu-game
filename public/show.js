/* 혁게임 연출 (SHOW_V1): 큰 도장(콜아웃) · 꽃가루/동전 · 선 정하기 · 승리/패배 배너 · 숫자 올라가기.
   전부 CSS/캔버스로 직접 그림 (외부 이미지·음원 없음). 화면 위 별도 레이어(#show-layer, 터치 통과)에서만 그려서
   게임 화면을 다시 그려도(render) 연출이 되풀이되지 않음. */
(function () {
  const FX = window.HwatuFX || {};
  const reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  let layer = null;
  function L() {
    if (!layer || !layer.isConnected) { layer = document.createElement('div'); layer.id = 'show-layer'; document.body.appendChild(layer); }
    return layer;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 큰 도장 (차례대로 하나씩) ----------
  const q = [];
  let busy = false, gen = 0, sgen = 0;
  // kind: good | bad | go | stop | gold | start. opts: {sub, say(음성 텍스트), dur}
  function stamp(text, kind, opts) {
    opts = opts || {};
    q.push({ text, kind: kind || 'good', sub: opts.sub || '', say: opts.say === undefined ? text : opts.say, dur: opts.dur, delay: opts.delay || 0 });
    if (q.length > 4) q.splice(0, q.length - 4); // 너무 밀리면 오래된 것 버림
    if (!busy) next();
  }
  function next() {
    const it = q.shift();
    if (!it) { busy = false; return; }
    busy = true;
    const my = gen;
    setTimeout(() => {
      if (my !== gen) return;
      const el = document.createElement('div');
      el.className = 'stamp s-' + it.kind;
      const len = [...it.text].length;
      el.innerHTML = `<div class="st-rays"></div><div class="st-txt${len > 4 ? ' long' : ''}${len > 6 ? ' xlong' : ''}">${esc(it.text)}</div>${it.sub ? `<div class="st-sub">${esc(it.sub)}</div>` : ''}`;
      L().appendChild(el);
      try { FX.stampSnd && FX.stampSnd(it.kind === 'bad' ? 'bad' : it.kind === 'go' ? 'go' : it.kind === 'stop' ? 'stop' : 'good', it.say); } catch (e) {}
      if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive) && (it.kind === 'go' || it.kind === 'stop' || it.kind === 'gold')) try { navigator.vibrate(40); } catch (e) {}
      const dur = it.dur || (q.length ? 800 : 1050);
      setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); if (my === gen) next(); }, dur);
    }, it.delay);
  }
  function clearSeon() { sgen++; if (layer) layer.querySelectorAll('.seon').forEach((e) => e.remove()); }
  const seonActive = () => !!(layer && layer.querySelector('.seon'));
  function clear() { gen++; sgen++; q.length = 0; busy = false; if (layer) layer.querySelectorAll('.stamp,.seon,.end-bn').forEach((e) => e.remove()); }

  // ---------- 꽃가루 / 동전 (캔버스 한 장, 1.9초) ----------
  function burst(kind) {
    const W = innerWidth, H = innerHeight;
    const cv = document.createElement('canvas');
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr; cv.className = 'burst';
    L().appendChild(cv);
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const N = reduced ? 18 : kind === 'lose' ? 26 : 70;
    const cols = ['#ffcf4a', '#ff6b6b', '#fff', '#7ee0a8', '#ffa94d', '#e8453c'];
    const P = [];
    for (let i = 0; i < N; i++) {
      if (kind === 'lose') P.push({ x: Math.random() * W, y: -20 - Math.random() * H * 0.4, vx: (Math.random() - 0.5) * 0.4, vy: 1 + Math.random() * 1.2, r: 3 + Math.random() * 3, rot: 0, vr: 0, c: 'rgba(170,200,230,.55)', t: 'drop' });
      else {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, sp = 6 + Math.random() * 7;
        const coin = Math.random() < 0.45;
        P.push({ x: W / 2, y: H * 0.42, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: coin ? 7 + Math.random() * 4 : 4 + Math.random() * 3, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: cols[i % cols.length], t: coin ? 'coin' : 'paper' });
      }
    }
    const t0 = performance.now(), DUR = kind === 'lose' ? 2200 : 1900;
    let clinks = 0;
    function frame(now) {
      const el = now - t0;
      g.clearRect(0, 0, W, H);
      const fade = el > DUR - 400 ? Math.max(0, (DUR - el) / 400) : 1;
      g.globalAlpha = fade;
      for (const p of P) {
        p.vy += kind === 'lose' ? 0.02 : 0.28; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        g.save(); g.translate(p.x, p.y); g.rotate(p.rot);
        if (p.t === 'coin') {
          const sx = Math.abs(Math.cos(p.rot * 2)) * 0.8 + 0.2;
          g.scale(sx, 1); g.beginPath(); g.arc(0, 0, p.r, 0, 6.283); g.fillStyle = '#f5b700'; g.fill();
          g.lineWidth = 2; g.strokeStyle = '#a86f00'; g.stroke();
          g.fillStyle = '#ffe58a'; g.fillRect(-p.r * 0.25, -p.r * 0.25, p.r * 0.5, p.r * 0.5); // 엽전 구멍 느낌
        } else if (p.t === 'drop') { g.beginPath(); g.ellipse(0, 0, p.r * 0.6, p.r, 0, 0, 6.283); g.fillStyle = p.c; g.fill(); }
        else { g.fillStyle = p.c; g.fillRect(-p.r, -p.r * 0.5, p.r * 2, p.r); }
        g.restore();
      }
      if (kind !== 'lose' && el > 350 && clinks < 6 && el > 350 + clinks * 120) { clinks++; try { FX.coin && FX.coin(0.8); } catch (e) {} }
      if (el < DUR) requestAnimationFrame(frame); else cv.remove();
    }
    requestAnimationFrame(frame);
  }

  // ---------- 선 정하기 (시작 연출) ----------
  // o: {rows:[{name, face(HTML), win}], note, title} — 뒷면 카드가 차례로 뒤집히고 선이 빛남. 끝나면 cb()
  function seon(o, cb) {
    const el = document.createElement('div');
    el.className = 'seon';
    const draw = o.rows && o.rows.length && o.rows[0].face;
    el.innerHTML = `<div class="seon-box"><div class="seon-t">${esc(o.title || '선 정하기')}</div>${draw ? `<div class="seon-row">${o.rows.map((r, i) => `<div class="seon-p${r.win ? ' win' : ''}" style="--i:${i}"><div class="seon-flip"><div class="card back seon-back"></div><div class="seon-face">${r.face}</div></div><div class="seon-nm">${esc(r.name)}</div><div class="seon-badge">선!</div></div>`).join('')}</div>` : ''}<div class="seon-note">${o.note || ''}</div></div>`;
    L().appendChild(el);
    const my = ++sgen;
    const flipAt = 450, step = 380, n = draw ? o.rows.length : 0;
    if (draw) for (let i = 0; i < n; i++) setTimeout(() => { if (my === sgen) { el.querySelectorAll('.seon-p')[i].classList.add('flip'); try { FX.tak && FX.tak(0.7); } catch (e) {} } }, flipAt + i * step);
    const decide = draw ? flipAt + n * step + 150 : 250;
    setTimeout(() => { if (my !== sgen) return; el.classList.add('decided'); if (draw) try { FX.say && FX.say('선', { pitch: 250 }); } catch (e) {} }, decide);
    const endAt = decide + (draw ? 900 : 700);
    setTimeout(() => {
      if (my !== sgen) return;
      el.classList.add('out'); setTimeout(() => el.remove(), 250);
      stamp('판 시작', 'start', { say: '시작', dur: 650 });
      setTimeout(() => { if (my === sgen && cb) cb(); }, 520);
    }, endAt);
    return endAt + 520;
  }

  // ---------- 승리/패배/나가리 배너 (결과 카드가 뜨기 직전 한 번) ----------
  function endBanner(kind, text, sub) {
    const el = document.createElement('div');
    el.className = 'end-bn ' + kind;
    el.innerHTML = `${kind === 'win' ? '<div class="st-rays"></div>' : ''}<div class="eb-t">${esc(text)}</div>${sub ? `<div class="eb-s">${esc(sub)}</div>` : ''}`;
    L().appendChild(el);
    if (kind === 'win') { burst('win'); try { FX.jingle && FX.jingle(true); FX.say && FX.say('승리', { delay: 0.35, pitch: 250 }); } catch (e) {} }
    else if (kind === 'lose') { burst('lose'); try { FX.jingle && FX.jingle(false); FX.say && FX.say('패배', { delay: 0.3, pitch: 190 }); } catch (e) {} }
    else { try { FX.stampSnd && FX.stampSnd('bad', '나가리'); } catch (e) {} }
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, 1500);
  }

  // ---------- 숫자 올라가기 (돈 정산) ----------
  function countUp(el, to, fmt, dur) {
    if (!el || reduced) return;
    const t0 = performance.now(); dur = dur || 900;
    let lastTick = 0;
    function f(now) {
      if (!el.isConnected) return;
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(Math.round(to * e));
      if (to > 0 && now - lastTick > 110 && k < 1) { lastTick = now; try { FX.coin && FX.coin(0.35); } catch (x) {} }
      if (k < 1) requestAnimationFrame(f);
    }
    el.textContent = fmt(0);
    requestAnimationFrame(f);
  }

  window.HwatuShow = { stamp, clear, clearSeon, seonActive, burst, seon, endBanner, countUp, layer: L, reduced };
})();
