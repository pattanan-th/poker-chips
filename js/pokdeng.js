// Pok Deng score keeper. Cards are physical; this records each round's bets and
// results against the banker and keeps everyone's running total. Mutates state in place.
(function (root) {
  'use strict';

  const MULTS = [1, 2, 3, 5];
  const fail = (msg) => { throw new Error(msg); };

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
  }

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
    pd.rounds = pd.rounds.concat({ no: r.no, bankerId: pd.bankerId, bets: r.bets, results: res, delta, names }).slice(-50);
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

  const PokDeng = { MULTS, init, tidy, setBet, deal, reopen, settle, setBanker, setNet };
  if (typeof module !== 'undefined' && module.exports) module.exports = PokDeng;
  else root.PokDeng = PokDeng;
})(this);
