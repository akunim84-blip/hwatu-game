// 맞고(2인) / 고스톱(3인) 엔진 - 서버 권한
const { HWATU } = require('../shared/cards');
const { shuffle } = require('./util');

const C = (id) => HWATU[id];

function scoreCaptured(ids) {
  const cards = ids.map(C);
  const gw = cards.filter((c) => c.type === 'gwang');
  const yeol = cards.filter((c) => c.type === 'yeol');
  const tti = cards.filter((c) => c.type === 'tti');
  const piValue = cards.reduce((s, c) => s + c.piValue, 0);
  const lines = [];
  let gwangPts = 0;
  if (gw.length === 5) gwangPts = 15;
  else if (gw.length === 4) gwangPts = 4;
  else if (gw.length === 3) gwangPts = gw.some((c) => c.bi) ? 2 : 3;
  if (gwangPts) lines.push({ label: gw.length === 3 && gwangPts === 2 ? '비광 포함 3광' : gw.length + '광', pts: gwangPts });
  let yeolPts = yeol.length >= 5 ? yeol.length - 4 : 0;
  if (yeolPts) lines.push({ label: `열끗 ${yeol.length}장`, pts: yeolPts });
  if (yeol.filter((c) => c.godori).length === 3) lines.push({ label: '고도리', pts: 5 });
  const ttiPts = tti.length >= 5 ? tti.length - 4 : 0;
  if (ttiPts) lines.push({ label: `띠 ${tti.length}장`, pts: ttiPts });
  for (const [dan, name] of [['hong', '홍단'], ['cheong', '청단'], ['cho', '초단']]) {
    if (tti.filter((c) => c.dan === dan).length === 3) lines.push({ label: name, pts: 3 });
  }
  const piPts = piValue >= 10 ? piValue - 9 : 0;
  if (piPts) lines.push({ label: `피 ${piValue}장`, pts: piPts });
  const total = lines.reduce((s, l) => s + l.pts, 0);
  return { total, lines, gwangCount: gw.length, gwangPts, yeolCount: yeol.length, ttiCount: tti.length, piValue, piPts };
}

class GoStopGame {
  constructor(players, opts = {}) {
    this.n = players.length;
    if (this.n !== 2 && this.n !== 3) throw new Error('맞고는 2명, 고스톱은 3명이 필요합니다');
    this.kind = this.n === 2 ? 'matgo' : 'gostop';
    this.target = this.n === 2 ? 7 : 3;
    this.perPoint = opts.perPoint || 10;
    this.mult = opts.mult || 1; // 나가리 배수
    this.rand = opts.rand;
    this.useBonus = opts.bonus !== false;
    this.players = players.map((p) => ({ id: p.id, name: p.name, hand: [], captured: [], go: 0, lastGoScore: 0, shakes: 0, bombFlips: 0, ppeok: 0 }));
    this.events = [];
    this.over = false;
    this.result = null;
    this.turn = (opts.first || 0) % this.n;
    this.deal(opts.deck);
  }
  // 실제 돌리는 순서(목적지 목록). 일반 게임: 선부터 한 장씩 돌아가며(나→상대→…) 사이사이 바닥에 한 장.
  // 테스트용 고정 덱(forcedDeck)은 예전 순서(손패 묶음 → 바닥) 유지.
  static dealOrder(n, first, batch) {
    const handSize = n === 2 ? 10 : 7, floorSize = n === 2 ? 8 : 6;
    const order = [];
    if (batch) {
      for (let s = 0; s < n; s++) for (let k = 0; k < handSize; k++) order.push({ to: 'hand', seat: s });
      for (let k = 0; k < floorSize; k++) order.push({ to: 'floor' });
      return order;
    }
    let fl = 0;
    for (let r = 0; r < handSize; r++) {
      for (let k = 0; k < n; k++) order.push({ to: 'hand', seat: (first + k) % n });
      while (fl < Math.round((floorSize * (r + 1)) / handSize)) { order.push({ to: 'floor' }); fl++; }
    }
    return order;
  }
  deal(forcedDeck) {
    for (let tries = 0; tries < 50; tries++) {
      const ids = HWATU.filter((c) => this.useBonus || !c.bonus).map((c) => c.id);
      let deck = forcedDeck ? forcedDeck.slice() : shuffle(ids, this.rand); // crypto.randomInt Fisher-Yates
      // deck: pop() = 맨 위
      this.players.forEach((p) => { p.hand = []; p.captured = []; });
      this.floor = [];
      const seq = []; // 클라이언트 애니메이션용 실제 돌린 순서 {to, seat?, card}
      for (const d of GoStopGame.dealOrder(this.n, this.turn, !!forcedDeck)) {
        const card = deck.pop();
        if (d.to === 'hand') this.players[d.seat].hand.push(card);
        else this.floor.push(card);
        seq.push(Object.assign({ card }, d));
      }
      this.deck = deck;
      // 바닥 보너스 카드는 선에게, 빈 자리는 덱에서 채움
      let guard = 0;
      while (this.floor.some((id) => C(id).bonus) && guard++ < 10) {
        const b = this.floor.find((id) => C(id).bonus);
        this.floor.splice(this.floor.indexOf(b), 1);
        this.players[this.turn].captured.push(b);
        seq.push({ to: 'cap', seat: this.turn, card: b });
        const f = this.deck.pop();
        this.floor.push(f);
        seq.push({ to: 'floor', card: f });
      }
      this.dealSeq = seq;
      const byMonth = this.countBy(this.floor);
      if (!Object.values(byMonth).some((v) => v === 4) || forcedDeck) break;
    }
    this.phase = 'play';
    this.pending = null;
    this.events.push('패를 돌렸습니다');
  }
  // 보는 사람 기준 돌린 순서: 남의 손패는 카드 id를 가림
  dealView(me) {
    return (this.dealSeq || []).map((d) => (d.to === 'hand' && d.seat !== me ? { to: 'hand', seat: d.seat, card: null } : d));
  }
  countBy(ids) { const o = {}; ids.forEach((id) => { const m = C(id).m; o[m] = (o[m] || 0) + 1; }); return o; }
  seatOf(pid) { return this.players.findIndex((p) => p.id === pid); }
  floorOf(m) { return this.floor.filter((id) => C(id).m === m); }
  removeFloor(ids) { for (const id of ids) { const k = this.floor.indexOf(id); if (k >= 0) this.floor.splice(k, 1); } }
  sameValue(a, b) { const x = C(a), y = C(b); return x.type === y.type && x.dan === y.dan && !!x.godori === !!y.godori && !!x.bi === !!y.bi; }

  options(i) {
    if (this.over || i !== this.turn) return null;
    const p = this.players[i];
    if (this.phase === 'play') {
      const cnt = this.countBy(p.hand);
      const cards = p.hand.map((id) => {
        const c = C(id);
        if (c.bonus) return { id, bonus: true };
        const fm = this.floorOf(c.m);
        return {
          id,
          matches: fm,
          needChoice: fm.length === 2 && !this.sameValue(fm[0], fm[1]),
          canShake: cnt[c.m] === 3 && fm.length === 0,
          bomb: cnt[c.m] === 3 && fm.length === 1,
        };
      });
      return { phase: 'play', cards, canFlipOnly: p.bombFlips > 0 && this.deck.length > 0 };
    }
    if (this.phase === 'chooseFlip') return { phase: 'chooseFlip', choices: this.pending.choices, card: this.pending.card };
    if (this.phase === 'goStop') return { phase: 'goStop', score: this.scoreOf(i).total, go: p.go };
    return null;
  }
  act(pid, a) {
    const i = this.seatOf(pid);
    if (i < 0) throw new Error('참가자가 아닙니다');
    if (this.over) throw new Error('게임이 끝났습니다');
    if (i !== this.turn) throw new Error('내 차례가 아닙니다');
    this.events = [];
    const p = this.players[i];
    if (this.phase === 'play') {
      // 클라이언트 애니메이션/효과음용: 이번 차례에 낸 패와 뒤집은 패
      this.playSeq = (this.playSeq || 0) + 1;
      this.lastPlay = { seq: this.playSeq, seat: i, card: null, flip: null, bonus: false };
      if (a.type === 'flipOnly') {
        if (!(p.bombFlips > 0)) throw new Error('뒤집기만 할 수 없습니다');
        p.bombFlips--;
        this.ctx = { steal: 0, hr: { type: 'none' } };
        this.events.push(`${p.name}: 폭탄 뒤집기`);
        return this.flipPhase(i);
      }
      if (a.type !== 'play') throw new Error('잘못된 행동');
      return this.playCard(i, a.card, a.floorCard, !!a.shake);
    }
    if (this.phase === 'chooseFlip') {
      if (a.type !== 'chooseFlip' || !this.pending.choices.includes(a.floorCard)) throw new Error('선택할 수 없는 카드');
      const { card } = this.pending;
      this.removeFloor([a.floorCard]);
      p.captured.push(card, a.floorCard);
      this.pending = null;
      this.phase = 'play';
      return this.finishTurn(i);
    }
    if (this.phase === 'goStop') {
      if (a.type === 'go') {
        p.go++;
        p.lastGoScore = this.scoreOf(i).total;
        this.events.push(`${p.name}: ${p.go}고!`);
        this.phase = 'play';
        return this.advance(i);
      }
      if (a.type === 'stop') { this.events.push(`${p.name}: 스톱!`); return this.endWin(i); }
      throw new Error('고 또는 스톱을 선택하세요');
    }
    throw new Error('잘못된 상태');
  }
  playCard(i, card, floorCard, shake) {
    const p = this.players[i];
    if (!p.hand.includes(card)) throw new Error('손에 없는 카드');
    const c = C(card);
    this.ctx = { steal: 0 };
    if (this.lastPlay) { this.lastPlay.card = card; this.lastPlay.bonus = !!c.bonus; }
    if (c.bonus) {
      p.hand.splice(p.hand.indexOf(card), 1);
      p.captured.push(card);
      this.events.push(`${p.name}: 보너스 쌍피 사용`);
      if (this.deck.length) p.hand.push(this.deck.pop());
      if (p.hand.length === 0 && p.bombFlips === 0) { this.ctx.hr = { type: 'none' }; return this.flipPhase(i); }
      return; // 같은 차례에 계속 냄
    }
    const M = c.m;
    const inHand = p.hand.filter((id) => C(id).m === M);
    const fm = this.floorOf(M);
    if (inHand.length === 3 && fm.length === 1) {
      // 폭탄
      for (const id of inHand) p.hand.splice(p.hand.indexOf(id), 1);
      this.removeFloor(fm);
      p.captured.push(...inHand, ...fm);
      p.shakes++;
      p.bombFlips += 2;
      this.ctx.steal++;
      this.events.push(`${p.name}: 폭탄! (${M}월, 피 1장씩 뺏기, 배수 x2)`);
      this.ctx.hr = { type: 'take4', m: M };
      return this.flipPhase(i);
    }
    if (shake && inHand.length === 3 && fm.length === 0) {
      p.shakes++;
      this.events.push(`${p.name}: 흔들기! (${M}월 3장, 배수 x2)`);
    }
    p.hand.splice(p.hand.indexOf(card), 1);
    if (fm.length === 0) {
      this.floor.push(card);
      this.ctx.hr = { type: 'place', card, m: M };
    } else if (fm.length === 1) {
      this.removeFloor(fm);
      this.ctx.hr = { type: 'pair', cards: [card, fm[0]], m: M };
    } else if (fm.length === 2) {
      let pick = floorCard;
      if (!fm.includes(pick)) pick = this.sameValue(fm[0], fm[1]) ? fm[0] : null;
      if (pick == null) { p.hand.push(card); throw new Error('바닥 카드를 선택하세요'); }
      this.removeFloor([pick]);
      this.ctx.hr = { type: 'pair2', cards: [card, pick], m: M };
    } else {
      this.removeFloor(fm);
      p.captured.push(card, ...fm);
      this.ctx.steal++;
      this.events.push(`${p.name}: 뻑 먹기! (${M}월 4장, 피 1장씩 뺏기)`);
      this.ctx.hr = { type: 'take4', m: M };
    }
    return this.flipPhase(i);
  }
  flipPhase(i) {
    const p = this.players[i];
    const hr = this.ctx.hr;
    let F = null;
    while (this.deck.length) {
      const f = this.deck.pop();
      if (C(f).bonus) { p.captured.push(f); this.events.push(`${p.name}: 뒤집은 보너스 쌍피 획득`); continue; }
      F = f; break;
    }
    this.lastFlip = F;
    if (this.lastPlay) this.lastPlay.flip = F;
    let fDone = F == null;
    const fm = F != null ? C(F).m : -1;
    if (hr.type === 'place') {
      if (!fDone && fm === hr.m) {
        this.removeFloor([hr.card]);
        p.captured.push(hr.card, F);
        this.ctx.steal++;
        this.events.push(`${p.name}: 쪽! (피 1장씩 뺏기)`);
        fDone = true;
      }
    } else if (hr.type === 'pair') {
      if (!fDone && fm === hr.m) {
        this.floor.push(...hr.cards, F);
        p.ppeok++;
        this.events.push(`${p.name}: 뻑! (${hr.m}월 3장 바닥에 쌓임)`);
        fDone = true;
      } else p.captured.push(...hr.cards);
    } else if (hr.type === 'pair2') {
      if (!fDone && fm === hr.m) {
        const rest = this.floorOf(hr.m);
        this.removeFloor(rest);
        p.captured.push(...hr.cards, ...rest, F);
        this.ctx.steal++;
        this.events.push(`${p.name}: 따닥! (${hr.m}월 4장, 피 1장씩 뺏기)`);
        fDone = true;
      } else p.captured.push(...hr.cards);
    }
    if (!fDone) {
      const m2 = this.floorOf(fm);
      if (m2.length === 0) this.floor.push(F);
      else if (m2.length === 1) { this.removeFloor(m2); p.captured.push(F, m2[0]); }
      else if (m2.length === 2) {
        if (this.sameValue(m2[0], m2[1])) { this.removeFloor([m2[0]]); p.captured.push(F, m2[0]); }
        else {
          this.phase = 'chooseFlip';
          this.pending = { card: F, choices: m2 };
          this.events.push(`${p.name}: 뒤집은 카드로 먹을 패를 고르세요`);
          return;
        }
      } else {
        this.removeFloor(m2);
        p.captured.push(F, ...m2);
        this.ctx.steal++;
        this.events.push(`${p.name}: 뻑 먹기! (${fm}월 4장, 피 1장씩 뺏기)`);
      }
    }
    return this.finishTurn(i);
  }
  stealPi(from, to) {
    const cap = this.players[from].captured;
    let pick = cap.find((id) => C(id).type === 'pi');
    if (pick == null) pick = cap.find((id) => C(id).type === 'ssangpi');
    if (pick == null) return false;
    cap.splice(cap.indexOf(pick), 1);
    this.players[to].captured.push(pick);
    return true;
  }
  finishTurn(i) {
    const p = this.players[i];
    const anyLeft = this.players.some((q) => q.hand.length > 0);
    if (this.floor.length === 0 && anyLeft) {
      this.ctx.steal++;
      this.events.push(`${p.name}: 싹쓸이! (피 1장씩 뺏기)`);
    }
    if (this.ctx.steal > 0) {
      for (let k = 0; k < this.n; k++) if (k !== i) for (let s = 0; s < this.ctx.steal; s++) this.stealPi(k, i);
    }
    if (p.ppeok >= 3) {
      this.events.push(`${p.name}: 3뻑! 즉시 승리`);
      return this.endWin(i, { threePpeok: true });
    }
    const sc = this.scoreOf(i).total;
    if (sc >= this.target && sc > p.lastGoScore) {
      const canContinue = p.hand.length > 0 || p.bombFlips > 0;
      if (!canContinue) { this.events.push(`${p.name}: 마지막 패 - 자동 스톱`); return this.endWin(i); }
      this.phase = 'goStop';
      this.events.push(`${p.name}: ${sc}점 달성! 고/스톱?`);
      return;
    }
    return this.advance(i);
  }
  advance(i) {
    for (let k = 1; k <= this.n; k++) {
      const j = (i + k) % this.n;
      const q = this.players[j];
      if (q.hand.length > 0 || (q.bombFlips > 0 && this.deck.length > 0)) { this.turn = j; this.phase = 'play'; return; }
    }
    return this.endNagari();
  }
  scoreOf(i) { return scoreCaptured(this.players[i].captured); }
  endNagari() {
    this.over = true;
    this.phase = 'end';
    this.turn = -1;
    const delta = {};
    this.players.forEach((p) => (delta[p.id] = 0));
    this.result = { game: this.kind, nagari: true, winners: [], winnerNames: [], chipDelta: delta, lines: ['나가리! 아무도 나지 못했습니다. 다음 판 점수 2배'] };
    this.events.push('나가리!');
  }
  endWin(w, flags = {}) {
    this.over = true;
    this.phase = 'end';
    this.turn = -1;
    const W = this.players[w];
    const ws = this.scoreOf(w);
    const g = W.go;
    let base = Math.max(ws.total, flags.threePpeok ? this.target : 0);
    let pts = base + Math.min(g, 2);
    if (g >= 3) pts *= Math.pow(2, g - 2);
    const lines = ws.lines.map((l) => `${l.label} ${l.pts}점`);
    if (flags.threePpeok) lines.push('3뻑 승리');
    if (g > 0) lines.push(`${g}고 ${g >= 3 ? `(+2, x${Math.pow(2, g - 2)})` : `(+${g})`}`);
    let common = 1;
    if (W.shakes > 0) { common *= Math.pow(2, W.shakes); lines.push(`흔들기/폭탄 x${Math.pow(2, W.shakes)}`); }
    if (this.mult > 1) { common *= this.mult; lines.push(`나가리 배수 x${this.mult}`); }
    const delta = {};
    this.players.forEach((p) => (delta[p.id] = 0));
    const loserInfo = [];
    const goBakPlayer = this.players.find((p, k) => k !== w && p.go > 0);
    for (let k = 0; k < this.n; k++) {
      if (k === w) continue;
      const L = this.players[k];
      const ls = this.scoreOf(k);
      let m = common;
      const tags = [];
      if (ws.gwangPts > 0 && ls.gwangCount === 0) { m *= 2; tags.push('광박'); }
      if (ws.piPts > 0 && ls.piValue <= 5) { m *= 2; tags.push('피박'); }
      if (this.n === 2 && L.go > 0) { m *= 2; tags.push('고박'); }
      const amount = pts * m * this.perPoint;
      loserInfo.push({ id: L.id, name: L.name, tags, mult: m, amount });
    }
    for (const li of loserInfo) {
      let payer = li.id;
      if (this.n === 3 && goBakPlayer) { payer = goBakPlayer.id; if (payer !== li.id) li.tags.push(`고박(${goBakPlayer.name} 대신 냄)`); }
      delta[payer] -= li.amount;
      delta[W.id] += li.amount;
    }
    this.result = {
      game: this.kind,
      winners: [W.id],
      winnerNames: [W.name],
      points: pts,
      baseScore: base,
      lines,
      losers: loserInfo,
      chipDelta: delta,
      perPoint: this.perPoint,
    };
    this.events.push(`${W.name} 승리! ${pts}점`);
  }
  view(pid) {
    const me = this.seatOf(pid);
    return {
      kind: this.kind,
      target: this.target,
      mult: this.mult,
      turn: this.turn,
      phase: this.phase,
      mySeat: me,
      floor: this.floor,
      deckCount: this.deck.length,
      lastFlip: this.lastFlip == null ? null : this.lastFlip,
      lastPlay: this.lastPlay || null,
      deal: this.lastPlay ? null : this.dealView(me), // 첫 수 전까지만 전송
      players: this.players.map((p, k) => {
        const s = this.scoreOf(k);
        return {
          id: p.id, name: p.name,
          hand: k === me ? p.hand : null,
          handCount: p.hand.length,
          captured: p.captured,
          score: s.total, scoreLines: s.lines, piValue: s.piValue,
          go: p.go, shakes: p.shakes, ppeok: p.ppeok, bombFlips: p.bombFlips,
        };
      }),
      pending: this.phase === 'chooseFlip' ? this.pending : null,
      options: me >= 0 ? this.options(me) : null,
      events: this.events,
      result: this.result,
    };
  }
  autoAction(pid) {
    const i = this.seatOf(pid);
    const o = this.options(i);
    if (!o) return;
    if (o.phase === 'play') {
      if (!o.cards.length) return this.act(pid, { type: 'flipOnly' });
      const c = o.cards[0];
      return this.act(pid, { type: 'play', card: c.id, floorCard: c.matches ? c.matches[0] : undefined });
    }
    if (o.phase === 'chooseFlip') return this.act(pid, { type: 'chooseFlip', floorCard: o.choices[0] });
    if (o.phase === 'goStop') return this.act(pid, { type: 'stop' });
  }
}

module.exports = { GoStopGame, scoreCaptured };
