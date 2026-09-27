// 공용 카드 정의 (서버/클라이언트 공용, UMD)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HwatuCards = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MONTH_NAMES = ['', '송학', '매조', '벚꽃', '흑싸리', '난초', '모란', '홍싸리', '공산', '국화', '단풍', '오동', '비'];
  // type: gwang | yeol | tti | pi | ssangpi ; dan: hong | cheong | cho | null
  const T = (type, extra) => Object.assign({ type }, extra || {});
  const LAYOUT = {
    1: [T('gwang'), T('tti', { dan: 'hong' }), T('pi'), T('pi')],
    2: [T('yeol', { godori: true }), T('tti', { dan: 'hong' }), T('pi'), T('pi')],
    3: [T('gwang'), T('tti', { dan: 'hong' }), T('pi'), T('pi')],
    4: [T('yeol', { godori: true }), T('tti', { dan: 'cho' }), T('pi'), T('pi')],
    5: [T('yeol'), T('tti', { dan: 'cho' }), T('pi'), T('pi')],
    6: [T('yeol'), T('tti', { dan: 'cheong' }), T('pi'), T('pi')],
    7: [T('yeol'), T('tti', { dan: 'cho' }), T('pi'), T('pi')],
    8: [T('gwang'), T('yeol', { godori: true }), T('pi'), T('pi')],
    9: [T('yeol'), T('tti', { dan: 'cheong' }), T('pi'), T('pi')],
    10: [T('yeol'), T('tti', { dan: 'cheong' }), T('pi'), T('pi')],
    11: [T('gwang'), T('ssangpi'), T('pi'), T('pi')],
    12: [T('gwang', { bi: true }), T('yeol'), T('tti'), T('ssangpi')],
  };
  const HWATU = [];
  for (let m = 1; m <= 12; m++) {
    LAYOUT[m].forEach((c, i) => {
      HWATU.push(Object.assign({ id: (m - 1) * 4 + i, m, dan: null }, c));
    });
  }
  // 보너스 쌍피 2장 (id 48, 49)
  HWATU.push({ id: 48, m: 0, type: 'ssangpi', bonus: true, dan: null });
  HWATU.push({ id: 49, m: 0, type: 'ssangpi', bonus: true, dan: null });
  HWATU.forEach((c) => { c.piValue = c.type === 'pi' ? 1 : c.type === 'ssangpi' ? 2 : 0; });

  // 섯다 20장: 월별 2장
  const SEOTDA = [];
  for (let m = 1; m <= 10; m++) {
    const first = [1, 3, 8].includes(m) ? 'gwang' : 'yeol';
    const second = m === 8 ? 'yeol' : 'tti';
    const dan = (x) => (x !== 'tti' ? null : [1, 2, 3].includes(m) ? 'hong' : [6, 9, 10].includes(m) ? 'cheong' : 'cho');
    SEOTDA.push({ id: (m - 1) * 2, m, type: first, dan: dan(first) });
    SEOTDA.push({ id: (m - 1) * 2 + 1, m, type: second, dan: dan(second), alt: m === 8 });
  }

  function typeLabel(c) {
    if (c.bonus) return '보너스';
    if (c.type === 'gwang') return c.bi ? '비광' : '광';
    if (c.type === 'yeol') return c.godori ? '고도리' : '열끗';
    if (c.type === 'tti') return c.dan === 'hong' ? '홍단' : c.dan === 'cheong' ? '청단' : c.dan === 'cho' ? '초단' : '띠';
    if (c.type === 'ssangpi') return '쌍피';
    return '피';
  }
  // 국진 (9월 열끗, 술잔): 기본은 쌍피(피 2장, 열끗 아님). 먹은 사람이 열끗으로 쓰겠다고 고르면 열끗 (맞고/고스톱)
  const GUKJIN = 32;
  HWATU[GUKJIN].gukjin = true;
  const GUKJIN_PI = Object.assign({}, HWATU[GUKJIN], { type: 'ssangpi', piValue: 2 });
  // 점수 계산용 카드 속성 (gukYeol: 국진을 열끗으로 쓰기로 했는지)
  const effCard = (id, gukYeol) => (id === GUKJIN && !gukYeol ? GUKJIN_PI : HWATU[id]);
  return { MONTH_NAMES, HWATU, SEOTDA, typeLabel, GUKJIN, effCard };
});
