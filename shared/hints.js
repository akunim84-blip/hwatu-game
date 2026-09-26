// 족보 진행도/힌트 계산 (서버 테스트·브라우저 공용, UMD). 공개 정보(먹은 패·바닥)와 내 손패만 사용.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./cards'));
  else root.HwatuHints = factory(root.HwatuCards);
})(typeof self !== 'undefined' ? self : this, function (Cards) {
  const { HWATU } = Cards;
  const C = (id) => HWATU[id];
  // 3장짜리 족보
  const SETS = {
    godori: { name: '고도리', short: '고도리', pts: 5, members: HWATU.filter((c) => c.godori).map((c) => c.id) },
    hong: { name: '홍단', short: '홍단', pts: 3, members: HWATU.filter((c) => c.type === 'tti' && c.dan === 'hong').map((c) => c.id) },
    cheong: { name: '청단', short: '청단', pts: 3, members: HWATU.filter((c) => c.type === 'tti' && c.dan === 'cheong').map((c) => c.id) },
    cho: { name: '초단', short: '초단', pts: 3, members: HWATU.filter((c) => c.type === 'tti' && c.dan === 'cho').map((c) => c.id) },
  };
  const SET_KEYS = ['godori', 'hong', 'cheong', 'cho'];
  const GWANG = HWATU.filter((c) => c.type === 'gwang').map((c) => c.id);

  function setsOfCard(id) {
    const out = SET_KEYS.filter((k) => SETS[k].members.includes(id));
    if (C(id).type === 'gwang') out.push('gwang');
    return out;
  }

  // 먹은 패 → 진행도
  function progress(captured) {
    const cs = captured.map(C);
    const p = {
      gwang: cs.filter((c) => c.type === 'gwang').length,
      bi: cs.some((c) => c.bi),
      yeol: cs.filter((c) => c.type === 'yeol').length,
      tti: cs.filter((c) => c.type === 'tti').length,
      pi: cs.reduce((s, c) => s + (c.piValue || 0), 0),
      sets: {},
    };
    for (const k of SET_KEYS) p.sets[k] = captured.filter((id) => SETS[k].members.includes(id)).length;
    return p;
  }

  // 배지 목록 [{key, label, done, n, need}]
  function badges(captured) {
    const p = progress(captured);
    const b = [];
    if (p.gwang) b.push({ key: 'gwang', label: `광${p.gwang}`, n: p.gwang, need: 3, done: p.gwang >= 3 });
    for (const k of SET_KEYS) if (p.sets[k]) b.push({ key: k, label: `${SETS[k].short} ${p.sets[k]}/3`, n: p.sets[k], need: 3, done: p.sets[k] >= 3 });
    if (p.yeol) b.push({ key: 'yeol', label: `열${p.yeol}/5`, n: p.yeol, need: 5, done: p.yeol >= 5 });
    if (p.tti) b.push({ key: 'tti', label: `띠${p.tti}/5`, n: p.tti, need: 5, done: p.tti >= 5 });
    if (p.pi) b.push({ key: 'pi', label: `피${p.pi}/10`, n: p.pi, need: 10, done: p.pi >= 10 });
    return b;
  }

  // 완성된 족보 이름 목록 (토스트용 비교)
  function completed(captured) {
    const p = progress(captured);
    const out = [];
    for (const k of SET_KEYS) if (p.sets[k] >= 3) out.push(SETS[k].name);
    if (p.gwang >= 5) out.push('5광'); else if (p.gwang >= 4) out.push('4광'); else if (p.gwang >= 3) out.push(p.bi ? '비광 3광' : '3광');
    if (p.pi >= 10) out.push('피 10장');
    if (p.yeol >= 5) out.push('열끗 5장');
    if (p.tti >= 5) out.push('띠 5장');
    return out;
  }

  // 누군가 먹었으면 그 족보는 다른 사람에게 불가능
  function ownerMap(players) {
    const own = {};
    players.forEach((pl, i) => pl.captured.forEach((id) => { own[id] = i; }));
    return own;
  }

  // 위협: 상대가 족보까지 1장 남음 (내가 멤버를 하나라도 먹었으면 불가능 → 경고 안 함)
  // view: {players:[{name,captured}], mySeat, floor, hand}
  function threats(view) {
    const me = view.mySeat;
    const own = ownerMap(view.players);
    const floor = view.floor || [];
    const hand = view.hand || [];
    const out = [];
    view.players.forEach((pl, i) => {
      if (i === me) return;
      for (const k of SET_KEYS) {
        const mem = SETS[k].members;
        const have = mem.filter((id) => own[id] === i).length;
        const missing = mem.filter((id) => own[id] === undefined);
        const blockedByOther = mem.some((id) => own[id] !== undefined && own[id] !== i);
        if (have === 2 && missing.length === 1 && !blockedByOther) out.push(threatOf(pl, i, k, SETS[k].name, missing, floor, hand));
      }
      // 광: 2장 먹었고 남은 광이 있음 → 3광 위협 (비광만 남았어도 2점)
      const g = GWANG.filter((id) => own[id] === i).length;
      if (g === 2) {
        const missing = GWANG.filter((id) => own[id] === undefined);
        if (missing.length) out.push(threatOf(pl, i, 'gwang', '3광', missing, floor, hand));
      }
    });
    return out;
  }
  function threatOf(pl, seat, key, name, missing, floor, hand) {
    const onFloor = missing.filter((id) => floor.includes(id));
    const inHand = missing.filter((id) => hand.includes(id));
    // 바닥에 있는 부족 카드를 내 손패로 먹어서 막을 수 있음
    const blockers = hand.filter((h) => !C(h).bonus && onFloor.some((f) => C(f).m === C(h).m));
    return { seat, name: pl.name, key, set: name, missing, onFloor, inHand, blockers };
  }

  // 내 손패 태그: 카드 id → [{key,label,kind:'set'|'block'}]
  function handTags(view) {
    const me = view.mySeat;
    const hand = view.hand || [];
    const floor = view.floor || [];
    const own = ownerMap(view.players);
    const alive = (k) => {
      // 내 족보로 아직 가능한가 (다른 사람이 멤버를 먹지 않았고, 아직 미완성)
      const mem = k === 'gwang' ? GWANG : SETS[k].members;
      if (k === 'gwang') return mem.filter((id) => own[id] === me).length < 5;
      return !mem.some((id) => own[id] !== undefined && own[id] !== me) && mem.filter((id) => own[id] === me).length < 3;
    };
    const mineCnt = (k) => (k === 'gwang' ? GWANG : SETS[k].members).filter((id) => own[id] === me).length;
    const label = (k) => (k === 'gwang' ? '광' : SETS[k].short);
    const tags = {};
    const add = (id, t) => { (tags[id] = tags[id] || []); if (!tags[id].some((x) => x.key === t.key && x.kind === t.kind)) tags[id].push(t); };
    for (const h of hand) {
      if (C(h).bonus) continue;
      // 1) 이 카드 자체가 족보 구성원
      for (const k of setsOfCard(h)) if (alive(k) && (k !== 'gwang' || mineCnt('gwang') >= 1)) add(h, { key: k, label: label(k), kind: 'set', near: mineCnt(k) >= 2 });
      // 2) 이 카드로 바닥의 족보 구성원을 먹을 수 있음
      for (const f of floor) {
        if (C(f).m !== C(h).m) continue;
        for (const k of setsOfCard(f)) if (alive(k)) add(h, { key: k, label: label(k), kind: 'set', near: mineCnt(k) >= 2 });
      }
    }
    for (const t of threats(view)) {
      for (const id of t.inHand) add(id, { key: t.key, label: '막기', kind: 'block' });
      for (const id of t.blockers) add(id, { key: t.key, label: '막기', kind: 'block' });
    }
    // 우선순위: 막기 > 거의 완성 > 고도리/단 > 광
    const order = { godori: 0, hong: 1, cheong: 1, cho: 1, gwang: 2 };
    for (const id of Object.keys(tags)) tags[id].sort((a, b) => (b.kind === 'block') - (a.kind === 'block') || (b.near ? 1 : 0) - (a.near ? 1 : 0) || order[a.key] - order[b.key]);
    return tags;
  }

  return { SETS, SET_KEYS, GWANG, setsOfCard, progress, badges, completed, threats, handTags };
});
