/* 친구끼리 화투 - 클라이언트 (vanilla JS) — AI_V1: AI 상대 지원 */
(function () {
  const { HWATU, SEOTDA, MONTH_NAMES, typeLabel } = window.HwatuCards;
  const $app = document.getElementById('app');
  const LS = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
    del: (k) => { try { localStorage.removeItem(k); } catch (e) {} },
  };
  let pid = LS.get('hw_pid');
  if (!pid) { pid = 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36); LS.set('hw_pid', pid); }
  const params = new URLSearchParams(location.search);
  const urlRoom = (params.get('room') || '').toUpperCase();

  const MC = ['#999', '#2e7d32', '#c2185b', '#e0457b', '#37474f', '#5e35b1', '#ad1457', '#b71c1c', '#263238', '#d49b00', '#d84315', '#6d4c41', '#1565c0'];
  const FLOWER = ['★', '🌲', '🌺', '🌸', '🌿', '🪻', '🌹', '🍂', '🌕', '🌼', '🍁', '🌳', '☔'];
  const GWANG_IC = { 1: '🦢', 3: '🎏', 8: '🌕', 11: '🦚', 12: '☂️' };
  const YEOL_IC = { 2: '🐦', 4: '🐦', 5: '🌉', 6: '🦋', 7: '🐗', 8: '🪿', 9: '🍶', 10: '🦌', 12: '🐦' };
  const GAME_INFO = {
    seotda: { name: '섯다', desc: '2~5명' },
    matgo: { name: '맞고', desc: '2명' },
    gostop: { name: '고스톱', desc: '3명' },
  };

  let S = null; // 최신 서버 상태 {room, me, game}
  let ui = { modal: null, sel: null, lastSeq: -1, create: { game: 'seotda', perPoint: 100, bonus: true, level: LS.get('hw_ai_level') || 'normal', aiCount: 3 }, lastTurnMine: false };
  const socket = io({ transports: ['websocket', 'polling'] });

  // ---------- 유틸 ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n > 0 ? '+' : '') + Number(n).toLocaleString('ko-KR');
  const num = (n) => Number(n).toLocaleString('ko-KR');
  function toast(msg, big) {
    const t = document.createElement('div');
    t.className = 'toast' + (big ? ' big' : '');
    t.textContent = msg;
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => t.remove(), big ? 2600 : 2000);
  }
  const FX = window.HwatuFX;
  const beep = (f, d) => FX.beep(f, d);
  function emit(ev, data) {
    return new Promise((res) => socket.emit(ev, data, (r) => { if (r && !r.ok) toast(r.error || '오류'); res(r || {}); }));
  }

  // 카드 이미지: public/cards/cNN.png (Wikimedia Commons "Hwatu" 세트, CC BY-SA 4.0 — public/cards/LICENSE.txt)
  const imgOf = (hid) => `/cards/c${String(hid).padStart(2, '0')}.png`;
  function cardHTML(desc, cls, attrs, hid) {
    cls = cls || '';
    if (desc == null) return `<div class="card back ${cls}" ${attrs || ''}></div>`;
    const lb = typeLabel(desc);
    if (desc.bonus) return `<div class="card img bonus ${cls}" style="background-image:url(/cards/bonus.svg)" ${attrs || ''} title="보너스 쌍피"></div>`;
    const tag = desc.type === 'ssangpi' ? '<span class="tb">쌍피</span>' : '';
    return `<div class="card img t-${desc.type} ${cls}" style="background-image:url(${imgOf(hid)});--mc:${MC[desc.m]}" ${attrs || ''} title="${desc.m}월 ${lb}"><span class="mb">${desc.m}</span>${tag}</div>`;
  }
  (function preload() { for (let i = 0; i < 48; i++) { const im = new Image(); im.src = imgOf(i); } ['back.svg', 'bonus.svg'].forEach((f) => { const im = new Image(); im.src = '/cards/' + f; }); })();
  const hw = (id, cls, attrs) => cardHTML(id == null ? null : HWATU[id], cls, attrs, id);
  const sd = (id, cls, attrs) => cardHTML(id == null ? null : SEOTDA[id], cls, attrs, id == null ? null : (SEOTDA[id].m - 1) * 4 + (id % 2));

  // ---------- 소켓 ----------
  socket.on('connect', () => {
    const code = LS.get('hw_room');
    if (code && urlRoom && urlRoom !== code && !S) { LS.del('hw_room'); return; }
    if (code) {
      emit('joinRoom', { code, pid, name: LS.get('hw_name') || '' }).then((r) => {
        if (!r.ok) { LS.del('hw_room'); S = null; render(); }
      });
    }
  });
  socket.on('kicked', () => { LS.del('hw_room'); S = null; toast('방장이 방에서 내보냈습니다'); history.replaceState(null, '', '/'); render(); });
  socket.on('disconnect', () => toast('연결이 끊겼습니다. 다시 연결 중…'));
  socket.on('state', (st) => {
    const prev = S;
    const snap = snapshotRects();
    S = st;
    const r = st.room, g = st.game;
    const pg = prev && prev.room.code === r.code ? prev.game : null;
    const sameRoom = prev && prev.room.code === r.code;
    // 새 판(또는 섯다 재경기) → 패 돌리기 애니메이션
    const newDeal = !!(g && sameRoom && !g.result && (r.round !== prev.room.round || (g.kind === 'seotda' && pg && pg.kind === 'seotda' && g.redeals !== pg.redeals)));
    if (!g || (sameRoom && r.round !== prev.room.round)) ui.fitU = null;
    // 맞고/고스톱: 누군가 패를 냄 → 손→바닥 애니메이션 + '탁'
    const lp = g && g.kind !== 'seotda' ? g.lastPlay : null;
    const playKey = lp ? r.round + ':' + lp.seq : null;
    const newPlay = !!(lp && pg && pg.kind !== 'seotda' && prev.room.round === r.round && playKey !== ui.lastPlayKey);
    ui.lastPlayKey = playKey;
    const seotdaReveal = !!(g && g.kind === 'seotda' && g.result && pg && !pg.result && g.result.reveal && g.result.reveal.length);
    // 진행 상황이 바뀌면 진행 중인 애니메이션은 즉시 정리 (서버 상태가 항상 우선)
    if (!sameRoom || r.actSeq !== prev.room.actSeq || r.round !== prev.room.round) cancelAnim();
    if (g && r.actSeq !== ui.lastSeq) {
      if (ui.lastSeq !== -1 && !g.result) {
        (g.events || []).forEach((e) => {
          const big = /뻑|쪽|따닥|싹쓸이|폭탄|흔들기|고!|스톱|승리|나가리|재경기|땡|광/.test(e);
          toast(e, big);
        });
      }
      ui.lastSeq = r.actSeq;
    }
    const mine = isMyTurn();
    if (mine && !ui.lastTurnMine) { beep(880, 0.15); if (navigator.vibrate) try { navigator.vibrate(60); } catch (e) {} }
    ui.lastTurnMine = mine;
    if (g && g.phase !== 'play') ui.sel = null;
    if (ui.modal && ui.modal.type === 'choose' && !(g && g.phase === 'play' && mine)) ui.modal = null;
    render();
    try {
      if (newDeal) startDeal(g);
      else if (newPlay) { if (g.result) FX.tak(); else playAnim(g, lp, snap); }
      else if (seotdaReveal) FX.tak();
    } catch (e) { cancelAnim(); }
  });

  function isMyTurn() {
    if (!S || !S.game) return false;
    const g = S.game;
    return g.turn >= 0 && g.turn === g.mySeat && !g.result;
  }
  const isHost = () => S && S.room.hostId === S.me;
  const meP = () => S && S.room.players.find((p) => p.id === S.me);

  // ---------- 렌더 ----------
  function render() {
    const inGame = !!(S && S.game && S.room.status !== 'lobby');
    $app.classList.toggle('game', inGame);
    if (!inGame) { $app.style.removeProperty('--u'); document.documentElement.classList.remove('in-game'); }
    if (!S) return renderLanding();
    const r = S.room;
    if (r.status === 'lobby' || !S.game) return renderLobby();
    $app.dataset.kind = S.game.kind === 'seotda' ? 'seotda' : 'gostop';
    renderGame();
    document.documentElement.classList.add('in-game');
    fit();
    applyHidden();
  }

  // ---------- 한 화면 맞춤 (스크롤 없음) ----------
  // 카드 크기는 CSS 변수 --u(배율)로 계산. 뷰포트 기준 기본값에서 시작해 넘치면 줄임.
  // 같은 판 안에서는 배율을 키우지 않아(단조 감소) 차례마다 카드 크기가 출렁이지 않게 함.
  function overflowing() {
    const se = document.scrollingElement || document.documentElement;
    const vh = window.innerHeight, vw = window.innerWidth;
    return se.scrollHeight > vh || se.scrollWidth > vw || $app.scrollHeight > $app.clientHeight;
  }
  function fit() {
    if (!$app.classList.contains('game')) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const land = vw > vh * 1.3; // 가로 화면: 넓게 쓰는 레이아웃(CSS)
    let u = land ? Math.min(1, vh / 560) : Math.min(1.3, vw / 390, vh / 700);
    if (ui.fitU && ui.fitVW === vw && ui.fitVH === vh) u = Math.min(u, ui.fitU);
    const minU = land ? 0.36 : 0.42;
    u = Math.max(minU, u);
    $app.style.setProperty('--u', u.toFixed(3));
    for (let i = 0; i < 18 && u > minU && overflowing(); i++) {
      u = Math.max(minU, u * 0.94);
      $app.style.setProperty('--u', u.toFixed(3));
    }
    ui.fitU = u; ui.fitVW = vw; ui.fitVH = vh;
  }
  let fitTimer = null;
  const refit = () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => { if ($app.classList.contains('game') && (innerWidth !== ui.fitVW || innerHeight !== ui.fitVH)) { ui.fitU = null; cancelAnim(); render(); } }, 120); };
  window.addEventListener('resize', refit);
  window.addEventListener('orientationchange', refit);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', refit);

  // ---------- 애니메이션 (패 돌리기 / 패 내기) ----------
  const anim = { hidden: new Set(), flights: [], timers: [], ghost: null };
  const rectOf = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; };
  const centered = (box, w, h) => ({ left: box.left + box.width / 2 - w / 2, top: box.top + box.height / 2 - h / 2, width: w, height: h });
  function applyHidden() { anim.hidden.forEach((sel) => document.querySelectorAll(sel).forEach((e) => e.classList.add('fx-hide'))); }
  function hideSel(sel) { anim.hidden.add(sel); applyHidden(); }
  function showSel(sel) { anim.hidden.delete(sel); document.querySelectorAll(sel).forEach((e) => e.classList.remove('fx-hide')); }
  function cancelAnim() {
    anim.timers.forEach(clearTimeout); anim.timers = [];
    anim.flights.forEach((f) => f.cancel()); anim.flights = [];
    anim.hidden.clear();
    document.querySelectorAll('.fx-hide').forEach((e) => e.classList.remove('fx-hide'));
    if (anim.ghost) { anim.ghost.remove(); anim.ghost = null; }
    FX.clearLayer();
  }
  const later = (ms, fn) => { anim.timers.push(setTimeout(fn, ms)); };
  function cardSize(sel) { const e = document.querySelector(sel); return e ? rectOf(e) : null; }
  function snapshotRects() {
    const s = { hand: {}, floorM: {}, deck: null, floor: null };
    if (!S || !S.game || S.game.kind === 'seotda') return s;
    document.querySelectorAll('.hand [data-hand]').forEach((e) => { s.hand[e.dataset.hand] = rectOf(e); });
    document.querySelectorAll('.floor [data-floor]').forEach((e) => { const m = HWATU[Number(e.dataset.floor)].m; s.floorM[m] = rectOf(e); });
    const d = document.querySelector('.deck .card'); if (d) s.deck = rectOf(d);
    const f = document.querySelector('.floor'); if (f) s.floor = rectOf(f);
    return s;
  }
  function seatBoxRect(g, seat) {
    if (seat === g.mySeat) { const h = document.querySelector('.hand') || document.querySelector('.sd-me'); return h ? rectOf(h) : null; }
    const e = document.querySelector(`[data-seat="${seat}"]`); return e ? rectOf(e) : null;
  }

  function startDeal(g) {
    cancelAnim();
    if (!FX.canAnimate) return;
    const steps = []; // {sel|null, to: rect, html}
    const back = '<div class="card back"></div>';
    let from;
    if (g.kind === 'seotda') {
      const c = document.querySelector('.sd-center'); if (!c) return;
      const ref = cardSize('.sd-seat .card') || cardSize('.sd-me .card') || { width: 34, height: 55 };
      from = centered(rectOf(c), ref.width * 1.1, ref.height * 1.1);
      const seats = g.seats.map((s, i) => i).filter((i) => !g.seats[i].folded && g.seats[i].cards.length);
      const n = g.seats.length, start = g.mySeat >= 0 ? g.mySeat + 1 : 0;
      seats.sort((a, b) => ((a - start + n) % n) - ((b - start + n) % n));
      for (let k = 0; k < 2; k++) for (const i of seats) {
        const sel = i === g.mySeat ? `.sd-me .cards .card:nth-child(${k + 1})` : `.sd-seat[data-seat="${i}"] .cards .card:nth-child(${k + 1})`;
        const el = document.querySelector(sel); if (!el) continue;
        steps.push({ sel, to: rectOf(el), html: back });
      }
      if (g.mySeat >= 0) steps.push({ sel: '.sd-me .hn', to: null, html: null, reveal: true }); // 내 족보 이름은 패가 다 온 뒤에
      // 가운데 더미(뒷면) 표시
      anim.ghost = document.createElement('div');
      anim.ghost.className = 'card back deal-deck';
      Object.assign(anim.ghost.style, { left: from.left + 'px', top: from.top + 'px', width: from.width + 'px', height: from.height + 'px' });
      document.body.appendChild(anim.ghost);
    } else {
      const d = document.querySelector('.deck .card'); if (!d) return;
      from = rectOf(d);
      const n = g.players.length, me = g.mySeat;
      const myIds = [...document.querySelectorAll('.hand [data-hand]')].map((e) => e.dataset.hand);
      const floorIds = [...document.querySelectorAll('.floor [data-floor]')].map((e) => e.dataset.floor);
      const oppCard = cardSize('.opp .card') || { width: 24, height: 40 };
      const rounds = Math.max(myIds.length, ...g.players.map((p) => p.handCount));
      let fi = 0;
      const order = []; for (let k = 0; k < n; k++) order.push((g.turn + k + n) % n);
      for (let r = 0; r < rounds; r++) {
        for (const i of order) {
          if (i === me) {
            if (r < myIds.length) { const sel = `.hand [data-hand="${myIds[r]}"]`; const el = document.querySelector(sel); if (el) steps.push({ sel, to: rectOf(el), html: back }); }
          } else if (r < g.players[i].handCount) {
            const b = seatBoxRect(g, i); if (b) steps.push({ sel: null, to: centered(b, oppCard.width * 1.2, oppCard.height * 1.2), html: back, opp: true });
          }
        }
        while (fi < floorIds.length && fi < Math.ceil((floorIds.length * (r + 1)) / rounds)) {
          const sel = `.floor [data-floor="${floorIds[fi]}"]`; const el = document.querySelector(sel);
          if (el) steps.push({ sel, to: rectOf(el), html: back });
          fi++;
        }
      }
    }
    steps.forEach((st) => { if (st.sel) hideSel(st.sel); });
    const reveals = steps.filter((st) => st.reveal);
    for (let k = steps.length - 1; k >= 0; k--) if (steps[k].reveal) steps.splice(k, 1);
    if (!steps.length) { cancelAnim(); return; }
    const N = steps.length;
    const gap = Math.max(45, Math.min(300, 1900 / N));
    const dur = 300;
    steps.forEach((st, k) => {
      later(k * gap, () => {
        const f = FX.fly(st.html, from, st.to, {
          duration: dur, rot0: -10 + Math.random() * 6, arc: 10, lift: 1.05, fade: !!st.opp, shrink: st.opp ? 0.7 : 0,
          onLand: () => { FX.tick(); if (st.sel) showSel(st.sel); },
        });
        anim.flights.push(f);
      });
    });
    later((N - 1) * gap + dur + 60, () => { reveals.forEach((st) => showSel(st.sel)); if (anim.ghost) { anim.ghost.remove(); anim.ghost = null; } anim.flights = []; anim.timers = []; });
  }

  function floorDest(id, snap) {
    const sel = `.floor [data-floor="${id}"]`;
    const el = document.querySelector(sel);
    if (el) return { sel, rect: rectOf(el) };
    const ref = cardSize('.floor .card') || { width: 50, height: 82 };
    const m = HWATU[id].m;
    const same = [...document.querySelectorAll('.floor [data-floor]')].filter((e) => HWATU[Number(e.dataset.floor)].m === m);
    let r = same.length ? rectOf(same[same.length - 1]) : snap.floorM[m];
    if (r) return { sel: null, rect: { left: r.left + ref.width * 0.35, top: r.top, width: ref.width, height: ref.height } };
    const fl = document.querySelector('.floor');
    const box = fl ? rectOf(fl) : snap.floor;
    return { sel: null, rect: box ? centered(box, ref.width, ref.height) : { left: innerWidth / 2 - 25, top: innerHeight / 2 - 41, width: 50, height: 82 } };
  }
  function playAnim(g, lp, snap) {
    cancelAnim();
    if (!FX.canAnimate) { if (lp.card != null) FX.tak(); if (lp.flip != null) setTimeout(() => FX.tak(), 250); return; }
    let t = 0;
    if (lp.card != null) {
      let from = lp.seat === g.mySeat ? snap.hand[lp.card] : null;
      const ref = cardSize('.floor .card') || { width: 50, height: 82 };
      if (!from) { const b = seatBoxRect(g, lp.seat); from = b ? centered(b, ref.width * 0.6, ref.height * 0.6) : null; }
      let dest;
      if (lp.bonus) { const b = seatBoxRect(g, lp.seat); dest = { sel: null, rect: b ? centered(b, ref.width, ref.height) : null }; }
      else dest = floorDest(lp.card, snap);
      if (from && dest.rect) {
        if (dest.sel) hideSel(dest.sel);
        anim.flights.push(FX.fly(hw(lp.card), from, dest.rect, {
          duration: 280, rot0: lp.seat === g.mySeat ? 0 : -12, rot1: 0, arc: 26, lift: 1.15, linger: !dest.sel,
          onLand: () => { FX.tak(); if (dest.sel) showSel(dest.sel); },
        }));
        t = 420;
      } else FX.tak();
    }
    if (lp.flip != null) {
      const dd = floorDest(lp.flip, snap);
      const deckEl = document.querySelector('.deck .card');
      const from = deckEl ? rectOf(deckEl) : snap.deck;
      if (dd.sel) hideSel(dd.sel);
      later(t, () => {
        if (!from) { FX.tak(); if (dd.sel) showSel(dd.sel); return; }
        anim.flights.push(FX.fly(hw(lp.flip), from, dd.rect, {
          duration: 260, rot0: -6, arc: 16, lift: 1.1, linger: !dd.sel,
          onLand: () => { FX.tak(0.85); if (dd.sel) showSel(dd.sel); },
        }));
      });
    }
  }

  function renderLanding() {
    const name = LS.get('hw_name') || '';
    const c = ui.create;
    const joinBox = urlRoom
      ? `<div class="panel"><h3>🎉 초대받은 방: <span style="color:#ffcf4a">${esc(urlRoom)}</span></h3><button class="btn-primary" style="width:100%" data-act="joinUrl">이 방에 입장하기</button></div>`
      : '';
    $app.innerHTML = `<div class="pad" style="position:relative">${muteBtn('snd-float')}
      <h1 class="title">🎴 친구끼리 화투</h1>
      <p class="subtitle">섯다 · 맞고 · 고스톱 — 단톡방 친구들과 실시간으로!</p>
      <div class="panel"><h3>닉네임</h3><input id="nick" maxlength="12" placeholder="닉네임 입력" value="${esc(name)}"></div>
      ${joinBox}
      <div class="panel"><h3>방 만들기</h3>
        <div class="game-pick">${Object.entries(GAME_INFO).map(([k, v]) => `<button data-game="${k}" class="${c.game === k ? 'sel' : ''}">${v.name}<small>${v.desc}</small></button>`).join('')}</div>
        <div class="muted">${c.game === 'seotda' ? '기본 판돈 (칩)' : '점당 칩'}</div>
        <div class="chips-pick">${[10, 50, 100, 500].map((v) => `<button data-pp="${v}" class="${c.perPoint === v ? 'sel' : ''}">${v}칩</button>`).join('')}</div>
        <input id="pp" type="number" inputmode="numeric" min="1" max="10000" value="${c.perPoint}">
        ${c.game !== 'seotda' ? `<label class="chk"><input type="checkbox" id="bonus" ${c.bonus ? 'checked' : ''}> 보너스 쌍피 2장 포함</label>` : ''}
        <button class="btn-primary" style="width:100%;margin-top:10px" data-act="create">방 만들기 (친구 초대)</button>
      </div>
      <div class="panel ai-panel"><h3>🤖 AI와 바로 하기 <small class="muted">혼자서 ${GAME_INFO[c.game].name} 연습</small></h3>
        <div class="muted">난이도</div>
        <div class="chips-pick">${[['easy', '쉬움'], ['normal', '보통']].map(([k, v]) => `<button data-lv="${k}" class="${c.level === k ? 'sel' : ''}">${v}</button>`).join('')}</div>
        ${c.game === 'seotda' ? `<div class="muted">AI 인원</div><div class="chips-pick">${[1, 2, 3, 4].map((v) => `<button data-aic="${v}" class="${c.aiCount === v ? 'sel' : ''}">${v}명</button>`).join('')}</div>` : `<div class="muted">AI ${c.game === 'matgo' ? '1명' : '2명'}과 대결</div>`}
        <button class="btn-blue" style="width:100%;margin-top:8px;font-size:16px" data-act="solo">🤖 ${GAME_INFO[c.game].name} AI와 바로 하기</button>
      </div>
      <div class="panel"><h3>코드로 참여</h3>
        <div class="row"><input id="code" maxlength="5" placeholder="방 코드 5자리" style="text-transform:uppercase" value="${esc(urlRoom)}"><button class="btn-blue" style="flex:0 0 90px" data-act="join">참여</button></div>
      </div>
      <p class="notice">※ 이 게임은 <b>가상 칩(포인트)</b>만 사용하는 무료 친구 게임입니다.<br>실제 돈·현금·경품과 교환되지 않으며 결제 기능이 없습니다.<br><span style="opacity:.7">카드 그림: Wikimedia Commons “Hwatu” 세트 (Spenĉjo, Louie Mantia Jr. 원작 기반), <a href="/cards/LICENSE.txt" style="color:#ffcf4a">CC BY-SA 4.0</a></span></p>
    </div>`;
  }

  function getName() {
    const n = (document.getElementById('nick') || {}).value;
    const name = (n || '').trim();
    if (!name) { toast('닉네임을 입력하세요'); return null; }
    LS.set('hw_name', name);
    return name;
  }
  async function joinCode(code) {
    const name = getName(); if (!name) return;
    code = (code || '').toUpperCase().trim();
    if (code.length < 4) return toast('방 코드를 입력하세요');
    const r = await emit('joinRoom', { code, pid, name });
    if (r.ok) { LS.set('hw_room', r.code); history.replaceState(null, '', '/?room=' + r.code); }
  }

  function playersList() {
    const r = S.room;
    return `<ul class="plist">${r.players.map((p) => `<li class="${p.ai ? 'ai' : ''}"><div>${esc(p.name)}${p.ai ? `<span class="tag ai">AI·${p.level === 'easy' ? '쉬움' : '보통'}</span>` : ''}${p.id === r.hostId ? '<span class="tag">방장</span>' : ''}${p.id === S.me ? '<span class="tag" style="background:#4ae0ff">나</span>' : ''}${!p.connected ? '<span class="tag off">연결끊김</span>' : ''}${isHost() && p.id !== S.me && r.status !== 'playing' ? `<button class="btn-ghost" style="padding:4px 8px;font-size:11px;margin-left:6px" data-kick="${esc(p.id)}" ${p.ai ? 'data-ai="1"' : ''}>${p.ai ? '빼기' : '내보내기'}</button>` : ''}</div><div class="chip ${p.chips < 0 ? 'neg' : ''}">${num(p.chips)}칩</div></li>`).join('')}</ul>`;
  }

  function renderLobby() {
    const r = S.room;
    const n = r.players.length;
    const enough = r.game === 'seotda' ? n >= r.min : n === r.min;
    const need = r.game === 'seotda' ? `${r.min}~${r.max}명` : `${r.min}명`;
    $app.innerHTML = `${header()}<div class="pad">
      <div class="panel" style="text-align:center">
        <div class="muted">${esc(r.gameName)} · ${r.game === 'seotda' ? '기본 판돈' : '점당'} ${num(r.perPoint)}칩${r.game !== 'seotda' ? (r.bonus ? ' · 보너스패 O' : ' · 보너스패 X') : ''}</div>
        <div class="code-big">${esc(r.code)}</div>
        <div class="muted">방 코드</div>
        <button class="btn-kakao" style="width:100%;margin-top:10px;font-size:16px" data-act="share">💬 카톡으로 공유 (초대 링크)</button>
      </div>
      <div class="panel"><h3>참가자 (${n}/${r.max}) · 필요 인원 ${need}</h3>${playersList()}
        ${isHost() && n < r.max ? `<div class="row ai-add"><button class="btn-blue" data-act="addAI">🤖 AI 추가</button><div class="chips-pick" style="flex:0 0 auto;margin:0">${[['easy', '쉬움'], ['normal', '보통']].map(([k, v]) => `<button data-lv="${k}" class="${ui.create.level === k ? 'sel' : ''}">${v}</button>`).join('')}</div></div>` : ''}
        ${isHost() && n < r.max ? '<div class="muted" style="margin-top:6px">빈 자리는 AI로 채울 수 있어요. 친구가 들어오면 AI가 자리를 비켜줍니다.</div>' : ''}</div>
      <div class="stack">
        ${isHost() ? `<button class="btn-primary" style="padding:16px;font-size:18px" data-act="start" ${enough ? '' : 'disabled'}>${enough ? '게임 시작' : `인원 부족 (${need} 필요)`}</button>` : '<div class="panel" style="text-align:center">방장이 게임을 시작하길 기다리는 중…</div>'}
        <div class="row"><button class="btn-ghost" data-act="rules">📖 규칙</button><button class="btn-ghost" data-act="board">🏆 점수판</button></div>
        <button class="btn-ghost" data-act="leave">방 나가기</button>
      </div>
      <p class="notice">가상 칩 전용 · 실제 돈과 무관합니다. 시작 칩 ${num(r.startChips)}개</p>
    </div>${modalHTML()}`;
  }

  const muteBtn = (cls) => `<button class="btn-ghost snd ${cls || ''}" data-act="mute" aria-label="소리 켜기/끄기" title="소리 켜기/끄기">${FX.isMuted() ? '🔇' : '🔊'}</button>`;
  function header() {
    const r = S.room;
    const g = S.game;
    let extra = '';
    if (g && g.kind !== 'seotda' && g.mult > 1) extra = ` · x${g.mult}`;
    return `<div class="hdr"><div class="t">🎴 ${esc(r.gameName)} · ${esc(r.code)}${r.round ? ` · ${r.round}판` : ''}${extra}</div>${muteBtn()}<button class="btn-ghost" data-act="rules">규칙</button><button class="btn-ghost" data-act="board">점수판</button></div>`;
  }

  function renderGame() {
    const g = S.game;
    let body = g.kind === 'seotda' ? seotdaHTML(g) : gostopHTML(g);
    $app.innerHTML = header() + body + resultHTML() + modalHTML();
  }

  // ---------- 섯다 ----------
  function seotdaHTML(g) {
    const me = g.mySeat;
    const chipsOf = (id) => { const p = S.room.players.find((x) => x.id === id); return p ? p.chips : 0; };
    const others = g.seats.map((s, i) => ({ s, i })).filter((x) => x.i !== me);
    const seatBox = ({ s, i }) => `<div data-seat="${i}" class="sd-seat ${g.turn === i ? 'turn' : ''} ${s.folded ? 'fold' : ''}">
        <div style="font-weight:800">${esc(s.name)}${s.folded ? ' (다이)' : ''}</div>
        <div class="muted">${num(chipsOf(s.id) - (g.result ? 0 : s.contrib))}칩 · 베팅 ${num(s.contrib)}</div>
        <div class="cards">${s.cards.map((c) => sd(c, 'sm' + (c != null ? '' : ''))).join('')}</div>
        <div class="hn">${s.handName ? esc(s.handName) : g.turn === i ? '고민 중…' : ''}</div></div>`;
    let meBox = '';
    if (me >= 0) {
      const s = g.seats[me];
      meBox = `<div class="sd-me ${g.turn === me ? '' : ''}">
        <div class="muted">${esc(s.name)} (나) · 보유 ${num(chipsOf(s.id) - (g.result ? 0 : s.contrib))}칩 · 베팅 ${num(s.contrib)}${s.folded ? ' · 다이' : ''}</div>
        <div class="cards">${s.cards.map((c) => sd(c, 'lg')).join('')}</div>
        <div class="hn">${esc(s.handName || '')}</div></div>`;
    } else meBox = '<div class="sd-me">관전 중 — 다음 판부터 참여합니다</div>';
    let bar = '';
    if (me >= 0 && !g.result) {
      if (g.options.length) {
        const cls = { die: 'btn-ghost', check: 'btn-blue', bbing: 'btn-blue', call: 'btn-primary', half: 'btn-red', ddadang: 'btn-red' };
        bar = `<div class="turnbar">내 차례! 베팅하세요</div><div class="actbar">${g.options.map((o) => `<button class="${cls[o.type]}" data-bet="${o.type}">${o.label}${o.amount ? `<small>${num(o.amount)}</small>` : ''}</button>`).join('')}</div>`;
      } else {
        const t = g.seats[g.turn];
        bar = `<div class="turnbar wait">${t ? esc(t.name) + '님 차례' : ''}</div><div class="actbar idle"><button class="btn-ghost" disabled>기다리는 중…<small>&nbsp;</small></button></div>`;
      }
    }
    return `<div class="sd-seats">${others.map(seatBox).join('')}</div>
      <div class="sd-center"><div class="muted">판돈</div><div class="pot">💰 ${num(g.pot)}칩</div><div class="muted">현재 베팅 ${num(g.currentBet)} · 기본 ${num(g.ante)}${g.redeals ? ` · 재경기 ${g.redeals}회` : ''}</div></div>
      ${meBox}<div class="bar">${bar}</div>`;
  }

  // ---------- 맞고/고스톱 ----------
  function groupCaptured(ids) {
    const groups = { gwang: [], yeol: [], tti: [], pi: [] };
    ids.forEach((id) => { const c = HWATU[id]; (c.type === 'pi' || c.type === 'ssangpi' ? groups.pi : groups[c.type]).push(id); });
    const piVal = groups.pi.reduce((s, id) => s + HWATU[id].piValue, 0);
    return [['광', groups.gwang, groups.gwang.length], ['열', groups.yeol, groups.yeol.length], ['띠', groups.tti, groups.tti.length], ['피', groups.pi, piVal]]
      .filter((x) => x[1].length)
      .map(([lb, arr, cnt]) => `<div class="capg">${arr.map((id) => hw(id, 'sm')).join('')}<span class="cnt">${cnt}</span></div>`).join('');
  }
  function gostopHTML(g) {
    const me = g.mySeat;
    const chipsOf = (id) => { const p = S.room.players.find((x) => x.id === id); return p ? p.chips : 0; };
    const opps = g.players.map((p, i) => ({ p, i })).filter((x) => x.i !== me);
    const oppHTML = opps.map(({ p, i }) => `<div data-seat="${i}" class="opp ${g.turn === i ? 'turn' : ''}">
      <div class="nm"><span>${esc(p.name)}</span><span style="color:#ffcf4a">${p.score}점</span></div>
      <div class="meta">🂠 ${p.handCount}장 · ${num(chipsOf(p.id))}칩${p.go ? ` · <b style="color:#ff8a80">${p.go}고</b>` : ''}${p.shakes ? ` · 흔듦${p.shakes}` : ''}${p.ppeok ? ` · 뻑${p.ppeok}` : ''}</div>
      <div class="caps">${groupCaptured(p.captured)}</div></div>`).join('');
    // floor grouped by month
    const byM = {};
    g.floor.forEach((id) => { const m = HWATU[id].m; (byM[m] = byM[m] || []).push(id); });
    const o = g.options;
    let selMonth = null, selMatches = [];
    if (ui.sel != null && o && o.phase === 'play') {
      const oc = o.cards.find((c) => c.id === ui.sel);
      if (oc) { selMonth = HWATU[oc.id].m; selMatches = oc.matches || []; } else ui.sel = null;
    }
    const pendingChoices = g.pending ? g.pending.choices : [];
    const floorHTML = Object.keys(byM).map((m) => `<div class="fgrp">${byM[m].map((id) => hw(id, (selMatches.includes(id) || (me === g.turn && pendingChoices.includes(id)) ? 'hl' : '') + (id === g.lastFlip ? ' new' : ''), `data-floor="${id}"`)).join('')}</div>`).join('');
    let mineHTML = '', handHTML = '', bar = '';
    const idleBar = '<div class="actbar idle"><button class="btn-ghost" disabled>기다리는 중…<small>&nbsp;</small></button></div>';
    if (me >= 0) {
      const p = g.players[me];
      mineHTML = `<div class="mine"><div class="nm"><span>${esc(p.name)} (나) · ${num(chipsOf(p.id))}칩${p.go ? ` · <b style="color:#ff8a80">${p.go}고</b>` : ''}${p.shakes ? ` · 흔듦${p.shakes}` : ''}${p.bombFlips ? ` · 폭탄패 ${p.bombFlips}` : ''}</span><span style="color:#ffcf4a">${p.score}점 / ${g.target}점</span></div><div class="caps">${groupCaptured(p.captured) || '<span class="muted">아직 먹은 패 없음</span>'}</div></div>`;
      const playable = o && o.phase === 'play';
      const sorted = (p.hand || []).slice().sort((a, b) => (HWATU[a].m || 13) - (HWATU[b].m || 13) || a - b);
      handHTML = `<div class="hand">${sorted.map((id) => {
        const oc = playable ? o.cards.find((c) => c.id === id) : null;
        const cls = (ui.sel === id ? 'sel' : '') + (oc && oc.matches && oc.matches.length ? ' hl' : '') + (!playable ? ' dim' : '');
        return hw(id, cls, `data-hand="${id}"`);
      }).join('')}</div>`;
      if (!g.result) {
        if (playable) {
          const oc = ui.sel != null ? o.cards.find((c) => c.id === ui.sel) : null;
          bar = `<div class="turnbar">${oc ? (oc.bonus ? '보너스 쌍피를 냅니다' : oc.bomb ? `폭탄! ${HWATU[oc.id].m}월 3장을 한번에` : oc.matches.length ? `${HWATU[oc.id].m}월 — 바닥 ${oc.matches.length}장과 맞음` : `${HWATU[oc.id].m}월 — 맞는 패 없음 (바닥에 놓기)`) : '내 차례! 낼 패를 누르세요'}</div>
            <div class="actbar">${o.canFlipOnly ? '<button class="btn-blue" data-act="flipOnly">뒤집기만<small>폭탄패 사용</small></button>' : ''}<button class="btn-primary" data-act="playSel" ${oc ? '' : 'disabled'}>${oc ? '이 패 내기' : '패를 고르세요'}</button></div>`;
        } else if (o && o.phase === 'chooseFlip') {
          bar = `<div class="turnbar">뒤집은 패 ${HWATU[o.card].m}월 — 바닥에서 먹을 패를 고르세요</div>${idleBar}`;
        } else if (g.turn >= 0) {
          bar = `<div class="turnbar wait">${esc(g.players[g.turn].name)}님 차례${g.phase === 'goStop' ? ' (고/스톱 고민 중)' : ''}</div>${idleBar}`;
        }
      }
    }
    return `<div class="opps">${oppHTML}</div>
      <div class="floor-wrap">
        <div class="deck">${g.deckCount ? hw(null, 'sm') : '<div class="card sm empty"></div>'}<span>남은 패<br><b>${g.deckCount}</b>장</span>${g.lastFlip != null ? `<span class="lf">뒤집은 패</span>${hw(g.lastFlip, 'sm lfc')}` : ''}</div>
        <div class="floor">${floorHTML || '<span class="muted">바닥이 비었습니다</span>'}</div></div>
      ${mineHTML}${handHTML}<div class="bar">${bar}</div>`;
  }

  // ---------- 결과 ----------
  function resultHTML() {
    const g = S.game, r = S.room;
    if (!g || !g.result || r.status !== 'result') return '';
    const res = g.result;
    const myDelta = res.chipDelta[S.me];
    let body = '';
    if (res.game === 'seotda') {
      body = `<div class="res-lines">${res.reason ? esc(res.reason) + '<br>' : ''}${res.reveal.map((x) => `<div style="display:flex;align-items:center;gap:8px;margin:4px 0">${x.cards.map((c) => sd(c, 'sm')).join('')}<b>${esc(x.name)}</b> ${esc(x.hand)}${res.winners.includes(x.id) ? ' 👑' : ''}</div>`).join('')}<div>판돈 ${num(res.pot)}칩</div></div>`;
    } else if (res.nagari) {
      body = `<div class="res-lines">${res.lines.map(esc).join('<br>')}</div>`;
    } else {
      body = `<div class="res-lines"><b>${res.points}점</b> × 점당 ${num(res.perPoint)}칩<br>${res.lines.map(esc).join('<br>')}${res.losers.map((l) => `<br>· ${esc(l.name)}: ${l.tags.length ? esc(l.tags.join(', ')) + ' ' : ''}x${l.mult} → ${num(l.amount)}칩`).join('')}</div>`;
    }
    const deltas = Object.entries(res.chipDelta).map(([id, d]) => {
      const p = r.players.find((x) => x.id === id);
      return `<div class="delta"><span>${esc(p ? p.name : '?')}</span><span class="chip ${d < 0 ? 'neg' : ''}">${fmt(d)} → ${num(p ? p.chips : 0)}칩</span></div>`;
    }).join('');
    const title = res.nagari ? '😮 나가리' : res.winners.includes(S.me) ? '🎉 승리!' : `${esc(res.winnerNames.join(', '))} 승리`;
    return `<div class="modal-bg"><div class="modal"><h2>${title}</h2>
      ${myDelta != null ? `<div style="text-align:center;font-size:20px;font-weight:900" class="chip ${myDelta < 0 ? 'neg' : ''}">내 칩 ${fmt(myDelta)}</div>` : ''}
      ${body}${deltas}
      <div class="btns">${isHost() ? '<button class="btn-primary" data-act="next">다음 판</button><button class="btn-ghost" data-act="toLobby">대기실로</button>' : '<div class="muted" style="text-align:center;width:100%">방장이 다음 판을 시작하길 기다리는 중…</div>'}</div>
      <div class="btns"><button class="btn-ghost" data-act="board">🏆 점수판</button></div>
      <p class="notice" style="margin:8px 0 0">가상 칩 결과이며 실제 돈과 무관합니다.</p></div></div>`;
  }

  // ---------- 모달 ----------
  function modalHTML() {
    const g = S && S.game;
    // 서버 주도 모달
    if (g && !g.result && g.options) {
      if (g.options.phase === 'goStop') {
        const p = g.players[g.mySeat];
        return `<div class="modal-bg"><div class="modal"><h2>${p.score}점 달성!</h2>
          <p style="text-align:center">고 하면 점수 +1 (3고부터 2배), 상대가 먼저 나면 <b>고박</b>!</p>
          <div class="res-lines">${p.scoreLines.map((l) => `${esc(l.label)} ${l.pts}점`).join('<br>')}</div>
          <div class="btns"><button class="btn-red big-go" data-gs="go">고! (${p.go + 1}고)</button><button class="btn-blue big-go" data-gs="stop">스톱</button></div></div></div>`;
      }
      if (g.options.phase === 'chooseFlip') {
        return `<div class="modal-bg"><div class="modal"><h2>먹을 패 선택</h2><p style="text-align:center">뒤집은 패: ${HWATU[g.options.card].m}월</p>
          <div class="cards">${hw(g.options.card, 'lg')}</div><div class="cards">${g.options.choices.map((id) => hw(id, 'lg', `data-flipc="${id}"`)).join('')}</div>
          <p class="muted" style="text-align:center">가져갈 카드를 누르세요</p></div></div>`;
      }
    }
    if (!ui.modal) return '';
    const m = ui.modal;
    if (m.type === 'choose') {
      return `<div class="modal-bg"><div class="modal"><h2>어느 패를 먹을까요?</h2>
        <div class="cards">${hw(m.card, 'lg')}</div><div class="cards">${m.choices.map((id) => hw(id, 'lg', `data-choose="${id}"`)).join('')}</div>
        <div class="btns"><button class="btn-ghost" data-act="close">취소</button></div></div></div>`;
    }
    if (m.type === 'shake') {
      return `<div class="modal-bg"><div class="modal"><h2>흔들까요?</h2><p style="text-align:center">같은 달 3장을 들고 있습니다. 흔들면 이기면 점수 2배!</p>
        <div class="btns"><button class="btn-red" data-shake="1">흔들기</button><button class="btn-ghost" data-shake="0">그냥 내기</button></div></div></div>`;
    }
    if (m.type === 'rules') return rulesModal();
    if (m.type === 'board') return boardModal();
    return '';
  }

  function boardModal() {
    const r = S.room;
    const ps = r.players.slice().sort((a, b) => b.chips - a.chips);
    return `<div class="modal-bg" data-act="close"><div class="modal" data-stop="1"><h2>🏆 점수판 (가상 칩)</h2>
      <table class="sb"><tr><th>#</th><th>이름</th><th>승</th><th>칩</th><th>증감</th></tr>
      ${ps.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>${p.wins}</td><td class="chip ${p.chips < 0 ? 'neg' : ''}">${num(p.chips)}</td><td>${fmt(p.chips - r.startChips)}</td></tr>`).join('')}</table>
      <h4 style="margin:14px 0 6px">최근 판</h4>
      <div class="muted">${r.history.length ? r.history.slice().reverse().map((h) => `${h.round}판: ${esc(h.summary)}`).join('<br>') : '아직 기록이 없습니다'}</div>
      <div class="btns">${isHost() && r.status !== 'playing' ? '<button class="btn-red" data-act="reset">칩 초기화</button>' : ''}<button class="btn-ghost" data-act="close">닫기</button></div>
      <p class="notice" style="margin:8px 0 0">칩은 게임 내 가상 포인트이며 현금 가치가 없습니다.</p></div></div>`;
  }

  function rulesModal() {
    const game = S ? S.room.game : 'seotda';
    let html = '';
    if (game === 'seotda') html = `<h4>진행</h4><ul><li>1~10월 20장, 각자 2장씩 받습니다.</li><li>기본 판돈을 모두 내고 시작, 선 다음 사람부터 베팅.</li><li><b>체크</b>: 베팅 없이 넘김 · <b>삥</b>: 기본 판돈만큼 베팅 · <b>콜</b>: 앞 사람만큼 맞춤 · <b>하프</b>: 판돈 절반만큼 올림 · <b>따당</b>: 앞 베팅의 2배 · <b>다이</b>: 포기</li><li>모두 맞추면 패를 공개해 가장 높은 족보가 판돈을 가져갑니다. (동점은 나눠 가짐)</li></ul>
      <h4>족보 (높은 순)</h4><ul><li><b>38광땡</b> &gt; <b>18광땡 · 13광땡</b></li><li><b>장땡</b>(10땡) &gt; 9땡 … &gt; 1땡</li><li><b>알리</b>(1·2) &gt; <b>독사</b>(1·4) &gt; <b>구삥</b>(1·9) &gt; <b>장삥</b>(1·10) &gt; <b>장사</b>(10·4) &gt; <b>세륙</b>(4·6)</li><li><b>갑오</b>(9끗) &gt; 8끗 … &gt; 1끗 &gt; <b>망통</b>(0끗)</li></ul>
      <h4>특수 족보</h4><ul><li><b>암행어사</b>(4·7 열끗): 13·18광땡을 잡음, 아니면 1끗</li><li><b>땡잡이</b>(3광·7열끗): 1~9땡을 잡음, 아니면 망통</li><li><b>구사</b>(4·9): 최고 패가 알리 이하면 재경기</li><li><b>멍텅구리구사</b>(4·9 열끗): 최고 패가 9땡 이하면 재경기</li><li>재경기: 판돈은 그대로, 남은 사람끼리 다시 패를 받습니다.</li></ul>`;
    else html = `<h4>진행</h4><ul><li>${game === 'matgo' ? '맞고(2인): 10장씩, 바닥 8장, 7점 나면 고/스톱' : '고스톱(3인): 7장씩, 바닥 6장, 3점 나면 고/스톱'}</li><li>내 차례: 손패 1장을 내서 바닥의 같은 달 패를 먹고, 더미에서 1장 뒤집어 또 맞추면 먹습니다.</li><li>바닥에 같은 달이 2장이면 하나를 골라 먹습니다.</li></ul>
      <h4>특수 상황</h4><ul><li><b>뻑</b>: 낸 패로 먹었는데 뒤집은 패도 같은 달 → 3장이 바닥에 쌓임. 나중에 먹으면 4장 + 피 1장씩 뺏기. 3뻑이면 즉시 승리.</li><li><b>쪽</b>: 맞는 패 없이 낸 패를 뒤집은 패로 먹음 → 피 1장씩 뺏기</li><li><b>따닥</b>: 바닥 2장 중 하나를 먹고, 뒤집은 패도 같은 달 → 4장 모두 + 피 1장씩</li><li><b>싹쓸이</b>: 바닥을 모두 쓸어감 → 피 1장씩</li><li><b>흔들기</b>: 같은 달 3장을 들고 낼 때 선언 → 이기면 2배</li><li><b>폭탄</b>: 같은 달 3장 + 바닥 1장 → 한번에 4장 + 피 1장씩, 2배, 이후 뒤집기만 하는 차례 2번</li><li><b>보너스 쌍피</b>: 손에서 내면 바로 먹고 한 장 더 받음, 뒤집으면 바로 먹고 한 장 더 뒤집음</li></ul>
      <h4>점수</h4><ul><li>광: 3광 3점 (비광 포함 2점), 4광 4점, 5광 15점</li><li>열끗 5장 1점, 이후 1장당 +1 · 고도리(2·4·8월 새) 5점</li><li>띠 5장 1점, 이후 +1 · 홍단·청단·초단 각 3점</li><li>피 10장 1점, 이후 +1 (쌍피는 2장으로 계산). 9월 열끗은 열끗으로만 계산.</li></ul>
      <h4>고/스톱 · 박</h4><ul><li>1고 +1점, 2고 +2점, 3고부터 2배씩</li><li><b>광박</b>: 광으로 났는데 상대 광 0장 → 2배</li><li><b>피박</b>: 피로 났는데 상대 피 5장 이하 → 2배</li><li><b>고박</b>: 고 한 사람이 역전당하면 ${game === 'matgo' ? '2배' : '혼자 모두 물어줌'}</li><li><b>나가리</b>: 아무도 못 나면 다음 판 2배 (최대 8배)</li><li>칩 정산: 점수 × 점당 칩 × 배수, 진 사람이 이긴 사람에게 (가상 칩)</li></ul>`;
    return `<div class="modal-bg" data-act="close"><div class="modal rules" data-stop="1"><h2>📖 ${esc(S ? S.room.gameName : '')} 규칙</h2>${html}<p class="notice">모든 칩은 가상 포인트입니다.</p><div class="btns"><button class="btn-ghost" data-act="close">닫기</button></div></div></div>`;
  }

  // ---------- 공유 ----------
  async function share() {
    const r = S.room;
    const url = location.origin + '/?room=' + r.code;
    const text = `🎴 ${r.gameName} 한 판 하자! 방 코드 ${r.code} (가상 칩 게임)`;
    if (navigator.share) {
      try { await navigator.share({ title: '친구끼리 화투', text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const full = text + '\n' + url;
    try { await navigator.clipboard.writeText(full); toast('초대 링크 복사됨! 카톡방에 붙여넣기 하세요'); return; } catch (e) {}
    const ta = document.createElement('textarea');
    ta.value = full; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let okc = false; try { okc = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    if (okc) toast('초대 링크 복사됨! 카톡방에 붙여넣기 하세요'); else window.prompt('아래 링크를 복사해서 카톡방에 보내세요', url);
  }

  // ---------- 입력 ----------
  function sendPlay(card, floorCard, shake) {
    ui.sel = null; ui.modal = null;
    emit('action', { type: 'play', card, floorCard, shake });
  }
  function tryPlay(id) {
    const o = S.game.options;
    if (!o || o.phase !== 'play') return;
    const oc = o.cards.find((c) => c.id === id);
    if (!oc) return;
    if (oc.canShake) { ui.modal = { type: 'shake', card: id }; return render(); }
    if (oc.needChoice) { ui.modal = { type: 'choose', card: id, choices: oc.matches }; return render(); }
    sendPlay(id, oc.matches && oc.matches[0]);
  }

  $app.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-lv],[data-aic],[data-kick],[data-act],[data-game],[data-pp],[data-hand],[data-choose],[data-shake],[data-flipc],[data-gs],[data-bet],[data-floor],[data-stop]');
    if (!t) return;
    const d = t.dataset;
    if (d.stop) return;
    if (d.lv) { ui.create.level = d.lv; LS.set('hw_ai_level', d.lv); const n = document.getElementById('nick'); if (n) LS.set('hw_name', n.value.trim()); return render(); }
    if (d.aic) { ui.create.aiCount = Number(d.aic); const n = document.getElementById('nick'); if (n) LS.set('hw_name', n.value.trim()); return render(); }
    if (d.game) { ui.create.game = d.game; const n = document.getElementById('nick'); if (n) LS.set('hw_name', n.value.trim()); return renderLanding(); }
    if (d.pp) { ui.create.perPoint = Number(d.pp); const n = document.getElementById('nick'); if (n) LS.set('hw_name', n.value.trim()); return renderLanding(); }
    if (d.hand != null) {
      const id = Number(d.hand);
      if (!isMyTurn() || !S.game.options || S.game.options.phase !== 'play') return;
      if (ui.sel === id) return tryPlay(id);
      ui.sel = id; FX.tick(); return render();
    }
    if (d.floor != null) {
      const id = Number(d.floor);
      const o = S.game && S.game.options;
      if (o && o.phase === 'chooseFlip' && o.choices.includes(id)) return emit('action', { type: 'chooseFlip', floorCard: id });
      if (ui.sel != null && o && o.phase === 'play') {
        const oc = o.cards.find((c) => c.id === ui.sel);
        if (oc && oc.matches && oc.matches.includes(id)) { if (oc.canShake) return tryPlay(ui.sel); return sendPlay(ui.sel, id); }
      }
      return;
    }
    if (d.choose != null) return sendPlay(ui.modal.card, Number(d.choose), false);
    if (d.shake != null) {
      const card = ui.modal.card; const oc = S.game.options.cards.find((c) => c.id === card);
      if (oc && oc.needChoice) { ui.modal = { type: 'choose', card, choices: oc.matches }; return render(); }
      return sendPlay(card, oc && oc.matches && oc.matches[0], d.shake === '1');
    }
    if (d.flipc != null) return emit('action', { type: 'chooseFlip', floorCard: Number(d.flipc) });
    if (d.kick) { if (d.ai || confirm('이 참가자를 내보낼까요?')) emit('kick', { pid: d.kick }); return; }
    if (d.gs) return emit('action', { type: d.gs });
    if (d.bet) { beep(600, 0.06); return emit('action', { type: d.bet }); }
    switch (d.act) {
      case 'create': {
        const name = getName(); if (!name) return;
        const pp = Number(document.getElementById('pp').value) || ui.create.perPoint;
        const bonusEl = document.getElementById('bonus');
        const r = await emit('createRoom', { game: ui.create.game, perPoint: pp, bonus: bonusEl ? bonusEl.checked : true, pid, name });
        if (r.ok) { LS.set('hw_room', r.code); history.replaceState(null, '', '/?room=' + r.code); }
        return;
      }
      case 'solo': {
        const name = getName(); if (!name) return;
        const pp = Number(document.getElementById('pp').value) || ui.create.perPoint;
        const bonusEl = document.getElementById('bonus');
        const c = ui.create;
        const r = await emit('createRoom', { game: c.game, perPoint: pp, bonus: bonusEl ? bonusEl.checked : true, pid, name, ai: true, level: c.level, aiCount: c.aiCount });
        if (r.ok) { LS.set('hw_room', r.code); history.replaceState(null, '', '/?room=' + r.code); }
        return;
      }
      case 'addAI': return emit('addAI', { level: ui.create.level });
      case 'join': return joinCode(document.getElementById('code').value);
      case 'joinUrl': return joinCode(urlRoom);
      case 'share': return share();
      case 'start': return emit('start');
      case 'next': return emit('start');
      case 'toLobby': return emit('toLobby');
      case 'reset': if (confirm('모든 참가자의 칩을 초기화할까요?')) { await emit('resetChips'); toast('칩을 초기화했습니다'); } return;
      case 'rules': ui.modal = { type: 'rules' }; return render();
      case 'board': ui.modal = { type: 'board' }; return render();
      case 'close': ui.modal = null; return render();
      case 'mute': FX.setMuted(!FX.isMuted()); if (!FX.isMuted()) FX.tak(0.7); return render();
      case 'playSel': if (ui.sel != null) tryPlay(ui.sel); return;
      case 'flipOnly': ui.sel = null; return emit('action', { type: 'flipOnly' });
      case 'leave':
        if (!confirm('방에서 나갈까요?')) return;
        await emit('leave'); LS.del('hw_room'); S = null; history.replaceState(null, '', '/'); return render();
    }
  });

  render();
})();
