// 섯다 (2장 섯다) 엔진 - 서버 권한
const { SEOTDA } = require('../shared/cards');
const { shuffle } = require('./util');

const PAIRS = { '1-2': [760, '알리'], '1-4': [750, '독사'], '1-9': [740, '구삥'], '1-10': [730, '장삥'], '4-10': [720, '장사'], '4-6': [710, '세륙'] };

function evalHand(id1, id2) {
  const c1 = SEOTDA[id1], c2 = SEOTDA[id2];
  const [a, b] = c1.m <= c2.m ? [c1, c2] : [c2, c1];
  const lo = a.m, hi = b.m;
  if (a.type === 'gwang' && b.type === 'gwang') {
    if (lo === 3 && hi === 8) return { rank: 1000, name: '38광땡' };
    if (lo === 1 && hi === 8) return { rank: 900, name: '18광땡' };
    if (lo === 1 && hi === 3) return { rank: 900, name: '13광땡' };
  }
  if (lo === hi) return { rank: 800 + lo, name: lo === 10 ? '장땡' : lo + '땡' };
  if (lo === 4 && hi === 7 && a.type === 'yeol' && b.type === 'yeol') return { rank: 601, name: '암행어사', special: 'amhaeng' };
  if (lo === 3 && hi === 7 && a.type === 'gwang' && b.type === 'yeol') return { rank: 600, name: '땡잡이', special: 'ddaeng' };
  if (lo === 4 && hi === 9) {
    if (a.type === 'yeol' && b.type === 'yeol') return { rank: 603, name: '멍텅구리구사', special: 'mgusa' };
    return { rank: 603, name: '구사', special: 'gusa' };
  }
  const p = PAIRS[lo + '-' + hi];
  if (p) return { rank: p[0], name: p[1] };
  const k = (lo + hi) % 10;
  return { rank: 600 + k, name: k === 9 ? '갑오' : k === 0 ? '망통' : k + '끗' };
}

// hands: [{idx, hand:{rank,name,special}}] -> {redeal:bool, reason, winners:[idx], eff:{idx:rank}}
function showdown(hands) {
  const maxOthers = (idx) => Math.max(-1, ...hands.filter((h) => h.idx !== idx).map((h) => h.hand.rank));
  for (const h of hands) {
    if (h.hand.special === 'mgusa' && maxOthers(h.idx) < 810) return { redeal: true, reason: '멍텅구리구사 재경기' };
    if (h.hand.special === 'gusa' && maxOthers(h.idx) <= 760) return { redeal: true, reason: '구사 재경기' };
  }
  const eff = {};
  for (const h of hands) {
    let r = h.hand.rank;
    const mo = maxOthers(h.idx);
    if (h.hand.special === 'amhaeng' && mo === 900) r = 950;
    if (h.hand.special === 'ddaeng' && mo >= 801 && mo <= 809) r = 850;
    eff[h.idx] = r;
  }
  const best = Math.max(...Object.values(eff));
  const winners = hands.filter((h) => eff[h.idx] === best).map((h) => h.idx);
  return { redeal: false, winners, eff };
}

const MAX_RAISES = 4;

class SeotdaGame {
  constructor(players, opts = {}) {
    this.kind = 'seotda';
    this.ante = opts.ante || 100;
    this.rand = opts.rand;
    this.dealer = (opts.dealer || 0) % players.length;
    this.seats = players.map((p) => ({ id: p.id, name: p.name, cards: [], folded: false, contrib: 0, roundBet: 0 }));
    this.pot = 0;
    this.events = [];
    this.over = false;
    this.result = null;
    this.redeals = 0;
    for (const s of this.seats) { s.contrib += this.ante; this.pot += this.ante; }
    this.events.push(`기본 판돈 ${this.ante.toLocaleString("ko-KR")}원씩`);
    this.deal();
  }
  seatOf(pid) { return this.seats.findIndex((s) => s.id === pid); }
  active() { return this.seats.map((s, i) => i).filter((i) => !this.seats[i].folded); }
  deal() {
    const deck = shuffle(SEOTDA.map((c) => c.id), this.rand);
    for (const i of this.active()) { this.seats[i].cards = [deck.pop(), deck.pop()]; this.seats[i].roundBet = 0; }
    this.currentBet = 0;
    this.raises = 0;
    this.needToAct = new Set(this.active());
    this.turn = this.nextActive(this.dealer);
    this.phase = 'bet';
  }
  nextActive(from) {
    const n = this.seats.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (!this.seats[i].folded && this.needToAct.has(i)) return i;
    }
    return -1;
  }
  options(i) {
    if (this.over || this.phase !== 'bet' || i !== this.turn) return [];
    const s = this.seats[i];
    const toCall = this.currentBet - s.roundBet;
    const o = [{ type: 'die', label: '다이' }];
    if (this.currentBet === 0) {
      o.push({ type: 'check', label: '체크', amount: 0 });
      o.push({ type: 'bbing', label: '삥', amount: this.ante });
    } else {
      o.push({ type: 'call', label: '콜', amount: toCall });
    }
    if (this.raises < MAX_RAISES) {
      o.push({ type: 'half', label: '하프', amount: this.halfTo(i) - s.roundBet });
      if (this.currentBet > 0) o.push({ type: 'ddadang', label: '따당', amount: this.currentBet * 2 - s.roundBet });
    }
    return o;
  }
  halfTo(i) {
    const s = this.seats[i];
    const toCall = this.currentBet - s.roundBet;
    return this.currentBet + Math.max(this.ante, Math.floor((this.pot + toCall) / 2));
  }
  pay(i, amt) { const s = this.seats[i]; s.roundBet += amt; s.contrib += amt; this.pot += amt; }
  act(pid, action) {
    const i = this.seatOf(pid);
    if (i < 0) throw new Error('참가자가 아닙니다');
    const opt = this.options(i).find((o) => o.type === action.type);
    if (!opt) throw new Error('지금 할 수 없는 행동입니다');
    const s = this.seats[i];
    this.events = [];
    const raise = (to) => {
      this.pay(i, to - s.roundBet);
      this.currentBet = to;
      this.raises++;
      this.needToAct = new Set(this.active().filter((x) => x !== i));
    };
    switch (action.type) {
      case 'die': s.folded = true; this.needToAct.delete(i); this.events.push(`${s.name}: 다이`); break;
      case 'check': this.needToAct.delete(i); this.events.push(`${s.name}: 체크`); break;
      case 'bbing': this.pay(i, this.ante); this.currentBet = this.ante; this.needToAct = new Set(this.active().filter((x) => x !== i)); this.events.push(`${s.name}: 삥 (${this.ante})`); break;
      case 'call': this.pay(i, opt.amount); this.needToAct.delete(i); this.events.push(`${s.name}: 콜 (${opt.amount})`); break;
      case 'half': { const to = this.halfTo(i); raise(to); this.events.push(`${s.name}: 하프 (${opt.amount})`); break; }
      case 'ddadang': raise(this.currentBet * 2); this.events.push(`${s.name}: 따당 (${opt.amount})`); break;
    }
    const act = this.active();
    if (act.length === 1) return this.finish([act[0]], '나머지 모두 다이');
    if (this.needToAct.size === 0) return this.doShowdown();
    this.turn = this.nextActive(i);
  }
  doShowdown() {
    const hands = this.active().map((idx) => ({ idx, hand: evalHand(...this.seats[idx].cards) }));
    const sd = showdown(hands);
    if (sd.redeal && this.redeals < 5) {
      this.redeals++;
      this.lastReveal = hands.map((h) => ({ idx: h.idx, cards: this.seats[h.idx].cards, name: h.hand.name }));
      this.events.push(`${sd.reason}! 판돈 유지, 남은 사람끼리 다시 패를 돌립니다`);
      this.deal();
      return;
    }
    const winners = sd.redeal ? [hands.slice().sort((a, b) => b.hand.rank - a.hand.rank)[0].idx] : sd.winners;
    return this.finish(winners, null, hands, sd.eff);
  }
  finish(winners, reason, hands, eff) {
    this.over = true;
    this.phase = 'end';
    this.turn = -1;
    const share = Math.floor(this.pot / winners.length);
    let rem = this.pot - share * winners.length;
    const delta = {};
    this.seats.forEach((s, i) => {
      let win = 0;
      if (winners.includes(i)) { win = share + rem; rem = 0; }
      delta[s.id] = win - s.contrib;
    });
    const reveal = hands ? hands.map((h) => ({ id: this.seats[h.idx].id, name: this.seats[h.idx].name, cards: this.seats[h.idx].cards, hand: h.hand.name, eff: eff ? eff[h.idx] : h.hand.rank })) : [];
    this.result = {
      game: 'seotda',
      winners: winners.map((i) => this.seats[i].id),
      winnerNames: winners.map((i) => this.seats[i].name),
      reason,
      pot: this.pot,
      reveal,
      folded: this.seats.filter((s) => s.folded).map((s) => ({ id: s.id, name: s.name })), // 다이한 사람 (패는 공개 안 함)
      winnerHands: hands ? winners.map((i) => (hands.find((h) => h.idx === i) || {}).hand).filter(Boolean).map((h) => h.name) : [],
      chipDelta: delta,
      lines: reason ? [reason] : reveal.map((r) => `${r.name}: ${r.hand}`),
    };
    this.events.push(`${this.result.winnerNames.join(', ')} 승리! 판돈 ${this.pot.toLocaleString("ko-KR")}원`);
  }
  view(pid) {
    const me = this.seatOf(pid);
    return {
      kind: 'seotda',
      pot: this.pot,
      ante: this.ante,
      currentBet: this.currentBet,
      turn: this.turn,
      phase: this.phase,
      redeals: this.redeals,
      mySeat: me,
      seats: this.seats.map((s, i) => ({
        id: s.id, name: s.name, folded: s.folded, contrib: s.contrib, roundBet: s.roundBet,
        cards: i === me || this.over ? s.cards : s.cards.map(() => null),
        handName: i === me || (this.over && this.result.reveal.length) ? evalHand(...s.cards).name : null,
      })),
      options: me >= 0 ? this.options(me) : [],
      events: this.events,
      lastReveal: this.lastReveal || null,
      result: this.result,
    };
  }
  autoAction(pid) {
    const o = this.options(this.seatOf(pid));
    const c = o.find((x) => x.type === 'check') || o.find((x) => x.type === 'die');
    if (c) this.act(pid, { type: c.type });
  }
}

module.exports = { SeotdaGame, evalHand, showdown };
