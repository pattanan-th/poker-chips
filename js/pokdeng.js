// Pok Deng score keeper. Cards are physical; this records each round's bets and
// results against the banker and keeps everyone's running total. Mutates state in place.
(function (root) {
  'use strict';

  const MULTS = [1, 2, 3, 5];
  const fail = (msg) => { throw new Error(msg); };

  // ---- hands: what a player holds, worked out from the cards they enter ----
  // card = 0..51, the same numbering as cards.js: rank 0 ('2') .. 12 ('A'), suit 0..3 (s h d c)
  const RANK_CH = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const SUIT_CH = ['♠', '♥', '♦', '♣'];
  const rankIdx = (c) => c % 13;
  const suitIdx = (c) => Math.floor(c / 13);
  const pip = (c) => { const r = rankIdx(c); return r === 12 ? 1 : r >= 8 ? 0 : r + 2; }; // A = 1, 10 J Q K = 0
  const num = (c) => { const r = rankIdx(c); return r === 12 ? 1 : r + 2; };             // A low: A-2-3 runs, Q-K-A does not
  const isFace = (c) => { const r = rankIdx(c); return r >= 9 && r <= 11; };            // J Q K
  const cardText = (c) => RANK_CH[rankIdx(c)] + SUIT_CH[suitIdx(c)];

  // Hand ranking, best first: pok 9 / pok 8 (two cards) > tong > straight flush > sian (J Q K)
  // > straight > points 9..0. Multiplier = the deng of the winning hand: two cards of one suit or a
  // pair x2, three of one suit x3, sian and straight x3, tong and straight flush x5.
  function evalHand(cards) {
    if (!Array.isArray(cards) || cards.length < 2 || cards.length > 3) return null;
    const points = cards.reduce((a, c) => a + pip(c), 0) % 10;
    const sameSuit = cards.every((c) => suitIdx(c) === suitIdx(cards[0]));
    const mk = (kind, key, mult, name) => ({ cards: cards.slice(), kind, key, mult, points, name });
    if (cards.length === 2) {
      const mult = sameSuit || rankIdx(cards[0]) === rankIdx(cards[1]) ? 2 : 1;
      const deng = mult === 2 ? ' สองเด้ง' : '';
      if (points >= 8) return mk('pok', [6, points], mult, `ป๊อก ${points}${deng}`);
      return mk('points', [1, points], mult, `${points === 0 ? 'บอด' : points + ' แต้ม'}${deng}`);
    }
    const ns = cards.map(num).sort((a, b) => a - b);
    const straight = ns[1] === ns[0] + 1 && ns[2] === ns[1] + 1;
    if (ns[0] === ns[2]) return mk('tong', [5, ns[0]], 5, 'ตอง');
    if (straight && sameSuit) return mk('sf', [4, ns[2]], 5, 'สเตรทฟลัช');
    if (cards.every(isFace)) return mk('sian', [3, 0], 3, 'เซียน (สามเหลือง)');
    if (straight) return mk('straight', [2, ns[2]], 3, 'เรียง');
    return mk('points', [1, points], sameSuit ? 3 : 1, `${points === 0 ? 'บอด' : points + ' แต้ม'}${sameSuit ? ' สามเด้ง' : ''}`);
  }

  function cmpKey(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d > 0 ? 1 : -1; }
    return 0;
  }

  // player's result against the banker: { r: 'win' | 'lose' | 'tie', m } (the winner's multiplier)
  function judge(bank, pl) {
    const c = cmpKey(pl.key, bank.key);
    if (c === 0) return { r: 'tie', m: 1 };
    return { r: c > 0 ? 'win' : 'lose', m: (c > 0 ? pl : bank).mult };
  }

  // every bettor whose cards, and the banker's, have been entered
  function autoResults(s) {
    const r = s.pd.round; const out = {};
    const bank = r.cards && r.cards[s.pd.bankerId] && evalHand(r.cards[s.pd.bankerId]);
    if (!bank) return out;
    Object.keys(r.bets).forEach((id) => {
      const h = r.cards[id] && evalHand(r.cards[id]);
      if (h) out[id] = judge(bank, h);
    });
    return out;
  }

  function init(s) {
    if (s.pd) return;
    const first = s.players.find((p) => !p.left);
    s.pd = { bankerId: first ? first.id : null, round: { no: 1, phase: 'bet', bets: {} }, rounds: [] };
  }

  const player = (s, id) => s.players.find((p) => p.id === id) || fail('ไม่พบผู้เล่น');
  const canBet = (s, p) => p.id !== s.pd.bankerId && !p.left && !p.sitOut;

  function addLog(s, text) {
    s.log.push(text);
    if (s.log.length > 60) s.log.splice(0, s.log.length - 60);
  }

  // Keep the banker valid and drop bets of people who can't play this round.
  function tidy(s) {
    init(s);
    const pd = s.pd;
    if (!pd.bankerId || !s.players.some((p) => p.id === pd.bankerId && !p.left)) {
      const next = s.players.find((p) => !p.left);
      pd.bankerId = next ? next.id : null;
    }
    if (pd.round.phase === 'bet') {
      Object.keys(pd.round.bets).forEach((id) => {
        const p = s.players.find((x) => x.id === id);
        if (!p || !canBet(s, p)) delete pd.round.bets[id];
      });
    }
  }

  function setBet(s, id, amount) {
    tidy(s);
    const r = s.pd.round;
    if (r.phase !== 'bet') fail('ปิดรับเดิมพันแล้ว รอรอบหน้า');
    const p = player(s, id);
    if (id === s.pd.bankerId) fail('เจ้ามือไม่ต้องลงเดิมพัน');
    if (!canBet(s, p)) fail('ผู้เล่นนี้พัก/ลุกอยู่');
    const a = Math.floor(Number(amount) || 0);
    if (a < 0) fail('ยอดไม่ถูกต้อง');
    if (a === 0) delete r.bets[id]; else r.bets[id] = a;
  }

  function deal(s) {
    tidy(s);
    const r = s.pd.round;
    if (r.phase !== 'bet') fail('แจกไพ่ไปแล้ว');
    if (!s.pd.bankerId) fail('ยังไม่มีเจ้ามือ');
    if (!Object.keys(r.bets).length) fail('ยังไม่มีใครลงเดิมพัน');
    r.phase = 'result';
    addLog(s, `ป๊อกเด้ง รอบที่ ${r.no} — ปิดรับเดิมพัน แจกไพ่`);
  }

  function reopen(s) {
    const r = s.pd.round;
    if (r.phase !== 'result') fail('ยังรับเดิมพันอยู่');
    r.phase = 'bet';
    r.cards = {}; r.revealed = false;
  }

  // a player (or the banker, for someone without a phone) enters the cards they hold
  function setCards(s, id, cards) {
    tidy(s);
    const r = s.pd.round;
    if (r.phase !== 'result') fail('ใส่ไพ่ได้หลังปิดรับเดิมพันและแจกไพ่แล้ว');
    const p = player(s, id);
    if (id !== s.pd.bankerId && !r.bets[id]) fail('ผู้เล่นคนนี้ไม่ได้ลงรอบนี้');
    r.cards = r.cards || {};
    if (!cards || !cards.length) { delete r.cards[id]; return; }
    const cs = cards.map(Number);
    if (cs.length < 2 || cs.length > 3 || cs.some((c) => !Number.isInteger(c) || c < 0 || c > 51) || new Set(cs).size !== cs.length) fail('ไพ่ต้อง 2–3 ใบ และห้ามซ้ำกัน');
    Object.keys(r.cards).forEach((o) => {
      if (o === id) return;
      const dup = cs.find((c) => r.cards[o].includes(c));
      if (dup != null) fail(`ไพ่ ${cardText(dup)} ซ้ำกับของ ${player(s, o).name} — เช็กอีกที`);
    });
    r.cards[id] = cs;
    addLog(s, `${p.name} ใส่ไพ่แล้ว`);
  }

  // show everyone's cards (also happens by itself once banker and all bettors have entered theirs)
  function reveal(s) {
    const r = s.pd.round;
    if (r.phase !== 'result') fail('ยังไม่ได้แจกไพ่');
    r.revealed = true;
  }
  const revealed = (s) => {
    const r = s.pd.round; const c = r.cards || {};
    return !!(r.revealed || (c[s.pd.bankerId] && Object.keys(r.bets).every((id) => c[id])));
  };

  // results: { playerId: { r: 'win' | 'lose' | 'tie', m: 1|2|3|5 } } for every bettor
  function settle(s, results) {
    const pd = s.pd; const r = pd.round;
    if (r.phase !== 'result') fail('ยังไม่ได้แจกไพ่');
    const delta = {}; const res = {};
    let bank = 0;
    Object.entries(r.bets).forEach(([id, bet]) => {
      const x = results && results[id];
      if (!x || !['win', 'lose', 'tie'].includes(x.r)) fail(`ยังไม่ได้บันทึกผลของ ${player(s, id).name}`);
      const m = x.r === 'tie' ? 1 : Number(x.m);
      if (!MULTS.includes(m)) fail('ตัวคูณไม่ถูกต้อง');
      const d = x.r === 'win' ? bet * m : x.r === 'lose' ? -bet * m : 0;
      delta[id] = d; res[id] = { r: x.r, m };
      bank -= d;
    });
    delta[pd.bankerId] = bank;
    const names = {};
    Object.keys(delta).forEach((id) => { const p = player(s, id); p.net = (p.net || 0) + delta[id]; names[id] = p.name; });
    pd.rounds = pd.rounds.concat({ no: r.no, bankerId: pd.bankerId, bets: r.bets, results: res, delta, names, cards: r.cards || {} }).slice(-50);
    addLog(s, `รอบที่ ${r.no}: ` + Object.entries(delta).filter(([, d]) => d).map(([id, d]) => `${names[id]} ${d > 0 ? '+' : ''}${d}`).join(', '));
    // next round starts with the same bets; players change them if they want
    pd.round = { no: r.no + 1, phase: 'bet', bets: Object.assign({}, r.bets) };
    tidy(s);
  }

  function setBanker(s, id) {
    tidy(s);
    if (s.pd.round.phase !== 'bet') fail('เปลี่ยนเจ้ามือได้ตอนรับเดิมพัน');
    const p = player(s, id);
    if (p.left) fail('ผู้เล่นนี้ลุกไปแล้ว');
    s.pd.bankerId = id;
    delete s.pd.round.bets[id];
    addLog(s, `🏦 ${p.name} เป็นเจ้ามือป๊อกเด้ง`);
  }

  function setNet(s, id, v) {
    const p = player(s, id);
    p.net = Math.floor(Number(v) || 0);
    addLog(s, `${p.name} ยอด → ${p.net} (แก้โดยคนคุมห้อง)`);
  }

  const PokDeng = { MULTS, init, tidy, setBet, deal, reopen, settle, setBanker, setNet, evalHand, judge, autoResults, setCards, reveal, revealed, cardText };
  if (typeof module !== 'undefined' && module.exports) module.exports = PokDeng;
  else root.PokDeng = PokDeng;
})(this);
