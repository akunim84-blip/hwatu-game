/* 친구끼리 화투 - 클라이언트 (vanilla JS) — AI_V1: AI 상대 지원 · MATGO_V2: 셔플/한 장씩 돌리기 + 족보 힌트 · CAPTURE_V1: 먹기/피 뺏기 애니메이션 · ROOMS_V1: 진행 중인 방 목록/관전/AI 자리 넘겨받기 · WON_V1: 가상 머니(원)·계정(닉네임+PIN)·순위 · RESULT_V2: 판 끝 결과 화면(마지막 판 잠깐 보여준 뒤 크게, '확인' 전까지 유지) · MATCH_V2: 같은 달 짝 강조 · INVITE_V2: 초대 링크 바로 입장 + 이름만으로 입장(기기 기억, PIN 선택) */
(function () {
  const { HWATU, SEOTDA, MONTH_NAMES, typeLabel } = window.HwatuCards;
  const H = window.HwatuHints;
  const $app = document.getElementById('app');
  const LS = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
    del: (k) => { try { localStorage.removeItem(k); } catch (e) {} },
  };
  let pid = LS.get('hw_pid');
  if (!pid) { pid = 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36); LS.set('hw_pid', pid); }
  const params = new URLSearchParams(location.search);
  let urlRoom = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); // 초대 링크 ?room=코드 → 코드 입력 없이 바로 입장

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
  let ui = { modal: null, sel: null, lastSeq: -1, create: { game: 'seotda', stake: { seotda: 10000, matgo: 1000, gostop: 1000 }, bonus: true, level: LS.get('hw_ai_level') || 'normal', aiCount: 3 }, lastTurnMine: false, sqDone: {}, sqP: {} };
  const socket = io({ transports: ['websocket', 'polling'] });

  // ---------- 유틸 ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n > 0 ? '+' : '') + Number(n).toLocaleString('ko-KR');
  const num = (n) => Number(n).toLocaleString('ko-KR');
  // 가상 머니 (원) — 실제 돈 아님
  const won = (n) => Number(n || 0).toLocaleString('ko-KR') + '원';
  const wonC = (n) => { n = Number(n || 0); const a = Math.abs(n); if (a >= 1e8) return (Math.round(n / 1e7) / 10).toLocaleString('ko-KR') + '억원'; if (a >= 1e4) return (Math.round(n / 1e3) / 10).toLocaleString('ko-KR') + '만원'; return won(n); };
  const fmtW = (n) => (n > 0 ? '+' : '') + won(n);
  const fmtWC = (n) => (n > 0 ? '+' : '') + wonC(n);
  const STAKES = { seotda: [5000, 10000, 50000, 100000], matgo: [500, 1000, 5000, 10000], gostop: [500, 1000, 5000, 10000] };
  const DISCLAIMER = '게임 안에서만 쓰는 가상 머니입니다. 충전·환전 없음';
  function toast(msg, big) {
    const t = document.createElement('div');
    t.className = 'toast' + (big ? ' big' : '');
    t.textContent = msg;
    document.getElementById('toasts').appendChild(t);
    setTimeout(() => t.remove(), big ? 2600 : 2000);
  }
  const FX = window.HwatuFX;
  const beep = (f, d) => FX.beep(f, d);
  const SH = window.HwatuShow; // 연출 (SHOW_V1): 도장·선 정하기·승패 배너 — show.js
  function emit(ev, data) {
    return new Promise((res) => socket.emit(ev, data, (r) => { if (r && !r.ok) toast(r.error || '오류'); res(r || {}); }));
  }

  // 카드 이미지: public/cards/cNN.png (Wikimedia Commons "Hwatu" 세트, CC BY-SA 4.0 — public/cards/LICENSE.txt)
  const imgOf = (hid) => `/cards/c${String(hid).padStart(2, '0')}.png`;
  function cardHTML(desc, cls, attrs, hid, extra) {
    cls = cls || '';
    if (desc == null) return `<div class="card back ${cls}" ${attrs || ''}></div>`;
    const lb = typeLabel(desc);
    if (desc.bonus) return `<div class="card img bonus ${cls}" style="background-image:url(/cards/bonus.svg)" ${attrs || ''} title="보너스 쌍피"></div>`;
    const tag = desc.type === 'ssangpi' ? '<span class="tb">쌍피</span>' : '';
    return `<div class="card img t-${desc.type} ${cls}" style="background-image:url(${imgOf(hid)});--mc:${MC[desc.m]}" ${attrs || ''} title="${desc.m}월 ${lb}"><span class="mb">${desc.m}</span>${tag}${extra || ''}</div>`;
  }
  (function preload() { for (let i = 0; i < 48; i++) { const im = new Image(); im.src = imgOf(i); } ['back.svg', 'bonus.svg'].forEach((f) => { const im = new Image(); im.src = '/cards/' + f; }); })();
  const hw = (id, cls, attrs, extra) => cardHTML(id == null ? null : HWATU[id], cls, attrs, id, extra);
  // 족보 진행 배지 (먹은 패 기준)
  const badgesHTML = (captured) => H.badges(captured).map((b) => `<span class="b b-${b.key}${b.done ? ' done' : b.n === b.need - 1 ? ' near' : ''}">${b.label}</span>`).join('');
  const sd = (id, cls, attrs) => cardHTML(id == null ? null : SEOTDA[id], cls, attrs, id == null ? null : (SEOTDA[id].m - 1) * 4 + (id % 2));

  // ---------- 소켓 ----------
  // 계정: 저장된 토큰으로 자동 로그인 → (있으면) 하던 방으로 복귀
  ui.authPending = !!LS.get('hw_token');
  socket.on('connect', async () => {
    const tk = LS.get('hw_token');
    if (tk) {
      const r = await new Promise((res) => socket.emit('auth', { token: tk }, (x) => res(x || {})));
      ui.authPending = false;
      if (r.ok) ui.acct = r.account;
      else { LS.del('hw_token'); ui.acct = null; }
      if (!S) render();
      loadRanking();
    }
    if (!ui.acct) { LS.del('hw_room'); if (urlRoom) loadInvite(); return; }
    enterTargetRoom();
  });
  // 초대 링크(?room=코드)가 있으면 그 방, 없으면 하던 방으로 바로 입장
  function enterTargetRoom() {
    const code = urlRoom || LS.get('hw_room');
    if (!code || (S && S.room.code === code)) return;
    socket.emit('joinRoom', { code, pid, name: ui.acct ? ui.acct.nickname : '' }, (r) => {
      r = r || {};
      if (r.ok) { LS.set('hw_room', r.code); history.replaceState(null, '', '/?room=' + r.code); return; }
      if (code === urlRoom) { toast('초대받은 방을 찾을 수 없어요. 방이 끝났을 수 있어요', true); urlRoom = ''; history.replaceState(null, '', '/'); }
      LS.del('hw_room'); S = null; render();
    });
  }
  // 초대 링크로 처음 온 사람: 어느 방인지 보여 주기 (공개 정보만)
  function loadInvite() {
    if (!urlRoom || ui.invite && ui.invite.code === urlRoom) return;
    socket.emit('roomInfo', { code: urlRoom }, (r) => {
      ui.invite = r && r.ok ? Object.assign({ code: urlRoom }, r.room) : { code: urlRoom, missing: true };
      if (!S && !ui.acct) render();
    });
  }
  // 진행 중인 방 목록 (첫 화면에서 실시간 갱신)
  socket.on('connect', () => socket.emit('watchRooms', {}, () => {}));
  socket.on('rooms', (list) => { ui.rooms = list || []; if (!S) { const el = document.getElementById('room-list'); if (el) el.innerHTML = roomListHTML(); } });
  socket.on('me', (m) => { ui.acct = m; if (m && m.nickname) LS.set('hw_name', m.nickname); if (!S || S.room.status === 'lobby') render(); });
  socket.on('notice', (n) => { if (n && n.text) toast((n.type === 'timeout' ? '⏰ ' : '💸 ') + n.text, true); });
  socket.on('ranking', (list) => { ui.ranking = list || []; const el = document.getElementById('rank-list'); if (el) el.innerHTML = rankHTML(); });
  function loadRanking() { socket.emit('ranking', {}, (r) => { if (r && r.ok) { ui.ranking = r.list; const el = document.getElementById('rank-list'); if (el) el.innerHTML = rankHTML(); } }); }
  // 계정이 사라짐 (이 기기에서 삭제·다른 기기에서 삭제·관리자 삭제): 토큰·마지막 이름 지우고 처음 입장 화면으로
  function accountGone(text) {
    LS.del('hw_token'); LS.del('hw_name'); LS.del('hw_room');
    try { cancelAnim(); } catch (e) {}
    ui.acct = null; ui.modal = null; ui.loginName = ''; S = null; urlRoom = '';
    history.replaceState(null, '', '/');
    toast(text, true);
    render();
  }
  document.addEventListener('input', (ev) => {
    const m = ui.modal; if (!m || (m.type !== 'rename' && m.type !== 'delAcct')) return;
    if (ev.target.id === 'rn-new' || ev.target.id === 'del-name') m.val = ev.target.value;
    if (ev.target.id === 'rn-pin' || ev.target.id === 'del-pin') m.pin = ev.target.value;
  });
  // 나가기 예약한 판이 끝남: 결과를 잠깐 보여 준 뒤 첫 화면으로
  socket.on('reservedLeft', (m) => {
    LS.del('hw_room');
    toast((m && m.text) || '예약한 대로 방에서 나왔어요', true);
    const leftRoom = S && S.room.code;
    setTimeout(() => { if (S && S.room.code === leftRoom) { try { cancelAnim(); } catch (e) {} S = null; urlRoom = ''; history.replaceState(null, '', '/'); render(); } }, 3000);
  });
  socket.on('accountDeleted', (m) => accountGone((m && m.text) || '계정이 삭제되었어요'));
  socket.on('kicked', (m) => { LS.del('hw_room'); try { cancelAnim(); } catch (e) {} S = null; urlRoom = ''; toast((m && m.text) || '방장이 방에서 내보냈습니다'); history.replaceState(null, '', '/'); render(); });
  socket.on('disconnect', () => toast('연결이 끊겼습니다. 다시 연결 중…'));
  socket.on('state', (st) => {
    const prev = S;
    const tn = st.room && st.room.turn;
    ui.turnAt = tn && st.game && !st.game.result ? { pid: tn.pid, deadline: Date.now() + tn.ms, total: tn.total } : null;
    if (!prev || prev.room.code !== st.room.code) { if (!ui.chatRoom || ui.chatRoom !== st.room.code) { ui.chat = []; ui.unread = 0; ui.chatRoom = st.room.code; } }
    const snap = snapshotRects();
    S = st;
    if (st.spectator && (!prev || !prev.spectator || prev.room.code !== st.room.code)) toast(st.spectator.waiting ? '👀 관전 중 — 다음 판부터 AI 자리에서 참여합니다' : '👀 관전 중 (자리가 모두 찼어요)', true);
    else if (!st.spectator && prev && prev.spectator && prev.room.code === st.room.code) toast('🎉 이제 참여합니다! AI 자리를 넘겨받았어요', true);
    const r = st.room, g = st.game;
    const pg = prev && prev.room.code === r.code ? prev.game : null;
    const sameRoom = prev && prev.room.code === r.code;
    // 새 판(또는 섯다 재경기) → 패 돌리기 애니메이션
    let newDeal = !!(g && sameRoom && !g.result && (r.round !== prev.room.round || (g.kind === 'seotda' && pg && pg.kind === 'seotda' && g.redeals !== pg.redeals)));
    if (ui.expectDeal && g && !g.result) { newDeal = true; } // 'AI와 바로 하기': 방 만들자마자 첫 판
    if (g || !ui.expectDeal) ui.expectDeal = false;
    if (!g || (sameRoom && r.round !== prev.room.round)) ui.fitU = null;
    // 맞고/고스톱: 누군가 패를 냄 → 손→바닥 애니메이션 + '탁'
    const lp = g && g.kind !== 'seotda' ? g.lastPlay : null;
    const playKey = lp ? r.round + ':' + lp.seq : null;
    const newPlay = !!(lp && pg && pg.kind !== 'seotda' && prev.room.round === r.round && playKey !== ui.lastPlayKey);
    ui.lastPlayKey = playKey;
    const lc = g && g.kind !== 'seotda' ? g.lastCapture : null;
    const capKey = lc ? r.round + ':' + lc.seq : null;
    const newCap = !!(lc && pg && pg.kind !== 'seotda' && prev.room.round === r.round && capKey !== ui.lastCapKey);
    ui.lastCapKey = capKey;
    // 족보 완성 토스트 (맞고/고스톱)
    if (g && pg && g.kind !== 'seotda' && pg.kind === g.kind && prev.room.round === r.round && pg.players.length === g.players.length) {
      g.players.forEach((pl, i) => {
        const before = new Set(H.completed(pg.players[i].captured));
        H.completed(pl.captured).filter((x) => !before.has(x)).forEach((x) => {
          const st = YAKU_STAMP[x];
          if (st) SH.stamp(st[0], 'gold', { say: st[2] || st[0], sub: (i === g.mySeat ? '나' : pl.name) + (st[1] ? ' · ' + st[1] : ''), delay: 650 });
          setTimeout(() => toast(`🎉 ${pl.name} ${x} 완성!`, !st), 550);
        });
      });
    }
    const seotdaReveal = !!(g && g.kind === 'seotda' && g.result && pg && !pg.result && g.result.reveal && g.result.reveal.length);
    if (g && g.kind === 'seotda' && (g.result || (g.mySeat >= 0 && g.seats[g.mySeat].folded))) ui.sqDone[sqKey(g)] = true; // 결과·다이 → 조이기 끝
    // 판이 방금 끝남 → 마지막 패/먹기 애니메이션과 최종 판을 잠깐 보여준 뒤 결과 화면 (RESULT_V2)
    const justEnded = !!(g && g.result && pg && !pg.result && sameRoom && prev.room.round === r.round);
    if (justEnded) {
      let hold = g.kind === 'seotda' ? (seotdaReveal ? 2700 : 1300) : 1400;
      if (g.kind !== 'seotda' && newPlay) hold = 1500 + (lp.flip != null ? 300 : 0) + (newCap && lc.gained.length ? 800 + 35 * lc.gained.length + (lc.steals && lc.steals.length ? 450 : 0) : 0);
      if (!FX.canAnimate) hold = Math.min(hold, 1200);
      ui.resHold = { key: r.code + ':' + r.round, until: Date.now() + hold };
      clearTimeout(ui.resTimer);
      ui.resTimer = setTimeout(() => { if (S && S.game && S.game.result) { render(); FX.tak(0.8); } }, hold + 20);
    }
    // 진행 상황이 바뀌면 진행 중인 애니메이션은 즉시 정리 (서버 상태가 항상 우선)
    if (!sameRoom || r.actSeq !== prev.room.actSeq || r.round !== prev.room.round) cancelAnim();
    if (g && r.actSeq !== ui.lastSeq) {
      if (ui.lastSeq !== -1) {
        (g.events || []).forEach((e) => {
          const st = g.kind !== 'seotda' ? eventStamp(e, g) : null;
          if (st) SH.stamp(st.text, st.kind, { sub: st.sub, say: st.say, delay: 380 });
          if (g.result) return; // 판 끝 문구는 결과 화면에서
          const big = /뻑|쪽|따닥|싹쓸이|폭탄|흔들기|고!|스톱|승리|나가리|재경기|땡|광/.test(e);
          toast(e, big && !st);
        });
      }
      ui.lastSeq = r.actSeq;
    }
    const mine = isMyTurn();
    if (mine && !ui.lastTurnMine) { beep(880, 0.15); if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) try { navigator.vibrate(60); } catch (e) {} }
    ui.lastTurnMine = mine;
    if (g && g.phase !== 'play') ui.sel = null;
    if (ui.modal && ui.modal.type === 'choose' && !(g && g.phase === 'play' && mine)) ui.modal = null;
    render();
    try {
      if (newDeal) startIntro(g);
      else if (newPlay) playAnim(g, lp, snap, newCap ? lc : null); // 마지막 수도 끝까지 보여 줌
      else if (newCap) captureAnim(g, lc, snap, {}, 0);
      else if (seotdaReveal) showdown(g);
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
    try { FX.music(inGame ? 'game' : 'lobby'); } catch (e) {}
    if (!S && ui.chatOpen) { ui.chatOpen = false; drawChat(); }
    if (!S) return renderLanding();
    const r = S.room;
    if (r.status === 'lobby' || !S.game) return renderLobby();
    $app.dataset.kind = S.game.kind === 'seotda' ? 'seotda' : 'gostop';
    renderGame();
    document.documentElement.classList.add('in-game');
    fit();
    applyHidden();
    resultIntro();
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
  const anim = { hidden: new Set(), flights: [], timers: [], ghost: null, cardGhost: {}, moving: false, gen: 0 };
  const rectOf = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height }; };
  const centered = (box, w, h) => ({ left: box.left + box.width / 2 - w / 2, top: box.top + box.height / 2 - h / 2, width: w, height: h });
  function applyHidden() { anim.hidden.forEach((sel) => document.querySelectorAll(sel).forEach((e) => e.classList.add('fx-hide'))); }
  function hideSel(sel) { anim.hidden.add(sel); applyHidden(); }
  function showSel(sel) { anim.hidden.delete(sel); document.querySelectorAll(sel).forEach((e) => e.classList.remove('fx-hide')); }
  function cancelAnim() {
    anim.gen++; // 이전 애니메이션의 늦게 도착한 콜백은 무시
    anim.timers.forEach(clearTimeout); anim.timers = [];
    anim.flights.forEach((f) => f.cancel()); anim.flights = [];
    anim.hidden.clear();
    document.querySelectorAll('.fx-hide').forEach((e) => e.classList.remove('fx-hide'));
    if (anim.ghost) { anim.ghost.remove(); anim.ghost = null; }
    anim.dealing = false; anim.moving = false; anim.cardGhost = {};
    FX.clearLayer();
    if (SH.seonActive()) SH.clearSeon();
  }
  const later = (ms, fn) => { anim.timers.push(setTimeout(fn, ms)); };
  function cardSize(sel) { const e = document.querySelector(sel); return e ? rectOf(e) : null; }
  function snapshotRects() {
    const s = { hand: {}, floorM: {}, floorId: {}, capId: {}, deck: null, floor: null, lfc: null };
    if (!S || !S.game || S.game.kind === 'seotda') return s;
    document.querySelectorAll('.floor [data-floor]').forEach((e) => { s.floorId[e.dataset.floor] = rectOf(e); });
    document.querySelectorAll('[data-cap]').forEach((e) => { s.capId[e.dataset.cap] = rectOf(e); });
    const lf = document.querySelector('.deck .lfc'); if (lf) s.lfc = rectOf(lf);
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
    let from, lead = 0;
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
      // 맞고/고스톱: 가운데서 셔플 → 서버가 보낸 실제 돌린 순서(g.deal)대로 한 장씩
      const fl = document.querySelector('.floor-wrap'); if (!fl) return;
      const ref = cardSize('.floor .card') || { width: 50, height: 82 };
      from = centered(rectOf(fl), ref.width, ref.height);
      const me = g.mySeat;
      const oppCard = cardSize('.opp .card') || { width: 24, height: 40 };
      const seq = g.deal && g.deal.length ? g.deal : null;
      if (!seq) return;
      for (const d of seq) {
        if (d.to === 'hand') {
          if (d.seat === me) {
            const sel = `.hand [data-hand="${d.card}"]`; const el = document.querySelector(sel);
            if (el) steps.push({ sel, to: rectOf(el), html: back });
          } else {
            const b = seatBoxRect(g, d.seat); if (b) steps.push({ sel: null, to: centered(b, oppCard.width * 1.2, oppCard.height * 1.2), html: back, opp: true });
          }
        } else if (d.to === 'floor') {
          const sel = `.floor [data-floor="${d.card}"]`; const el = document.querySelector(sel);
          if (el) steps.push({ sel, to: rectOf(el), html: hw(d.card) });
          else steps.push({ sel: null, to: { left: from.left + ref.width * 1.2, top: from.top, width: ref.width, height: ref.height }, html: hw(d.card), linger: true });
        } else if (d.to === 'cap') {
          // 바닥에 나온 보너스패 → 선에게
          const b = seatBoxRect(g, d.seat);
          if (b) steps.push({ sel: null, from: { left: from.left + ref.width * 1.2, top: from.top, width: ref.width, height: ref.height }, to: centered(b, oppCard.width * 1.2, oppCard.height * 1.2), html: hw(d.card), opp: true });
        }
      }
      lead = FX.canAnimate ? 1000 : 0;
      hideSel('.deck > .card.back');
      steps.push({ sel: '.deck > .card.back', reveal: true });
      g.players.forEach((p, i) => steps.push({ sel: i === me ? '.mine .bdg' : `.opp[data-seat="${i}"] .bdg`, reveal: true }));
      shuffleAnim(from, lead);
    }
    steps.forEach((st) => { if (st.sel) hideSel(st.sel); });
    const reveals = steps.filter((st) => st.reveal);
    for (let k = steps.length - 1; k >= 0; k--) if (steps[k].reveal) steps.splice(k, 1);
    if (!steps.length) { cancelAnim(); return; }
    const N = steps.length;
    const gap = g.kind === 'seotda' ? Math.max(45, Math.min(300, 1900 / N)) : Math.max(40, Math.min(110, 2100 / N));
    const dur = g.kind === 'seotda' ? 300 : 270;
    anim.dealing = true;
    steps.forEach((st, k) => {
      later(lead + k * gap, () => {
        const f = FX.fly(st.html, st.from || from, st.to, {
          duration: dur, rot0: -10 + Math.random() * 6, arc: 10, lift: 1.05, fade: !!st.opp, shrink: st.opp ? 0.7 : 0, linger: !!st.linger,
          onLand: () => { FX.tick(); if (st.sel) showSel(st.sel); },
        });
        anim.flights.push(f);
      });
    });
    later(lead + (N - 1) * gap + dur + 60, () => { reveals.forEach((st) => showSel(st.sel)); if (anim.ghost) { anim.ghost.remove(); anim.ghost = null; } anim.flights = []; anim.timers = []; anim.dealing = false; });
  }

  // 가운데 더미 셔플 애니메이션 (반으로 갈라 리플 → 가지런히 → 컷), 끝나면 더미는 anim.ghost로 남아 패를 돌림
  function shuffleAnim(at, total) {
    const L = FX.getLayer();
    const pile = document.createElement('div');
    pile.className = 'shuffle-pile';
    Object.assign(pile.style, { left: at.left + 'px', top: at.top + 'px', width: at.width + 'px', height: at.height + 'px' });
    const K = 10;
    const cards = [];
    for (let i = 0; i < K; i++) {
      const c = document.createElement('div');
      c.className = 'card back sp';
      c.style.width = at.width + 'px'; c.style.height = at.height + 'px';
      pile.appendChild(c); cards.push(c);
    }
    L.appendChild(pile);
    anim.ghost = pile;
    FX.shuffle(total);
    if (!FX.canAnimate || !total) return;
    const W = at.width * 0.75;
    cards.forEach((c, i) => {
      const left = i % 2 === 0, dir = left ? -1 : 1;
      const y0 = -i * 0.6;
      const riffleAt = 0.34 + (i / K) * 0.36;
      const kf = [
        { transform: `translate(0px,${y0}px) rotate(0deg)`, offset: 0 },
        { transform: `translate(${dir * W}px,${y0 + 4}px) rotate(${dir * 8}deg)`, offset: 0.28 },
        { transform: `translate(${dir * W}px,${y0 + 4}px) rotate(${dir * 8}deg)`, offset: riffleAt },
        { transform: `translate(${dir * 4}px,${y0 - 3}px) rotate(${dir * 2}deg)`, offset: Math.min(0.76, riffleAt + 0.1) },
        { transform: `translate(0px,${y0}px) rotate(0deg)`, offset: 0.8 },
        { transform: `translate(0px,${y0 - (i >= K / 2 ? at.height * 0.45 : 0)}px) rotate(0deg)`, offset: 0.9 },
        { transform: `translate(0px,${y0}px) rotate(0deg)`, offset: 1 },
      ];
      try { anim.flights.push({ cancel: ((a) => () => { try { a.cancel(); } catch (e) {} })(c.animate(kf, { duration: total, easing: 'ease-in-out', fill: 'forwards' })) }); } catch (e) {}
    });
  }
  // 패 돌리는 중 화면을 탭하면 건너뛰기
  document.addEventListener('pointerdown', (ev) => {
    if (resHolding()) { ui.resHold.until = 0; clearTimeout(ui.resTimer); anim.swallowUntil = Date.now() + 600; setTimeout(() => { cancelAnim(); render(); }, 0); return; } // 판 끝 대기 중 탭 → 바로 결과
    if (anim.moving && !anim.dealing) { cancelAnim(); return; } // 먹기 애니메이션: 탭하면 바로 끝 (탭 자체는 그대로 동작)
    if (!anim.dealing) return;
    cancelAnim();
    anim.swallowUntil = Date.now() + 450;
  }, true);
  document.addEventListener('click', (e) => {
    if (anim.swallowUntil && Date.now() < anim.swallowUntil) { e.stopPropagation(); e.preventDefault(); anim.swallowUntil = 0; }
  }, true);


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
  function playAnim(g, lp, snap, cap) {
    cancelAnim();
    const gen = anim.gen;
    const gained = new Set(cap ? cap.gained : []);
    const landed = {}; // 먹힌 카드가 바닥에 내려앉은 위치 (먹기 애니메이션 출발점)
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
          duration: 280, rot0: lp.seat === g.mySeat ? 0 : -12, rot1: 0, arc: 26, lift: 1.15, linger: !dest.sel && !gained.has(lp.card),
          onLand: () => { FX.tak(); if (dest.sel) showSel(dest.sel); if (gen === anim.gen && gained.has(lp.card)) ghostCard(lp.card, dest.rect); },
        }));
        landed[lp.card] = dest.rect;
        t = 380;
      } else FX.tak();
    }
    if (lp.flip != null) {
      const dd = floorDest(lp.flip, snap);
      const deckEl = document.querySelector('.deck .card');
      const from = deckEl ? rectOf(deckEl) : snap.deck;
      if (dd.sel) hideSel(dd.sel);
      landed[lp.flip] = dd.rect;
      later(t, () => {
        if (!from) { FX.tak(); if (dd.sel) showSel(dd.sel); return; }
        anim.flights.push(FX.fly(hw(lp.flip), from, dd.rect, {
          duration: 260, rot0: -6, arc: 16, lift: 1.1, linger: !dd.sel && !gained.has(lp.flip),
          onLand: () => { FX.tak(0.85); if (dd.sel) showSel(dd.sel); if (gen === anim.gen && gained.has(lp.flip)) ghostCard(lp.flip, dd.rect); },
        }));
      });
      t += 300;
    }
    if (cap) captureAnim(g, cap, snap, landed, t + 20);
  }

  // ---------- 먹기 / 피 뺏기 애니메이션 ----------
  // 바닥에 남아 있는 것처럼 보이는 정지 카드 (새 상태에서는 이미 먹은 패 더미로 이동했으므로 대신 그려 줌)
  function ghostCard(id, rect) {
    if (anim.cardGhost[id]) return anim.cardGhost[id];
    const w = document.createElement('div');
    w.innerHTML = hw(id);
    const el = w.firstElementChild;
    el.classList.add('flyer', 'ghostc');
    Object.assign(el.style, { width: rect.width + 'px', height: rect.height + 'px', transform: `translate(${rect.left}px,${rect.top}px)` });
    FX.getLayer().appendChild(el);
    anim.cardGhost[id] = el;
    el._r = rect;
    return el;
  }
  function moveEl(el, to, dur, opts) {
    opts = opts || {};
    const r0 = el._r;
    const sx = to.width / r0.width, sy = to.height / r0.height;
    const kf = [{ transform: `translate(${r0.left}px,${r0.top}px)`, opacity: 1 }];
    if (opts.arc) kf.push({ transform: `translate(${(r0.left + to.left) / 2}px,${Math.min(r0.top, to.top) - opts.arc}px) scale(${(1 + sx) / 2 + 0.05},${(1 + sy) / 2 + 0.05})`, offset: 0.5 });
    kf.push({ transform: `translate(${to.left}px,${to.top}px) scale(${sx},${sy})`, opacity: 1 });
    el.style.transformOrigin = '0 0';
    try {
      const a = el.animate(kf, { duration: dur, easing: 'cubic-bezier(.4,.1,.3,1)', fill: 'forwards' });
      anim.flights.push({ cancel: () => { try { a.cancel(); } catch (e) {} } });
      const gen = anim.gen;
      a.onfinish = () => { if (opts.done && gen === anim.gen) opts.done(); };
    } catch (e) { if (opts.done) opts.done(); }
  }
  function captureAnim(g, cap, snap, landed, t0) {
    if (!FX.canAnimate) { if (cap.gained.length) setTimeout(() => FX.swish(), t0); return; }
    anim.moving = true;
    const capSel = (id) => `[data-cap="${id}"]`;
    const ref = cardSize('.floor .card') || { width: 50, height: 82 };
    // 출발 위치: 방금 내려앉은 자리 → 직전 바닥 위치 → 뒤집은 패 자리 → 더미
    const srcOf = (id) => landed[id] || snap.floorId[id] || (snap.lfc && { left: snap.lfc.left, top: snap.lfc.top, width: ref.width, height: ref.height }) || snap.deck || centered(snap.floor || { left: 0, top: 0, width: innerWidth, height: innerHeight }, ref.width, ref.height);
    const gained = cap.gained.filter((id) => document.querySelector(capSel(id)));
    const steals = (cap.steals || []).filter((x) => document.querySelector(capSel(x.card)));
    gained.forEach((id) => hideSel(capSel(id)));
    steals.forEach((x) => hideSel(capSel(x.card)));
    // 원래 바닥에 있던 먹힌 패는 곧바로 정지 카드로 그 자리에 계속 보이게
    gained.forEach((id) => { if (!landed[id] && snap.floorId[id]) ghostCard(id, snap.floorId[id]); });
    const GATHER = 140, PAUSE = 230, FLY = 380;
    let t = t0;
    if (gained.length) {
      later(t, () => {
        // 1) 같은 달끼리 착 모이기 + 반짝
        const byM = {};
        gained.forEach((id) => { (byM[HWATU[id].m] = byM[HWATU[id].m] || []).push(id); });
        Object.values(byM).forEach((ids) => {
          const anchor = srcOf(ids[0]);
          ids.forEach((id, k) => {
            const el = anim.cardGhost[id] || ghostCard(id, srcOf(id));
            el.classList.add('cap-glow');
            const to = { left: anchor.left + k * 5, top: anchor.top - k * 3, width: anchor.width, height: anchor.height };
            moveEl(el, to, GATHER, { done: () => { el._r = to; } });
          });
        });
      });
      t += GATHER + PAUSE;
      // 2) 먹은 패 더미로 휙
      later(t, () => {
        FX.swish();
        gained.forEach((id, k) => {
          const el = anim.cardGhost[id]; if (!el) return;
          const target = document.querySelector(capSel(id));
          if (!target) { el.remove(); delete anim.cardGhost[id]; return; }
          later(k * 35, () => moveEl(el, rectOf(target), FLY, { arc: 20, done: () => { el.remove(); delete anim.cardGhost[id]; showSel(capSel(id)); } }));
        });
      });
      t += FLY + gained.length * 35;
    }
    // 3) 피 뺏기: 상대 더미 → 내 더미
    if (steals.length) {
      later(Math.max(t0, t - 120), () => {
        FX.swish(0.7, true);
        steals.forEach((x, k) => {
          const from = snap.capId[x.card] || seatBoxRect(g, x.from);
          const target = document.querySelector(capSel(x.card));
          if (!from || !target) { showSel(capSel(x.card)); return; }
          const el = ghostCard(x.card, from);
          el.classList.add('steal-glow');
          later(k * 90, () => moveEl(el, rectOf(target), 420, { arc: 30, done: () => { el.remove(); delete anim.cardGhost[x.card]; showSel(capSel(x.card)); } }));
        });
      });
      t = Math.max(t, t - 120 + 420 + steals.length * 90);
    }
    later(t + 80, () => {
      anim.moving = false;
      // 안전장치: 남은 정지 카드/숨김은 모두 정리
      gained.concat(steals.map((x) => x.card)).forEach((id) => { const el = anim.cardGhost[id]; if (el) { el.remove(); delete anim.cardGhost[id]; } showSel(capSel(id)); });
    });
  }

  function renderLogin() {
    const name = ui.loginName != null ? ui.loginName : LS.get('hw_name') || '';
    const inv = urlRoom ? ui.invite || { code: urlRoom } : null;
    const invHTML = inv ? (inv.missing
      ? `<div class="panel invite miss">😢 초대받은 방 <b>${esc(inv.code)}</b>을(를) 찾을 수 없어요. 방이 끝났을 수 있어요.<br><small>이름을 쓰고 들어가서 다른 방에 참여하거나 새로 만들 수 있어요.</small></div>`
      : `<div class="panel invite"><div class="inv-t">🎉 초대받았어요!</div><div class="inv-room">${inv.host ? `<b>${esc(inv.host)}</b>님의 ` : ''}<span class="inv-g">${esc(inv.gameName || '')}</span> 방 <span class="inv-code">${esc(inv.code)}</span></div>${inv.status ? `<div class="muted">${inv.status === 'playing' ? '게임 중 — 들어가면 관전하다가 다음 판부터 참여' : '대기 중 — 들어가면 바로 참여'}</div>` : ''}<div class="inv-hint">이름만 쓰면 바로 입장해요 (방 코드 입력 필요 없음)</div></div>`) : '';
    $app.innerHTML = `<div class="pad login" style="position:relative">${muteBtn('snd-float')}
      <h1 class="title brand">🎴 혁게임<span class="logo-sub">HYUK GAME</span></h1>
      <p class="subtitle">고스톱 · 맞고 · 섯다 — 단톡방 친구들과 실시간으로!</p>
      ${invHTML}
      ${ui.authPending ? '<div class="panel" style="text-align:center">입장 중…</div>' : `<div class="panel"><h3>${inv && !inv.missing ? '내 이름' : '시작하기'}</h3>
        <input id="nick" maxlength="12" placeholder="이름 (친구들에게 보여요)" autocomplete="nickname" enterkeyhint="go" value="${esc(name)}">
        ${ui.needPin ? `<input id="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="PIN 숫자 4자리" autocomplete="current-password" style="margin-top:8px;letter-spacing:6px">` : ''}
        ${ui.loginMsg ? `<div class="login-msg ${ui.loginMsgKind || ''}">${esc(ui.loginMsg)}</div>` : ''}
        <button class="btn-primary" style="width:100%;margin-top:10px;font-size:18px;padding:14px" data-act="enter">${inv && !inv.missing ? '방에 입장하기' : '입장하기'}</button>
        <div class="muted" style="margin-top:8px;font-size:12px">처음이면 <b>1,000,000원</b>을 드려요. 이 폰(기기)은 자동으로 기억해서 다음부터 바로 들어가요.${ui.needPin ? '' : ' <a href="#" data-act="havePin" class="lnk">PIN이 있어요</a>'}</div></div>`}
      <p class="notice">※ ${DISCLAIMER}.<br>실제 돈·현금·경품과 교환되지 않으며 결제 기능이 없습니다.</p>
    </div>`;
  }
  function pinPanel() {
    if (!ui.pinForm) return '';
    const has = ui.acct && ui.acct.hasPin;
    return `<div class="panel pin-form"><h3>🔒 ${has ? 'PIN 바꾸기' : 'PIN 설정'} <small class="muted">다른 기기에서도 이 이름으로 들어오려면</small></h3>
      ${has ? '<input id="pin-cur" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="지금 PIN" style="letter-spacing:6px;margin-bottom:6px">' : ''}
      <input id="pin-new" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="새 PIN 숫자 4자리" style="letter-spacing:6px">
      <div class="row" style="margin-top:8px"><button class="btn-primary" data-act="savePin">저장</button><button class="btn-ghost" data-act="cancelPin">취소</button></div>
      <div class="muted" style="font-size:12px;margin-top:6px">다른 폰·PC에서 이름과 PIN을 입력하면 같은 돈으로 이어서 할 수 있어요. PIN은 암호화해서 저장합니다.</div></div>`;
  }
  // 전적 (STATS_V1)
  const GNAME = { gostop: '고스톱', matgo: '맞고', seotda: '섯다' };
  const recN = (t) => (t ? t.w + t.d + t.l : 0);
  const rateOf = (t) => (recN(t) ? Math.round((t.w / recN(t)) * 100) : 0);
  const recText = (t, short) => (!recN(t) ? '아직 전적 없음' : short ? `${t.w}승${t.d}무${t.l}패 ${rateOf(t)}%` : `${t.w}승 ${t.d}무 ${t.l}패 · 승률 ${rateOf(t)}%`);
  function rankHTML() {
    const list = ui.ranking || [];
    if (!list.length) return '<div class="muted" style="text-align:center">아직 기록이 없어요</div>';
    const me = ui.acct && ui.acct.nickname;
    return `<ol class="rank">${list.map((x, i) => `<li class="${x.nickname === me ? 'me' : ''}"><span class="rk">${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</span><span class="rn">${esc(x.nickname)}<small class="rrec">${recText(x.rec, true)}</small></span><span class="rm">${won(x.balance)}</span></li>`).join('')}</ol>`;
  }
  function renderLanding() {
    if (!ui.acct) return renderLogin();
    const c = ui.create;
    const stake = c.stake[c.game];
    const joinBox = urlRoom
      ? `<div class="panel"><h3>🎉 초대받은 방: <span style="color:#ffcf4a">${esc(urlRoom)}</span></h3><button class="btn-primary" style="width:100%" data-act="joinUrl">이 방에 입장하기</button></div>`
      : '';
    $app.innerHTML = `<div class="pad" style="position:relative">${muteBtn('snd-float')}
      <h1 class="title brand">🎴 혁게임<span class="logo-sub">HYUK GAME</span></h1>
      <p class="subtitle">고스톱 · 맞고 · 섯다 — 단톡방 친구들과 실시간으로!</p>
      <div class="panel acct"><div class="acct-name">👤 <b>${esc(ui.acct.nickname)}</b></div><div class="acct-btns"><button class="btn-ghost" style="padding:4px 10px;font-size:12px" data-act="pinForm">🔒 ${ui.acct.hasPin ? 'PIN 변경' : 'PIN 설정'}</button> <button class="btn-ghost" style="padding:4px 10px;font-size:12px" data-act="renameForm">✏️ 이름 바꾸기</button> <button class="btn-ghost" style="padding:4px 10px;font-size:12px" data-act="logout">로그아웃</button></div>
        <div class="mymoney" style="display:flex;align-items:center;justify-content:space-between;gap:6px"><span>💰 내 돈 <b>${won(ui.acct.balance)}</b></span><button class="lnk-red" data-act="delForm">계정 삭제</button></div>
        <button class="rec-line" data-act="recInfo">📊 전적 ${recText(ui.acct.stats && ui.acct.stats.total)} <span class="muted">›</span></button>
        ${ui.acct.hasPin ? '' : '<div class="muted" style="font-size:12px;margin-top:4px">다른 기기에서도 쓰려면 <a href="#" data-act="pinForm" class="lnk">PIN 설정</a></div>'}</div>
      ${pinPanel()}
      ${joinBox}
      <div class="panel rooms-panel"><h3>🟢 진행 중인 방 <small class="muted">누르면 바로 참여 · 실시간</small></h3><div id="room-list">${roomListHTML()}</div></div>
      <div class="panel"><h3>방 만들기</h3>
        <div class="game-pick">${Object.entries(GAME_INFO).map(([k, v]) => `<button data-game="${k}" class="${c.game === k ? 'sel' : ''}">${v.name}<small>${v.desc}</small></button>`).join('')}</div>
        <div class="muted">${c.game === 'seotda' ? '기본 판돈' : '점당'}</div>
        <div class="chips-pick">${STAKES[c.game].map((v) => `<button data-pp="${v}" class="${stake === v ? 'sel' : ''}">${wonC(v)}</button>`).join('')}</div>
        ${c.game !== 'seotda' ? `<label class="chk"><input type="checkbox" id="bonus" ${c.bonus ? 'checked' : ''}> 보너스 쌍피 2장 포함</label>` : ''}
        ${privChk()}
        <button class="btn-primary" style="width:100%;margin-top:10px" data-act="create">방 만들기 (친구 초대)</button>
      </div>
      <div class="panel ai-panel"><h3>🤖 AI와 바로 하기 <small class="muted">혼자서 ${GAME_INFO[c.game].name} 연습 · ${c.game === 'seotda' ? '판돈' : '점당'} ${wonC(stake)}</small></h3>
        <div class="muted">난이도</div>
        <div class="chips-pick">${[['easy', '쉬움'], ['normal', '보통']].map(([k, v]) => `<button data-lv="${k}" class="${c.level === k ? 'sel' : ''}">${v}</button>`).join('')}</div>
        ${c.game === 'seotda' ? `<div class="muted">AI 인원</div><div class="chips-pick">${[1, 2, 3, 4].map((v) => `<button data-aic="${v}" class="${c.aiCount === v ? 'sel' : ''}">${v}명</button>`).join('')}</div>` : `<div class="muted">AI ${c.game === 'matgo' ? '1명' : '2명'}과 대결</div>`}
        ${privChk()}
        <button class="btn-blue" style="width:100%;margin-top:8px;font-size:16px" data-act="solo">🤖 ${GAME_INFO[c.game].name} AI와 바로 하기</button>
      </div>
      <div class="panel"><h3>코드로 참여</h3>
        <div class="row"><input id="code" maxlength="5" placeholder="방 코드 5자리" style="text-transform:uppercase" value="${esc(urlRoom)}"><button class="btn-blue" style="flex:0 0 90px" data-act="join">참여</button></div>
      </div>
      <div class="panel rank-panel"><h3>🏆 순위 <small class="muted">가진 돈 Top 10</small></h3><div id="rank-list">${rankHTML()}</div></div>
      <p class="notice">※ <b>${DISCLAIMER}</b>.<br>실제 돈·현금·경품과 교환되지 않으며 결제 기능이 없습니다. 0원이 되면 300,000원으로 다시 시작해요.<br><span style="opacity:.7">카드 그림: Wikimedia Commons “Hwatu” 세트 (Spenĉjo, Louie Mantia Jr. 원작 기반), <a href="/cards/LICENSE.txt" style="color:#ffcf4a">CC BY-SA 4.0</a><br>배경음악·효과음·연출: 혁게임 자체 제작 (Web Audio 실시간 합성)<br>외침 목소리: <a href="https://github.com/myshell-ai/MeloTTS" style="color:#ffcf4a">MeloTTS</a> 한국어 모델(MyShell.ai, MIT 라이선스)로 생성</span></p>
    </div>${modalHTML()}`;
  }

  const privChk = () => `<label class="chk"><input type="checkbox" data-priv="1" ${ui.create.priv ? 'checked' : ''}> 🔒 비공개 (진행 중인 방 목록에 안 보이게)</label>`;
  function roomListHTML() {
    const list = ui.rooms || [];
    if (!list.length) return '<div class="muted" style="text-align:center;padding:8px 0">지금 열린 방이 없어요. 방을 만들어 보세요!</div>';
    const st = { lobby: ['대기 중', 'st-lobby'], playing: ['게임 중', 'st-play'], result: ['판 끝남', 'st-lobby'] };
    const jl = { seat: '참여', next: '관전 → 다음 판 참여', watch: '관전' };
    return `<ul class="rlist">${list.map((x) => `<li><button class="room-item" data-room="${esc(x.code)}">
      <span class="rg">${esc(x.gameName)}</span>
      <span class="rinfo"><b>${esc(x.host)}</b>님의 방 <small class="muted">${esc(x.code)}${x.round ? ` · ${x.round}판` : ''}</small><br>
        <small>👤 ${x.humans}명${x.ai ? ` · 🤖 AI ${x.ai}` : ''} / ${x.max}자리${x.spectators ? ` · 👀 ${x.spectators}` : ''} · <span class="st ${st[x.status][1]}">${st[x.status][0]}</span></small></span>
      <span class="rj ${x.join}"><small class="rs">${x.game === 'seotda' ? '판돈' : '점당'} ${wonC(x.perPoint)}</small><br>${jl[x.join]}</span></button></li>`).join('')}</ul>`;
  }
  function getName() {
    if (!ui.acct) { toast('먼저 로그인하세요'); render(); return null; }
    return ui.acct.nickname;
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
    return `<ul class="plist">${r.players.map((p) => `<li class="${p.ai ? 'ai' : ''}" data-pid="${esc(p.id)}"><div>${esc(p.name)}${p.ai ? `<span class="tag ai">AI·${p.level === 'easy' ? '쉬움' : '보통'}</span>` : ''}${p.id === r.hostId ? '<span class="tag">방장</span>' : ''}${p.id === S.me ? '<span class="tag" style="background:#4ae0ff">나</span>' : ''}${!p.connected ? '<span class="tag off">연결끊김</span>' : ''}${isHost() && p.id !== S.me && r.status !== 'playing' ? `<button class="btn-ghost" style="padding:4px 8px;font-size:11px;margin-left:6px" data-kick="${esc(p.id)}" ${p.ai ? 'data-ai="1"' : ''}>${p.ai ? '빼기' : '내보내기'}</button>` : ''}${p.rec ? `<small class="prec" title="전체 ${recText(p.rec.t)}">${GNAME[r.game]} ${recText(p.rec.g, true)}</small>` : ''}</div><div class="chip ${p.chips < 0 ? 'neg' : ''}">${won(p.chips)}</div></li>`).join('')}</ul>`;
  }

  const hostPrivChk = () => (isHost() ? `<label class="chk" style="justify-content:center"><input type="checkbox" data-priv="host" ${S.room.private ? 'checked' : ''}> 🔒 비공개 방 (진행 중인 방 목록에 안 보이게)</label>` : '');
  const specList = () => { const sp = S.room.spectators || []; return sp.length ? `<div class="muted" style="margin-top:6px">👀 관전 ${sp.length}명: ${sp.map((x) => esc(x.name) + (x.waiting ? ' (다음 판 참여)' : '')).join(', ')}</div>` : ''; };
  function renderLobby() {
    const r = S.room;
    const n = r.players.length;
    const enough = r.game === 'seotda' ? n >= r.min : n === r.min;
    const need = r.game === 'seotda' ? `${r.min}~${r.max}명` : `${r.min}명`;
    $app.innerHTML = `${header()}<div class="pad">
      <div class="panel" style="text-align:center">
        <div class="muted">${esc(r.gameName)} · ${r.game === 'seotda' ? '기본 판돈' : '점당'} ${won(r.perPoint)}${r.game !== 'seotda' ? (r.bonus ? ' · 보너스패 O' : ' · 보너스패 X') : ''}</div>
        <div class="mymoney">💰 내 돈 <b>${won(meP() ? meP().chips : ui.acct ? ui.acct.balance : 0)}</b></div>
        <div class="code-big">${esc(r.code)}</div>
        <div class="muted">방 코드</div>
        <button class="btn-kakao" style="width:100%;margin-top:10px;font-size:16px" data-act="share">💬 카톡으로 공유 (초대 링크)</button>
        ${hostPrivChk()}
      </div>
      ${S.spectator ? '<div class="panel spec-note">👀 관전 중 — 자리가 모두 찼어요. 자리가 나면 참여할 수 있어요.</div>' : ''}
      <div class="panel"><h3>참가자 (${n}/${r.max}) · 필요 인원 ${need}</h3>${playersList()}${specList()}
        ${isHost() && n < r.max ? `<div class="row ai-add"><button class="btn-blue" data-act="addAI">🤖 AI 추가</button><div class="chips-pick" style="flex:0 0 auto;margin:0">${[['easy', '쉬움'], ['normal', '보통']].map(([k, v]) => `<button data-lv="${k}" class="${ui.create.level === k ? 'sel' : ''}">${v}</button>`).join('')}</div></div>` : ''}
        ${isHost() && n < r.max ? '<div class="muted" style="margin-top:6px">빈 자리는 AI로 채울 수 있어요. 친구가 들어오면 AI가 자리를 비켜줍니다.</div>' : ''}</div>
      <div class="stack">
        ${isHost() ? `<button class="btn-primary" style="padding:16px;font-size:18px" data-act="start" ${enough ? '' : 'disabled'}>${enough ? '게임 시작' : `인원 부족 (${need} 필요)`}</button>` : '<div class="panel" style="text-align:center">방장이 게임을 시작하길 기다리는 중…</div>'}
        <div class="row"><button class="btn-ghost" data-act="rules">📖 규칙</button><button class="btn-ghost" data-act="board">🏆 점수판</button></div>
        <button class="btn-ghost" data-act="leave">방 나가기</button>
      </div>
      <p class="notice">${DISCLAIMER} · 처음 ${won(r.startChips)} · 0원이 되면 300,000원으로 다시 시작</p>
    </div>${modalHTML()}`;
  }

  const muteBtn = (cls) => `<button class="btn-ghost snd ${cls || ''}" data-act="mute" aria-label="소리 켜기/끄기" title="소리 켜기/끄기">${FX.isMuted() ? '🔇' : '🔊'}</button>` + bgmBtn(cls ? cls + ' bgm' : '');
  const bgmBtn = (cls) => `<button class="btn-ghost snd bgmb ${cls || ''} ${FX.isBgmOn() && !FX.isMuted() ? '' : 'off'}" data-act="bgm" aria-label="배경음악 켜기/끄기" title="배경음악 켜기/끄기">🎵</button>`;
  // ---------- 턴 타이머 (TIMER_V1) ----------
  // 서버가 준 남은 시간(ms) 기준. 막대는 CSS 애니메이션(다시 그려도 이어지게 음수 delay), 숫자·빨간색·틱 소리는 0.2초마다
  const ttLeft = () => (ui.turnAt ? ui.turnAt.deadline - Date.now() : 0);
  function timerBar(pid) {
    const t = ui.turnAt;
    if (!t || t.pid !== pid) return '';
    const left = ttLeft();
    return `<div class="tt-bar ${left <= 3000 ? 'hot' : ''}"><i style="animation-duration:${t.total}ms;animation-delay:${Math.round(left - t.total)}ms"></i></div>`;
  }
  function myTimerHTML() {
    const t = ui.turnAt;
    if (!t || !S || t.pid !== S.me) return '';
    const sec = Math.max(0, Math.ceil(Math.min(ttLeft(), t.total) / 1000));
    return `<div class="tt-me ${sec <= 3 ? 'hot' : ''}"><span data-tt>${sec}</span><small>초</small></div>`;
  }
  let ttLastSec = null;
  setInterval(() => {
    const t = ui.turnAt;
    if (!t) { ttLastSec = null; return; }
    const left = ttLeft();
    const sec = Math.max(0, Math.ceil(Math.min(left, t.total) / 1000));
    document.querySelectorAll('[data-tt]').forEach((el) => { el.textContent = sec; el.parentNode.classList.toggle('hot', sec <= 3); });
    document.querySelectorAll('.tt-bar').forEach((el) => el.classList.toggle('hot', left <= 3000));
    if (S && t.pid === S.me && sec !== ttLastSec && sec > 0 && sec <= 3 && left <= t.total) { try { FX.beep(sec === 1 ? 1320 : 990, 0.07); } catch (e) {} }
    ttLastSec = sec;
  }, 200);

  // ---------- 채팅 (CHAT_V1) ----------
  // 서랍(오버레이)은 #app 밖에 따로 둠 → 게임 화면이 다시 그려져도 입력 중인 글이 지워지지 않음
  const QUICK = ['빨리 치세요~', '잘 쳤다!', '아쉽다 ㅠㅠ', '한 판 더?', '나이스!', '감사합니다', '👍', '😂', '😭', '🔥', '👏'];
  ui.chat = []; ui.unread = 0;
  const chatRoot = document.createElement('div'); chatRoot.id = 'chat-root'; document.body.appendChild(chatRoot);
  function chatBtn() { return `<button class="btn-ghost chat-btn" data-act="chat">💬${ui.unread ? `<span class="badge">${ui.unread > 9 ? '9+' : ui.unread}</span>` : ''}</button>`; }
  function chatLine(m) {
    if (m.sys) return `<div class="cl sys">${esc(m.text)}</div>`;
    const mine = S && m.pid === S.me;
    return `<div class="cl ${mine ? 'me' : ''}">${mine ? '' : `<b>${esc(m.name)}</b>`}<span>${esc(m.text)}</span></div>`;
  }
  function drawChat() {
    if (!ui.chatOpen || !S) { chatRoot.innerHTML = ''; return; }
    let list = chatRoot.querySelector('.chat-list');
    if (!list) {
      chatRoot.innerHTML = `<div class="chat-bg" data-chat="close"></div><div class="chat-drawer"><div class="chat-hd"><b>💬 채팅</b><button class="btn-ghost" data-chat="close">닫기</button></div>
        <div class="chat-list"></div><div class="chat-quick">${QUICK.map((q) => `<button data-quick="${esc(q)}">${esc(q)}</button>`).join('')}</div>
        <form class="chat-in"><input id="chat-text" maxlength="100" autocomplete="off" enterkeyhint="send" placeholder="메시지 (최대 100자)"><button class="btn-primary">보내기</button></form></div>`;
      list = chatRoot.querySelector('.chat-list');
      chatRoot.querySelector('.chat-in').addEventListener('submit', (ev) => { ev.preventDefault(); const i = document.getElementById('chat-text'); sendChat(i.value, () => { i.value = ''; }); });
    }
    list.innerHTML = ui.chat.length ? ui.chat.map(chatLine).join('') : '<div class="cl sys">아직 대화가 없어요. 아래 버튼으로 인사해 보세요!</div>';
    list.scrollTop = list.scrollHeight;
  }
  function sendChat(text, done) {
    text = String(text || '').trim(); if (!text) return;
    socket.emit('chat', { text }, (r) => { if (r && !r.ok) toast(r.error || '보내지 못했어요'); else if (done) done(); });
  }
  chatRoot.addEventListener('click', (ev) => {
    const q = ev.target.closest('[data-quick]'); if (q) { sendChat(q.dataset.quick); return; }
    if (ev.target.closest('[data-chat="close"]')) { ui.chatOpen = false; drawChat(); }
  });
  function setUnread(n) { ui.unread = n; const b = document.querySelector('.chat-btn'); if (b) b.outerHTML = chatBtn(); }
  // 말풍선: 보낸 사람 자리 위에 3초
  function bubble(m) {
    const el = document.querySelector(`[data-pid="${CSS.escape(m.pid)}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const b = document.createElement('div');
    b.className = 'chat-bubble';
    b.textContent = m.text;
    document.body.appendChild(b);
    const w = b.offsetWidth;
    b.style.left = Math.max(4, Math.min(innerWidth - w - 4, r.left + r.width / 2 - w / 2)) + 'px';
    const hb = (document.querySelector('.hdr') || { getBoundingClientRect: () => ({ bottom: 0 }) }).getBoundingClientRect().bottom;
    const above = r.top - b.offsetHeight - 4;
    b.style.top = (above >= hb + 2 ? above : Math.min(r.top + 6, innerHeight - b.offsetHeight - 4)) + 'px'; // 위에 자리가 없으면(맨 위 자리) 자리 안쪽 위에
    setTimeout(() => b.classList.add('out'), 2700);
    setTimeout(() => b.remove(), 3100);
  }
  socket.on('chatHistory', (h) => { if (!h) return; ui.chatRoom = h.code; ui.chat = h.list || []; drawChat(); });
  socket.on('chat', (m) => {
    if (!m || !S) return;
    ui.chat = ui.chat.concat(m).slice(-50);
    if (!m.sys) {
      if (m.pid !== S.me) { try { FX.beep(1560, 0.04); } catch (e) {} }
      if (!ui.chatOpen && m.pid !== S.me) setUnread(ui.unread + 1);
      bubble(m);
    }
    drawChat();
  });

  function header() {
    const r = S.room;
    const g = S.game;
    let extra = '';
    if (g && g.kind !== 'seotda' && g.mult > 1) extra = ` · x${g.mult}`;
    const nsp = (r.spectators || []).length;
    return `<div class="hdr"><div class="t">🎴 ${esc(r.gameName)} · ${esc(r.code)}${r.round ? ` · ${r.round}판` : ''}${extra}${nsp ? ` · 👀${nsp}` : ''}</div>${muteBtn()}<button class="btn-ghost" data-act="rules" aria-label="규칙">📖</button><button class="btn-ghost" data-act="board" aria-label="점수판">🏆</button>${chatBtn()}${exitBtn()}</div>`;
  }
  // 나가기 (EXIT_V1, 한게임식 나가기 예약): 판 중이면 예약/취소, 판이 아니면 바로 나감
  const myRoomP = () => S && S.room.players.find((p) => p.id === S.me);
  const inMyRound = () => !!(S && S.room.status === 'playing' && S.game && !S.game.result && myRoomP() && myRoomP().playing);
  function exitBtn() {
    if (S.spectator) return '';
    const me = myRoomP();
    const on = !!(me && me.leaveReserved);
    return `<button class="btn-ghost exit-btn ${on ? 'on' : ''}" data-act="exitRoom">${on ? '나가기<br>예약됨' : '나가기'}</button>`;
  }
  // 긴 이름(최대 12자)은 글자를 조금 작게 해서 자리 안에 전부 보이게 (말줄임 대신)
  const nmCls = (n) => { const L = [...String(n || '')].length; return L >= 11 ? 'nm-xl' : L >= 9 ? 'nm-l' : L >= 7 ? 'nm-m' : ''; };
  const resvTag = (id) => { const p = S && S.room.players.find((x) => x.id === id); return p && p.leaveReserved ? '<span class="resv-tag">나가기 예약</span>' : ''; };

  function renderGame() {
    const g = S.game;
    let body = g.kind === 'seotda' ? seotdaHTML(g) : gostopHTML(g);
    $app.innerHTML = header() + body + resultHTML() + modalHTML() + myTimerHTML();
  }

  // ---------- 섯다 ----------
  function seotdaHTML(g) {
    const me = g.mySeat;
    const chipsOf = (id) => { const p = S.room.players.find((x) => x.id === id); return p ? p.chips : 0; };
    const others = g.seats.map((s, i) => ({ s, i })).filter((x) => x.i !== me);
    const seatBox = ({ s, i }) => `<div data-seat="${i}" data-pid="${esc(s.id)}" class="sd-seat ${g.turn === i ? 'turn' : ''} ${s.folded ? 'fold' : ''}">${timerBar(s.id)}
        <div style="font-weight:800" class="${nmCls(s.name + (s.folded ? '(다이)' : ''))}">${esc(s.name)}${s.folded ? ' (다이)' : ''}${resvTag(s.id)}</div>
        <div class="muted">${wonC(chipsOf(s.id) - (g.result ? 0 : s.contrib))} · 베팅 ${wonC(s.contrib)}</div>
        <div class="cards">${s.cards.map((c) => sd(c, 'sm' + (c != null ? '' : ''))).join('')}</div>
        <div class="hn">${s.handName ? esc(s.handName) : g.turn === i ? '고민 중…' : ''}</div></div>`;
    let meBox = '', bar = '';
    if (me >= 0) {
      const s = g.seats[me];
      meBox = `<div class="sd-me" data-pid="${esc(s.id)}">${timerBar(s.id)}
        <div class="muted">${esc(s.name)} (나) · 보유 ${wonC(chipsOf(s.id) - (g.result ? 0 : s.contrib))} · 베팅 ${wonC(s.contrib)}${s.folded ? ' · 다이' : ''}</div>
        <div class="cards">${s.cards.map((c, k) => k === 1 && squeezing(g) ? sqCard(g, c) : sd(c, 'lg')).join('')}</div>
        <div class="hn ${squeezing(g) ? 'hid' : ''}">${esc(s.handName || '')}</div></div>`;
    } else { meBox = ''; bar = specBar(g); }
    if (me >= 0 && g.result) bar = resultBar(g);
    if (me >= 0 && !g.result) {
      if (g.options.length) {
        const cls = { die: 'btn-ghost', check: 'btn-blue', bbing: 'btn-blue', call: 'btn-primary', half: 'btn-red', ddadang: 'btn-red' };
        bar = `<div class="turnbar">내 차례! 베팅하세요</div><div class="actbar">${g.options.map((o) => `<button class="${cls[o.type]}" data-bet="${o.type}">${o.label}${o.amount ? `<small>${wonC(o.amount)}</small>` : ''}</button>`).join('')}</div>`;
      } else {
        const t = g.seats[g.turn];
        bar = `<div class="turnbar wait">${t ? esc(t.name) + '님 차례' : ''}</div><div class="actbar idle"><button class="btn-ghost" disabled>기다리는 중…<small>&nbsp;</small></button></div>`;
      }
    }
    return `<div class="sd-seats">${others.map(seatBox).join('')}</div>
      <div class="sd-center"><div class="muted">판돈</div><div class="pot">💰 ${won(g.pot)}</div><div class="muted">현재 베팅 ${wonC(g.currentBet)} · 기본 ${wonC(g.ante)}${g.redeals ? ` · 재경기 ${g.redeals}회` : ''}</div></div>
      ${meBox}<div class="bar">${bar}</div>`;
  }

  const specBar = (g) => !S.spectator ? '<div class="turnbar wait spec">✅ 자리 확보 · 다음 판부터 참여합니다</div><div class="actbar idle"><button class="btn-ghost" disabled>다음 판 기다리는 중…<small>&nbsp;</small></button></div>' : `<div class="turnbar wait spec">👀 관전 중${S.spectator && S.spectator.waiting ? ' · <b>다음 판부터 참여</b>' : ''}${!g.result && g.turn >= 0 ? ` · ${esc((g.players || g.seats)[g.turn].name)} 차례` : ''}</div><div class="actbar"><button class="btn-ghost" data-act="leave">관전 나가기</button></div>`;
  // ---------- 맞고/고스톱 ----------
  function groupCaptured(ids) {
    const groups = { gwang: [], yeol: [], tti: [], pi: [] };
    ids.forEach((id) => { const c = HWATU[id]; (c.type === 'pi' || c.type === 'ssangpi' ? groups.pi : groups[c.type]).push(id); });
    const piVal = groups.pi.reduce((s, id) => s + HWATU[id].piValue, 0);
    return [['광', groups.gwang, groups.gwang.length], ['열', groups.yeol, groups.yeol.length], ['띠', groups.tti, groups.tti.length], ['피', groups.pi, piVal]]
      .filter((x) => x[1].length)
      .map(([lb, arr, cnt]) => `<div class="capg">${arr.map((id) => hw(id, 'sm', `data-cap="${id}"`)).join('')}<span class="cnt">${cnt}</span></div>`).join('');
  }
  function gostopHTML(g) {
    const me = g.mySeat;
    const chipsOf = (id) => { const p = S.room.players.find((x) => x.id === id); return p ? p.chips : 0; };
    const opps = g.players.map((p, i) => ({ p, i })).filter((x) => x.i !== me);
    const oppHTML = opps.map(({ p, i }) => `<div data-seat="${i}" data-pid="${esc(p.id)}" class="opp ${g.turn === i ? 'turn' : ''}">${timerBar(p.id)}
      <div class="nm"><span class="${nmCls(p.name)}">${esc(p.name)}${resvTag(p.id)}</span><span style="color:#ffcf4a">${p.score}점</span></div>
      <div class="meta">🂠 ${p.handCount}장 · ${wonC(chipsOf(p.id))}${p.go ? ` · <b style="color:#ff8a80">${p.go}고</b>` : ''}${p.shakes ? ` · 흔듦${p.shakes}` : ''}${p.ppeok ? ` · 뻑${p.ppeok}` : ''}</div>
      <div class="caps">${groupCaptured(p.captured)}</div><div class="bdg">${badgesHTML(p.captured)}</div></div>`).join('');
    // 힌트: 공개 정보(먹은 패·바닥) + 내 손패만 사용
    const hv = { players: g.players, mySeat: me, floor: g.floor, hand: me >= 0 ? g.players[me].hand || [] : [] };
    const threats = me >= 0 ? H.threats(hv) : [];
    const tags = me >= 0 ? H.handTags(hv) : {};
    const blockFloor = new Set(threats.flatMap((t) => t.onFloor));
    // floor grouped by month
    const byM = {};
    g.floor.forEach((id) => { const m = HWATU[id].m; (byM[m] = byM[m] || []).push(id); });
    const o = g.options;
    // 짝 강조 (MATCH_V2): 같은 달만. 손패↔바닥 둘 다 같은 금색으로.
    //  - 선택 전: 짝 있는 손패와 그 짝 바닥 패에 은은한 금색 테두리
    //  - 선택 후: 고른 패와 그 짝만 밝게 깜빡이며 살짝 들림 (나머지는 평소대로)
    // (예전 버그: 마지막 뒤집은 바닥 패에 붙던 .new 'pop' 애니메이션이 화면을 다시 그릴 때마다 1.4배로 커져서
    //  손패를 고를 때 달이 다른 바닥 패가 커지는 것처럼 보였음 → 크기 애니메이션 제거)
    const playable0 = me >= 0 && o && o.phase === 'play' && !g.result;
    const mm = {};
    if (playable0) for (const c of o.cards) { const f = H.monthMatches(c.id, g.floor, c.matches || []); if (f.length) mm[c.id] = f; }
    if (ui.sel != null && !(playable0 && o.cards.some((c) => c.id === ui.sel))) ui.sel = null;
    const selMatches = ui.sel != null ? mm[ui.sel] || [] : [];
    const softFloor = new Set(ui.sel == null ? Object.values(mm).flat() : []);
    const pendingChoices = me === g.turn && o && o.phase === 'chooseFlip' ? H.monthMatches(o.card, g.floor, o.choices) : [];
    const floorCls = (id) => {
      if (selMatches.includes(id) || pendingChoices.includes(id)) return 'mt on';
      if (softFloor.has(id)) return 'mt';
      return '';
    };
    const floorHTML = Object.keys(byM).map((m) => `<div class="fgrp">${byM[m].map((id) => hw(id, floorCls(id) + (id === g.lastFlip ? ' lastf' : '') + (blockFloor.has(id) ? ' blk' : ''), `data-floor="${id}" data-m="${HWATU[id].m}"`)).join('')}</div>`).join('');
    let mineHTML = '', handHTML = '', bar = '';
    const idleBar = '<div class="actbar idle"><button class="btn-ghost" disabled>기다리는 중…<small>&nbsp;</small></button></div>';
    if (me >= 0) {
      const p = g.players[me];
      mineHTML = `<div class="mine" data-pid="${esc(p.id)}">${timerBar(p.id)}<div class="nm"><span>${esc(p.name)} (나) · ${wonC(chipsOf(p.id))}${p.go ? ` · <b style="color:#ff8a80">${p.go}고</b>` : ''}${p.shakes ? ` · 흔듦${p.shakes}` : ''}${p.bombFlips ? ` · 폭탄패 ${p.bombFlips}` : ''}</span><span style="color:#ffcf4a">${p.score}점 / ${g.target}점</span></div><div class="caps">${groupCaptured(p.captured) || '<span class="muted">아직 먹은 패 없음</span>'}</div><div class="bdg">${badgesHTML(p.captured)}</div></div>`;
      const playable = o && o.phase === 'play';
      const sorted = (p.hand || []).slice().sort((a, b) => (HWATU[a].m || 13) - (HWATU[b].m || 13) || a - b);
      handHTML = `<div class="hand">${sorted.map((id) => {
        const oc = playable ? o.cards.find((c) => c.id === id) : null;
        const has = !!mm[id];
        const cls = (ui.sel === id ? 'sel' + (has ? ' mt on' : '') : has && ui.sel == null ? 'mt' : '') + (!playable ? ' dim' : '');
        const t = (tags[id] || [])[0];
        const tagHTML = t ? `<span class="ht ht-${t.key}${t.kind === 'block' ? ' blk' : ''}${t.near ? ' near' : ''}">${t.label}</span>` : '';
        return hw(id, cls + (t && t.kind === 'block' ? ' blkh' : ''), `data-hand="${id}" data-m="${HWATU[id].m}"`, tagHTML);
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
    } else bar = specBar(g);
    if (me >= 0 && g.result) bar = resultBar(g);
    return `<div class="opps">${oppHTML}</div>
      <div class="floor-wrap">${threats.length ? `<div class="warns">${threats.slice(0, 3).map((t) => `<div class="warn">⚠️ ${esc(t.name)} ${t.set} 1장 남음${t.blockers.length || t.inHand.length ? ' · <b>막기 가능</b>' : ''}</div>`).join('')}</div>` : ''}
        <div class="deck">${g.deckCount ? hw(null, 'sm') : '<div class="card sm empty"></div>'}<span>남은 패<br><b>${g.deckCount}</b>장</span>${g.lastFlip != null ? `<span class="lf">뒤집은 패</span>${hw(g.lastFlip, 'sm lfc')}` : ''}</div>
        <div class="floor">${floorHTML || '<span class="muted">바닥이 비었습니다</span>'}</div></div>
      ${mineHTML}${handHTML}<div class="bar">${bar}</div>`;
  }

  // ---------- 연출 (SHOW_V1) ----------
  // 족보 완성 → 큰 도장 (엔진이 실제로 계산한 족보만: shared/hints completed)
  const YAKU_STAMP = { '고도리': ['고도리'], '홍단': ['홍단'], '청단': ['청단'], '초단': ['초단'], '3광': ['삼광'], '비광 3광': ['삼광', '비광 포함', '비삼광'], '4광': ['사광'], '5광': ['오광'] };
  // 엔진 이벤트 문구 → 도장 (lib/gostop.js events 그대로. 없는 이벤트는 만들지 않음)
  function eventStamp(e, g) {
    const m = /^(.+?): (.+)$/.exec(e);
    if (!m) return null;
    const who = g.players[g.mySeat] && g.players[g.mySeat].name === m[1] ? '나' : m[1], t = m[2];
    let r = null;
    if (/^(\d+)고!/.test(t)) { const n = /^(\d+)고!/.exec(t)[1]; r = { text: n + '고!', kind: 'go', say: n + '고' }; }
    else if (/^스톱!/.test(t)) r = { text: '스톱!', kind: 'stop', say: '스톱' };
    else if (/^3뻑!/.test(t)) r = { text: '삼뻑!', kind: 'gold', say: '삼뻑' };
    else if (/^뻑 먹기!/.test(t)) r = { text: '뻑 먹기!', kind: 'good', say: '뻑 먹기' };
    else if (/^뻑!/.test(t)) r = { text: '뻑!', kind: 'bad', say: '뻑' };
    else if (/^따닥!/.test(t)) r = { text: '따닥!', kind: 'good', say: '따닥' };
    else if (/^쪽!/.test(t)) r = { text: '쪽!', kind: 'good', say: '쪽' };
    else if (/^싹쓸이!/.test(t)) r = { text: '싹쓸이!', kind: 'good', say: '싹쓸이' };
    else if (/^폭탄!/.test(t)) r = { text: '폭탄!', kind: 'gold', say: '폭탄' };
    else if (/^흔들기!/.test(t)) r = { text: '흔들기!', kind: 'good', say: '흔들기' };
    if (r) r.sub = who;
    return r;
  }
  // 새 판 시작: 맞고/고스톱은 선 정하기(서버가 정한 결과 그대로) → '판 시작' 도장 → 셔플·패 돌리기
  function startIntro(g) {
    if (g.kind === 'seotda' || !g.seon || !FX.canAnimate || SH.reduced) { if (g.kind !== 'seotda' && g.seon) SH.stamp('판 시작', 'start', { say: '시작', dur: 600 }); return startDeal(g); }
    cancelAnim();
    const round = S.room.round, seq = S.room.actSeq, sn = g.seon;
    ['.hand .card', '.floor .card', '.deck > .card.back', '.mine .bdg', '.opp .bdg'].forEach(hideSel);
    anim.dealing = true; // 탭하면 건너뛰기
    const nm = (i) => (i === g.mySeat ? '나' : g.players[i].name);
    const o = sn.reason === 'draw'
      ? { title: '선 정하기', rows: sn.draws.map((d) => ({ name: nm(d.seat), face: hw(d.card), win: d.seat === sn.seat })), note: `가장 높은 달 <b>${HWATU[sn.draws[sn.seat].card].m}월</b> — <b>${esc(nm(sn.seat))}</b>${sn.seat === g.mySeat ? '가' : '님이'} 선!` }
      : { title: '이번 판 선', note: `지난 판 승리 <b>${esc(nm(sn.seat))}</b>${sn.seat === g.mySeat ? '가' : '님이'} 선이에요` };
    SH.seon(o, () => {
      if (!S || !S.game || S.room.round !== round || S.room.actSeq !== seq) return;
      startDeal(S.game);
    });
  }
  // 섯다 결과: 상대 패를 차례로 뒤집고, 이긴 족보를 큰 도장으로
  function showdown(g) {
    FX.tak();
    const res = g.result;
    const els = [...document.querySelectorAll('.sd-seat .cards .card')];
    els.forEach((e, k) => { e.style.animationDelay = (k * 120) + 'ms'; e.classList.add('rv'); });
    const hand = (res.winnerHands || [])[0];
    if (hand) {
      const big = /땡|광|암행어사|땡잡이|알리|독사|구삥|장삥|장사|세륙/.test(hand);
      SH.stamp(hand, big ? 'gold' : 'good', { sub: res.winners.includes(S.me) ? '나' : (res.winnerNames || [])[0], delay: 350 + els.length * 120 });
    }
  }
  // 결과 카드가 처음 뜰 때 한 번: 승리(꽃가루·동전)/패배(잔잔)/나가리 배너 + 돈 숫자 올라가기 + 박 도장
  function resultIntro() {
    const ov = document.querySelector('.res-ov');
    if (!ov || !ui.resHold || ui.resHold.key !== resKey() || ui.resIntroKey === resKey()) return;
    ui.resIntroKey = resKey();
    const res = S.game.result, myD = res.chipDelta[S.me];
    let kind = 'win', text = '승리!', sub = '';
    if (res.nagari) { kind = 'draw'; text = '나가리'; sub = '다음 판 점수 2배'; }
    else if (res.winners.includes(S.me)) { text = '승리!'; }
    else if (myD != null) { kind = 'lose'; text = '패배'; sub = `${res.winnerNames.join(', ')} 승리`; }
    else { text = '승리!'; sub = res.winnerNames.join(', '); }
    if (!sub && res.game !== 'seotda' && res.points) sub = `${res.points}점`;
    if (!sub && res.game === 'seotda' && res.winnerHands && res.winnerHands.length) sub = res.winnerHands[0];
    ov.classList.add('intro');
    SH.endBanner(kind, text, sub);
    const card = ov.querySelector('.res-card'); if (card && kind === 'lose') card.classList.add('intro-lose');
    // 돈 숫자 올라가기: 화면을 다시 그려도 이어지도록 시작 시각만 기억하고 매 프레임 DOM에서 찾아 갱신
    if (!SH.reduced) {
      ui.count = { key: resKey(), t0: performance.now() + 800, dur: 1000 };
      let lastCoin = 0;
      const f = (now) => {
        if (!ui.count || ui.count.key !== resKey()) return;
        document.querySelectorAll('.res-ov .rm-d[data-d]').forEach((el) => { el.textContent = fmtDelta(Number(el.dataset.d)); });
        const my = document.querySelector('.res-ov .res-my[data-d]'); if (my) my.textContent = '내 돈 ' + fmtW(countVal(Number(my.dataset.d)));
        const k = (now - ui.count.t0) / ui.count.dur;
        if (k > 0 && k < 1 && now - lastCoin > 120) { lastCoin = now; FX.coin(0.35); }
        if (k < 1) requestAnimationFrame(f); else ui.count = null;
      };
      requestAnimationFrame(f);
    }
    // 박 (광박·피박·고박) — 엔진이 붙인 것만
    const baks = [];
    (res.losers || []).forEach((l) => l.tags.forEach((tg) => { const b = /^(광박|피박|고박)/.exec(tg); if (b) baks.push([b[1], l.name]); }));
    baks.slice(0, 3).forEach(([b, n], k) => SH.stamp(b + '!', 'bad', { sub: n === (meP() || {}).name ? '나' : n, delay: k ? 0 : 1600, dur: 800 }));
  }
  function countVal(d) {
    if (!ui.count || ui.count.key !== resKey()) return d;
    const k = Math.max(0, Math.min(1, (performance.now() - ui.count.t0) / ui.count.dur));
    return Math.round(d * (1 - Math.pow(1 - k, 3)));
  }
  const fmtDelta = (d) => { const v = countVal(d); return (v > 0 ? '+' : '') + (Math.abs(d) >= 1e8 ? wonC(v) : won(v)); };
  // 섯다 패 조이기: 내 두 번째 패를 끌어올리거나(드래그) 탭하면 천천히 보임
  const sqKey = (g) => S.room.code + ':' + S.room.round + ':' + (g.redeals || 0);
  const squeezing = (g) => !!(g.mySeat >= 0 && !g.result && !g.seats[g.mySeat].folded && g.seats[g.mySeat].cards[1] != null && !ui.sqDone[sqKey(g)]);
  function sqCard(g, c) {
    const p = ui.sqP[sqKey(g)] || 0;
    const d = SEOTDA[c];
    return cardHTML(d, 'lg sq', 'data-sq="1"', (d.m - 1) * 4 + (c % 2), `<div class="sq-cover" style="transform:translateY(${(-p * 100).toFixed(1)}%)"></div>${p < 0.05 ? '<span class="sq-hint">▲ 밀어서 조이기</span>' : ''}`);
  }
  function sqSet(p) {
    const g = S && S.game; if (!g || g.kind !== 'seotda') return;
    ui.sqP[sqKey(g)] = p;
    const cv = document.querySelector('.sq .sq-cover'); if (cv) cv.style.transform = `translateY(${(-p * 100).toFixed(1)}%)`;
    const h = document.querySelector('.sq .sq-hint'); if (h && p > 0.05) h.remove();
  }
  function sqFinish() {
    const g = S && S.game; if (!g || g.kind !== 'seotda') return;
    const k = sqKey(g);
    if (ui.sqDone[k]) return;
    ui.sqDone[k] = true;
    FX.tak(0.8);
    const s = g.seats[g.mySeat];
    if (s && s.handName && /땡|광/.test(s.handName)) SH.stamp(s.handName, 'gold', { sub: '내 패', delay: 100 });
    render();
  }
  function sqAuto(from) { // 탭: 0.9초 동안 천천히 조여서 공개
    const t0 = performance.now(), k = sqKey(S.game);
    const f = (now) => {
      if (!S || !S.game || S.game.kind !== 'seotda' || sqKey(S.game) !== k || ui.sqDone[k]) return;
      const e = Math.min(1, (now - t0) / 900), p = from + (1 - from) * (e * e * (3 - 2 * e));
      sqSet(p); if (Math.random() < 0.15) FX.rub();
      if (e < 1) requestAnimationFrame(f); else sqFinish();
    };
    requestAnimationFrame(f);
  }
  (function sqInput() {
    let drag = null;
    document.addEventListener('pointerdown', (ev) => {
      const el = ev.target.closest && ev.target.closest('.sq');
      if (!el || !S || !S.game) return;
      const h = el.getBoundingClientRect().height;
      drag = { y: ev.clientY, h, p0: ui.sqP[sqKey(S.game)] || 0, moved: 0, lastRub: 0 };
      try { el.setPointerCapture(ev.pointerId); } catch (e) {}
    });
    document.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const dy = drag.y - ev.clientY;
      drag.moved = Math.max(drag.moved, Math.abs(dy));
      const p = Math.max(0, Math.min(1, drag.p0 + dy / (drag.h * 1.1)));
      sqSet(p);
      if (Date.now() - drag.lastRub > 90 && drag.moved > 4) { drag.lastRub = Date.now(); FX.rub(); }
      if (ev.cancelable) ev.preventDefault();
    }, { passive: false });
    const up = () => {
      if (!drag || !S || !S.game) { drag = null; return; }
      const p = ui.sqP[sqKey(S.game)] || 0, d = drag; drag = null;
      if (p > 0.6) sqAuto(p); else if (d.moved < 6) sqAuto(p);
    };
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', () => { drag = null; });
  })();

  // ---------- 결과 (RESULT_V2) ----------
  const resKey = () => (S ? S.room.code + ':' + S.room.round : '');
  const resHolding = () => !!(ui.resHold && S && S.game && S.game.result && ui.resHold.key === resKey() && Date.now() < ui.resHold.until);
  // 받침에 맞는 조사 '으로/로' (ㄹ받침·받침 없음 → 로)
  const euro = (w) => { const c = String(w || '').charCodeAt(String(w || '').length - 1) - 0xac00; if (c < 0 || c > 11171) return '(으)로'; const j = c % 28; return j === 0 || j === 8 ? '로' : '으로'; };
  function resTitle(res) {
    if (res.nagari) return { emoji: '😮', text: '나가리', cls: 'draw' };
    if (res.winners.includes(S.me)) return { emoji: '🎉', text: '내가 이겼다!', cls: 'win' };
    const my = res.chipDelta[S.me];
    return { emoji: my != null ? '😢' : '🏆', text: `${res.winnerNames.join(', ')} 승리`, cls: my != null ? 'lose' : 'win' };
  }
  function resultBar(g) {
    const t = resTitle(g.result);
    return `<div class="turnbar res-bar">🏁 판 끝 · ${t.emoji} ${esc(t.text)}</div><div class="actbar"><button class="btn-ghost" data-act="showRes">결과 보기</button>${isHost() ? '<button class="btn-primary" data-act="next">다음 판</button>' : ''}</div>`;
  }
  function resultHTML() {
    const g = S.game, r = S.room;
    if (!g || !g.result || r.status !== 'result') return '';
    const res = g.result;
    const t = resTitle(res);
    if (resHolding()) return `<div class="end-ribbon ${t.cls}">🏁 판 끝! <b>${esc(t.text)}</b><small>탭하면 바로 결과</small></div>`;
    if (ui.resClosed === resKey()) return '';
    const myDelta = res.chipDelta[S.me];
    let how = '', body = '';
    if (res.game === 'seotda') {
      how = res.reason ? esc(res.reason) : res.winnerHands && res.winnerHands.length ? `<b>${esc(res.winnerHands.join(' · '))}</b>${euro(res.winnerHands[res.winnerHands.length - 1])} 승리` : '';
      const rows = res.reveal.slice().sort((x, y) => (res.winners.includes(y.id) - res.winners.includes(x.id)) || (y.eff || 0) - (x.eff || 0)).map((x) => `<div class="rs-row ${res.winners.includes(x.id) ? 'w' : ''}"><span class="rs-cards">${x.cards.map((c) => sd(c, 'xs')).join('')}</span><span class="rs-nm">${res.winners.includes(x.id) ? '👑 ' : ''}${esc(x.name)}</span><span class="rs-hand">${esc(x.hand)}</span></div>`).join('');
      const folded = (res.folded || []).length ? `<div class="rs-row fold"><span class="rs-nm">${res.folded.map((f) => esc(f.name)).join(', ')}</span><span class="rs-hand">다이</span></div>` : '';
      body = `<div class="res-sec">${rows}${folded}<div class="res-pot">판돈 <b>${won(res.pot)}</b></div></div>`;
    } else if (res.nagari) {
      how = '아무도 점수를 못 냈어요';
      body = `<div class="res-sec res-nagari">다음 판 점수 <b>2배</b>!</div>`;
    } else {
      const extra = [];
      if (res.go) extra.push(`${res.go}고`);
      if (res.shakes) extra.push(`흔들기/폭탄 ${res.shakes}번`);
      if (res.nagariMult > 1) extra.push(`나가리 x${res.nagariMult}`);
      how = `<b>${res.points}점</b> × 점당 ${won(res.perPoint)}${extra.length ? ' · ' + extra.join(' · ') : ''}`;
      const lines = (res.scoreLines || []).map((l) => `<span class="rc">${esc(l.label)} <b>${l.pts}점</b></span>`);
      if (res.threePpeok) lines.push('<span class="rc hot">3뻑 승리</span>');
      if (res.go) lines.push(`<span class="rc hot">${res.go}고 ${res.go >= 3 ? `x${Math.pow(2, res.go - 2)}` : `+${res.go}점`}</span>`);
      if (res.shakes) lines.push(`<span class="rc hot">흔들기 x${Math.pow(2, res.shakes)}</span>`);
      if (res.nagariMult > 1) lines.push(`<span class="rc hot">나가리 x${res.nagariMult}</span>`);
      const losers = (res.losers || []).map((l) => `<div class="rs-row"><span class="rs-nm">${esc(l.name)}</span><span class="rs-tags">${l.tags.length ? l.tags.map((x) => `<span class="bak">${esc(x)}</span>`).join('') : '<span class="muted">박 없음</span>'}${l.mult > 1 ? ` <b>x${l.mult}</b>` : ''}</span></div>`).join('');
      body = `<div class="res-sec"><div class="res-lbl">${esc(res.winnerNames[0])}님 점수</div><div class="res-chips">${lines.join('')}</div></div>${losers ? `<div class="res-sec"><div class="res-lbl">박 · 배수</div>${losers}</div>` : ''}`;
    }
    const order = Object.entries(res.chipDelta).sort((a, b) => b[1] - a[1]);
    const money = order.map(([id, d]) => {
      const p = r.players.find((x) => x.id === id);
      const gp = (g.players || g.seats || []).find((x) => x.id === id);
      const bal = p ? p.chips : 0;
      const W = (n) => (Math.abs(n) >= 1e8 ? wonC(n) : won(n));
      return `<div class="rm-row ${id === S.me ? 'me' : ''}"><span class="rm-nm">${esc(p ? p.name : gp ? gp.name : '?')}${id === S.me ? ' (나)' : ''}</span><span class="rm-d ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}" data-d="${d}">${fmtDelta(d)}</span><span class="rm-b">→ ${W(bal)}</span></div>`;
    }).join('');
    const btns = isHost()
      ? '<button class="btn-primary" data-act="next">다음 판</button><button class="btn-ghost" data-act="closeRes">판 보기</button><button class="btn-ghost" data-act="toLobby">대기실로</button>'
      : '<button class="btn-primary" data-act="closeRes">확인</button>';
    return `<div class="res-ov"><div class="res-card ${t.cls}">
      <div class="res-head"><div class="res-emoji">${t.emoji}</div><h2>${esc(t.text)}</h2>${how ? `<div class="res-how">${how}</div>` : ''}
        ${myDelta != null ? `<div class="res-my ${myDelta > 0 ? 'pos' : myDelta < 0 ? 'neg' : ''}" data-d="${myDelta}">내 돈 ${fmtW(countVal(myDelta))}</div>` : ''}</div>
      <div class="res-body">${body}<div class="res-sec res-money"><div class="res-lbl">돈 정산</div>${money}</div></div>
      <div class="res-btns">${btns}</div>
      ${!isHost() ? '<div class="res-wait">방장이 다음 판을 시작하면 바로 이어져요</div>' : ''}
      <p class="notice res-note">${DISCLAIMER}.</p></div></div>`;
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
    // 이름 바꾸기 (RENAME_V1): 로그인한 이 기기에서만. PIN 있는 계정은 지금 PIN 확인
    if (m.type === 'rename' && ui.acct) {
      return `<div class="modal-bg"><div class="modal rename-form acct-form"><h2>✏️ 이름 바꾸기</h2>
        <div class="muted">지금 이름: <b>${esc(ui.acct.nickname)}</b></div>
        <input id="rn-new" maxlength="12" placeholder="새 이름 (최대 12자)" autocomplete="off" enterkeyhint="done" value="${esc(m.val != null ? m.val : ui.acct.nickname)}">
        ${ui.acct.hasPin ? `<input id="rn-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="지금 PIN 4자리" class="pin-in" value="${esc(m.pin || '')}">` : ''}
        ${m.msg ? `<div class="login-msg err">${esc(m.msg)}</div>` : ''}
        <p class="muted" style="font-size:12px">돈·순위·PIN·이 기기 자동 입장은 그대로예요. 이름은 10분에 한 번 바꿀 수 있고, 옛 이름은 다른 사람이 쓸 수 있게 돼요.</p>
        <div class="btns"><button class="btn-primary" data-act="saveRename">바꾸기</button><button class="btn-ghost" data-act="close">취소</button></div></div></div>`;
    }
    // 전적 자세히 (게임별)
    if (m.type === 'rec' && ui.acct) {
      const st = ui.acct.stats || {};
      const row = (label, t) => `<tr><td>${label}</td><td>${t ? t.w : 0}</td><td>${t ? t.d : 0}</td><td>${t ? t.l : 0}</td><td>${recN(t) ? rateOf(t) + '%' : '-'}</td></tr>`;
      return `<div class="modal-bg"><div class="modal"><h2>📊 ${esc(ui.acct.nickname)} 전적</h2>
        <table class="board rec-table"><tr><th>게임</th><th>승</th><th>무</th><th>패</th><th>승률</th></tr>
        ${['gostop', 'matgo', 'seotda'].map((g) => row(GNAME[g], st[g])).join('')}${row('<b>전체</b>', st.total)}</table>
        <p class="muted" style="font-size:12px">한 판 끝날 때마다 기록돼요. 나가리·섯다 동점(판돈 나눔)은 무, AI는 기록 안 해요. 승률 = 승 ÷ 전체 판.</p>
        <div class="btns"><button class="btn-ghost" data-act="close">닫기</button></div></div></div>`;
    }
    // 계정 삭제 (DELETE_V1): 지금 이름을 똑같이 입력 + PIN 있는 계정은 지금 PIN
    if (m.type === 'delAcct' && ui.acct) {
      return `<div class="modal-bg"><div class="modal del-form acct-form"><h2 style="color:#ff8a8a">⚠️ 계정 삭제</h2>
        <p style="font-size:14px;line-height:1.45"><b>${esc(ui.acct.nickname)}</b> 계정의 돈 <b>${won(ui.acct.balance)}</b>, 기록, 순위가 <b style="color:#ff8a8a">영구히 삭제</b>되고 <b>되돌릴 수 없어요.</b> 이 이름은 다른 사람이 쓸 수 있게 돼요.</p>
        <input id="del-name" maxlength="12" placeholder="확인: 지금 이름 '${esc(ui.acct.nickname)}' 입력" autocomplete="off" value="${esc(m.val || '')}">
        ${ui.acct.hasPin ? `<input id="del-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="지금 PIN 4자리" class="pin-in" value="${esc(m.pin || '')}">` : ''}
        ${m.msg ? `<div class="login-msg err">${esc(m.msg)}</div>` : ''}
        <div class="btns"><button class="btn-red" data-act="doDelete">영구 삭제</button><button class="btn-ghost" data-act="close">취소</button></div></div></div>`;
    }
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
    return `<div class="modal-bg" data-act="close"><div class="modal" data-stop="1"><h2>🏆 점수판 (가상 머니)</h2>
      <table class="sb"><tr><th>#</th><th>이름</th><th>승</th><th>가진 돈</th><th>이 방 증감</th></tr>
      ${ps.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td>${p.wins}</td><td class="chip ${p.chips < 0 ? 'neg' : ''}">${wonC(p.chips)}</td><td>${fmtWC(p.net || 0)}</td></tr>`).join('')}</table>
      <h4 style="margin:14px 0 6px">최근 판</h4>
      <div class="muted">${r.history.length ? r.history.slice().reverse().map((h) => `${h.round}판: ${esc(h.summary)}`).join('<br>') : '아직 기록이 없습니다'}</div>
      ${specList()}${hostPrivChk()}
      <div class="btns">${isHost() && r.status !== 'playing' ? '<button class="btn-red" data-act="reset">기록 초기화</button>' : ''}<button class="btn-ghost" data-act="close">닫기</button></div>
      <p class="notice" style="margin:8px 0 0">${DISCLAIMER}.</p></div></div>`;
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
      <h4>고/스톱 · 박</h4><ul><li>1고 +1점, 2고 +2점, 3고부터 2배씩</li><li><b>광박</b>: 광으로 났는데 상대 광 0장 → 2배</li><li><b>피박</b>: 피로 났는데 상대 피 5장 이하 → 2배</li><li><b>고박</b>: 고 한 사람이 역전당하면 ${game === 'matgo' ? '2배' : '혼자 모두 물어줌'}</li><li><b>나가리</b>: 아무도 못 나면 다음 판 2배 (최대 8배)</li><li>정산: 점수 × 점당 금액 × 배수, 진 사람이 이긴 사람에게 (가상 머니)</li></ul>`;
    return `<div class="modal-bg" data-act="close"><div class="modal rules" data-stop="1"><h2>📖 ${esc(S ? S.room.gameName : '')} 규칙</h2>${html}<p class="notice">${DISCLAIMER}.</p><div class="btns"><button class="btn-ghost" data-act="close">닫기</button></div></div></div>`;
  }

  // ---------- 공유 ----------
  async function share() {
    const r = S.room;
    const url = location.origin + '/?room=' + r.code;
    const text = `🎴 혁게임 ${r.gameName} 한 판 하자! 방 코드 ${r.code} (가상 머니 게임)`;
    if (navigator.share) {
      try { await navigator.share({ title: '혁게임', text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
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

  // (PC) 손패에 마우스를 올리면 먹을 수 있는 바닥 패 강조
  // 터치폰에서는 탭할 때 가짜 mouseover가 생겨 강조가 남으므로, 진짜 마우스(hover 가능)일 때만
  const canHover = !!(window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches);
  $app.addEventListener('mouseover', (ev) => {
    if (!canHover) return;
    const h = ev.target.closest('[data-hand]');
    document.querySelectorAll('.floor .card.hov').forEach((e) => e.classList.remove('hov'));
    if (!h || ui.sel != null) return;
    const c = HWATU[Number(h.dataset.hand)];
    if (!c || c.bonus || !c.m) return;
    document.querySelectorAll('.floor [data-floor]').forEach((e) => { const f = HWATU[Number(e.dataset.floor)]; if (f && !f.bonus && f.m === c.m) e.classList.add('hov'); });
  });
  // 입장 화면: 키보드 '이동/엔터'로 바로 입장
  $app.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    if (ev.target.closest('.login')) { ev.preventDefault(); const b = document.querySelector('[data-act="enter"]'); if (b) b.click(); }
    else if (ev.target.closest('.rename-form')) { ev.preventDefault(); const b = document.querySelector('[data-act="saveRename"]'); if (b) b.click(); }
    else if (ev.target.closest('.del-form')) { ev.preventDefault(); const b = document.querySelector('[data-act="doDelete"]'); if (b) b.click(); }
    else if (ev.target.closest('.pin-form')) { ev.preventDefault(); const b = document.querySelector('[data-act="savePin"]'); if (b) b.click(); }
  });
  $app.addEventListener('click', async (ev) => {
    const pv = ev.target.closest('[data-priv]');
    if (pv) { if (pv.dataset.priv === '1') { ui.create.priv = pv.checked; document.querySelectorAll('[data-priv="1"]').forEach((e) => { e.checked = pv.checked; }); } else emit('setPrivate', { private: pv.checked }); return; }
    const rm = ev.target.closest('[data-room]');
    if (rm) return joinCode(rm.dataset.room);
    const t = ev.target.closest('[data-lv],[data-aic],[data-kick],[data-act],[data-game],[data-pp],[data-hand],[data-choose],[data-shake],[data-flipc],[data-gs],[data-bet],[data-floor],[data-stop]');
    if (!t) return;
    const d = t.dataset;
    if (d.stop) return;
    if (d.lv) { ui.create.level = d.lv; LS.set('hw_ai_level', d.lv); const n = document.getElementById('nick'); if (n) LS.set('hw_name', n.value.trim()); return render(); }
    if (d.aic) { ui.create.aiCount = Number(d.aic); const n = document.getElementById('nick'); if (n) LS.set('hw_name', n.value.trim()); return render(); }
    if (d.game) { ui.create.game = d.game; const n = document.getElementById('nick'); if (n) LS.set('hw_name', n.value.trim()); return renderLanding(); }
    if (d.pp) { ui.create.stake[ui.create.game] = Number(d.pp); const n = document.getElementById('nick'); if (n) LS.set('hw_name', n.value.trim()); return renderLanding(); }
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
        const pp = ui.create.stake[ui.create.game];
        const bonusEl = document.getElementById('bonus');
        const r = await emit('createRoom', { game: ui.create.game, perPoint: pp, bonus: bonusEl ? bonusEl.checked : true, pid, name, private: !!ui.create.priv });
        if (r.ok) { LS.set('hw_room', r.code); history.replaceState(null, '', '/?room=' + r.code); }
        return;
      }
      case 'solo': {
        const name = getName(); if (!name) return;
        const pp = ui.create.stake[ui.create.game];
        const bonusEl = document.getElementById('bonus');
        const c = ui.create;
        ui.expectDeal = true;
        const r = await emit('createRoom', { game: c.game, perPoint: pp, bonus: bonusEl ? bonusEl.checked : true, pid, name, ai: true, level: c.level, aiCount: c.aiCount, private: !!c.priv });
        if (r.ok) { LS.set('hw_room', r.code); history.replaceState(null, '', '/?room=' + r.code); }
        return;
      }
      case 'addAI': return emit('addAI', { level: ui.create.level });
      case 'join': return joinCode(document.getElementById('code').value);
      case 'joinUrl': return joinCode(urlRoom);
      case 'share': return share();
      case 'start': return emit('start');
      case 'next': ui.resClosed = null; return emit('start');
      case 'closeRes': if (S) ui.resClosed = resKey(); return render();
      case 'showRes': ui.resClosed = null; if (ui.resHold) ui.resHold.until = 0; return render();
      case 'toLobby': return emit('toLobby');
      case 'reset': if (confirm('이 방의 승수·증감 기록을 초기화할까요? (가진 돈은 그대로)')) { await emit('resetChips'); toast('기록을 초기화했습니다'); } return;
      case 'enter': {
        const nick = (document.getElementById('nick').value || '').trim();
        const pinEl = document.getElementById('pin');
        const pin = pinEl ? (pinEl.value || '').trim() : '';
        ui.loginName = nick;
        if (!nick) { ui.loginMsg = '이름을 입력하세요'; ui.loginMsgKind = 'err'; return render(); }
        if (pinEl && !/^\d{4}$/.test(pin)) { ui.loginMsg = 'PIN은 숫자 4자리예요'; ui.loginMsgKind = 'err'; return render(); }
        LS.set('hw_name', nick); // 마지막으로 쓴 이름은 로그아웃해도 기억 (다음에 미리 채움)
        const r = await new Promise((res) => socket.emit('enter', { nickname: nick, pin: pinEl ? pin : undefined }, (x) => res(x || {})));
        if (!r.ok) {
          if (r.code === 'NEED_PIN') { ui.needPin = true; ui.loginMsg = r.error; ui.loginMsgKind = 'info'; }
          else { ui.loginMsg = r.error || '오류'; ui.loginMsgKind = 'err'; if (r.code === 'TAKEN') ui.needPin = false; }
          render();
          const f = document.getElementById(ui.needPin && r.code !== 'TAKEN' ? 'pin' : 'nick'); if (f) f.focus();
          return;
        }
        LS.set('hw_token', r.token); LS.set('hw_name', r.account.nickname);
        ui.acct = r.account; ui.needPin = false; ui.loginMsg = null; ui.loginName = null;
        toast(r.created ? `🎉 환영해요 ${r.account.nickname}님! ${won(r.account.balance)}으로 시작합니다` : `👋 ${r.account.nickname}님, 다시 오셨네요!`, true);
        loadRanking();
        render();
        enterTargetRoom(); // 초대 링크로 왔으면 바로 그 방으로
        return;
      }
      case 'havePin': ev.preventDefault(); ui.loginName = (document.getElementById('nick') || {}).value || ''; ui.needPin = true; ui.loginMsg = null; render(); { const f = document.getElementById('pin'); if (f) f.focus(); } return;
      case 'pinForm': ev.preventDefault(); ui.pinForm = true; render(); { const f = document.getElementById(ui.acct && ui.acct.hasPin ? 'pin-cur' : 'pin-new'); if (f) f.focus(); } return;
      case 'cancelPin': ui.pinForm = false; return render();
      case 'recInfo': ui.modal = { type: 'rec' }; return render();
      case 'renameForm': ev.preventDefault(); ui.modal = { type: 'rename' }; ui.pinForm = false; render(); { const f = document.getElementById('rn-new'); if (f) { f.focus(); f.select(); } } return;
      case 'saveRename': {
        const m = ui.modal; if (!m) return;
        const nv = (document.getElementById('rn-new').value || '').trim();
        const pe = document.getElementById('rn-pin');
        m.val = nv; m.pin = pe ? pe.value.trim() : '';
        if (!nv) { m.msg = '새 이름을 입력하세요'; return render(); }
        if (pe && !/^\d{4}$/.test(m.pin)) { m.msg = '지금 PIN 4자리를 입력하세요'; return render(); }
        const r = await new Promise((res) => socket.emit('rename', { nickname: nv, currentPin: pe ? m.pin : undefined }, (x) => res(x || {})));
        if (!r.ok) { m.msg = r.error || '이름을 바꾸지 못했어요'; m.pin = ''; return render(); }
        ui.acct = r.account; ui.modal = null;
        LS.set('hw_name', r.account.nickname);
        toast(`✏️ 이제 '${r.account.nickname}'(으)로 불려요`, true);
        loadRanking();
        return render();
      }
      case 'delForm': ev.preventDefault(); ui.modal = { type: 'delAcct' }; ui.pinForm = false; render(); { const f = document.getElementById('del-name'); if (f) f.focus(); } return;
      case 'doDelete': {
        const m = ui.modal; if (!m) return;
        const nv = (document.getElementById('del-name').value || '').trim();
        const pe = document.getElementById('del-pin');
        m.val = nv; m.pin = pe ? pe.value.trim() : '';
        if (nv !== ui.acct.nickname) { m.msg = `이름을 똑같이 입력하세요: ${ui.acct.nickname}`; return render(); }
        if (pe && !/^\d{4}$/.test(m.pin)) { m.msg = '지금 PIN 4자리를 입력하세요'; return render(); }
        const r = await new Promise((res) => socket.emit('deleteAccount', { confirmName: nv, currentPin: pe ? m.pin : undefined }, (x) => res(x || {})));
        if (!r.ok) { m.msg = r.error || '삭제하지 못했어요'; m.pin = ''; return render(); }
        accountGone('계정을 삭제했어요. 이용해 주셔서 고마워요');
        return;
      }
      case 'savePin': {
        const nv = (document.getElementById('pin-new').value || '').trim();
        const ce = document.getElementById('pin-cur');
        if (!/^\d{4}$/.test(nv)) return toast('PIN은 숫자 4자리예요');
        const r = await emit('setPin', { pin: nv, currentPin: ce ? ce.value.trim() : undefined });
        if (!r.ok) return;
        ui.acct = r.account; ui.pinForm = false; toast('🔒 PIN을 저장했어요. 다른 기기에서도 이름 + PIN으로 들어올 수 있어요', true);
        return render();
      }
      case 'logout':
        if (!confirm(ui.acct && ui.acct.hasPin ? '로그아웃할까요? 다시 들어올 때 이름과 PIN이 필요해요.' : '⚠️ PIN이 없어서 로그아웃하면 이 이름(과 돈)으로 다시 들어올 수 없어요!\n먼저 🔒 PIN 설정을 하는 걸 추천해요.\n\n그래도 로그아웃할까요?')) return;
        await emit('logout', { token: LS.get('hw_token') }); LS.del('hw_token'); LS.del('hw_room'); ui.acct = null; return render();
      case 'rules': ui.modal = { type: 'rules' }; return render();
      case 'board': ui.modal = { type: 'board' }; return render();
      case 'close': ui.modal = null; return render();
      case 'mute': FX.setMuted(!FX.isMuted()); if (!FX.isMuted()) FX.tak(0.7); return render();
      case 'bgm': if (FX.isMuted()) { FX.setMuted(false); FX.setBgm(true); } else FX.setBgm(!FX.isBgmOn()); toast(FX.isBgmOn() ? '🎵 배경음악 켬' : '🎵 배경음악 끔'); return render();
      case 'playSel': if (ui.sel != null) tryPlay(ui.sel); return;
      case 'flipOnly': ui.sel = null; return emit('action', { type: 'flipOnly' });
      case 'chat': ui.chatOpen = !ui.chatOpen; setUnread(0); drawChat(); if (ui.chatOpen) { const i = document.getElementById('chat-text'); if (i && !('ontouchstart' in window)) i.focus(); } return;
      case 'exitRoom': {
        if (!S) return;
        if (inMyRound()) {
          const on = !(myRoomP() && myRoomP().leaveReserved);
          const r = await emit('reserveLeave', { on });
          if (r.ok && !r.leaveNow) { toast(on ? '🚪 나가기 예약됨 · 이번 판이 끝나면 방에서 나가요 (다시 누르면 취소)' : '나가기 예약을 취소했어요'); return; }
          if (!r.leaveNow) return;
        }
        await emit('leave'); LS.del('hw_room'); try { cancelAnim(); } catch (e) {} S = null; urlRoom = ''; history.replaceState(null, '', '/'); return render();
      }
      case 'leave':
        if (!(S && S.spectator) && !confirm('방에서 나갈까요?')) return;
        await emit('leave'); LS.del('hw_room'); try { cancelAnim(); } catch (e) {} S = null; urlRoom = ''; history.replaceState(null, '', '/'); return render();
    }
  });

  render();
})();
