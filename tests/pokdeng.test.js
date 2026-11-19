// node tests/pokdeng.test.js
const assert = require('assert');
const E = require('../js/engine.js');
const PD = require('../js/pokdeng.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok  ', name); }
  catch (e) { console.error('FAIL', name, '\n    ', e.message); process.exitCode = 1; }
}

function game(n) {
  const s = E.newGame({ mode: 'pokdeng' });
  for (let i = 0; i < n; i++) E.addPlayer(s, 'p' + i, 'P' + i);
  PD.init(s);
  return s;
}
const nets = (s) => s.players.map((p) => p.net || 0);

test('first player is banker; banker cannot bet', () => {
  const s = game(3);
  assert.strictEqual(s.pd.bankerId, 'p0');
  assert.throws(() => PD.setBet(s, 'p0', 10), /เจ้ามือ/);
});

test('round settles against the banker with multipliers; totals sum to zero', () => {
  const s = game(4);
  PD.setBet(s, 'p1', 10); PD.setBet(s, 'p2', 20); PD.setBet(s, 'p3', 50);
  PD.deal(s);
  assert.throws(() => PD.setBet(s, 'p1', 30), /ปิดรับ/);
  PD.settle(s, { p1: { r: 'win', m: 2 }, p2: { r: 'lose', m: 3 }, p3: { r: 'tie', m: 5 } });
  assert.deepStrictEqual(nets(s), [40, 20, -60, 0]);
  assert.strictEqual(nets(s).reduce((a, b) => a + b, 0), 0);
  assert.strictEqual(s.pd.round.no, 2);
  assert.strictEqual(s.pd.round.phase, 'bet');
  assert.deepStrictEqual(s.pd.round.bets, { p1: 10, p2: 20, p3: 50 }); // carried over
  assert.deepStrictEqual(s.pd.rounds[0].delta, { p1: 20, p2: -60, p3: 0, p0: 40 });
});

test('every bettor needs a result; zero bet means sitting the round out', () => {
  const s = game(3);
  PD.setBet(s, 'p1', 10); PD.setBet(s, 'p2', 10); PD.setBet(s, 'p2', 0);
  PD.deal(s);
  assert.deepStrictEqual(Object.keys(s.pd.round.bets), ['p1']);
  assert.throws(() => PD.settle(s, {}), /ยังไม่ได้บันทึกผล/);
  PD.settle(s, { p1: { r: 'lose', m: 1 } });
  assert.deepStrictEqual(nets(s), [10, -10, 0]);
});

test('cannot deal with no bets; changing banker drops their bet', () => {
  const s = game(3);
  assert.throws(() => PD.deal(s), /ยังไม่มีใครลง/);
  PD.setBet(s, 'p1', 10); PD.setBet(s, 'p2', 30);
  PD.setBanker(s, 'p2');
  assert.deepStrictEqual(s.pd.round.bets, { p1: 10 });
  PD.setBet(s, 'p0', 5);
  PD.deal(s);
  PD.settle(s, { p0: { r: 'win', m: 1 }, p1: { r: 'win', m: 5 } });
  assert.deepStrictEqual(nets(s), [5, 50, -55]);
});

test('banker who stands up is replaced; their bets are dropped for players who left', () => {
  const s = game(3);
  PD.setBet(s, 'p1', 10); PD.setBet(s, 'p2', 10);
  s.players[2].left = true;
  s.players[0].left = true;
  PD.tidy(s);
  assert.strictEqual(s.pd.bankerId, 'p1');
  assert.deepStrictEqual(s.pd.round.bets, {});
});


// ---- hands entered by the players, judged by the app ----
// 'Ah' '10d' 'Ks' -> card ids in the cards.js numbering (rank 0 = '2' .. 12 = 'A'; suit s h d c)
const C = (t) => {
  const suit = { s: 0, h: 1, d: 2, c: 3 }[t.slice(-1)];
  const r = t.slice(0, -1);
  return suit * 13 + (r === 'A' ? 12 : r === 'K' ? 11 : r === 'Q' ? 10 : r === 'J' ? 9 : Number(r) - 2);
};
const H = (...ts) => PD.evalHand(ts.map(C));

test('two cards: points are the last digit, 8 and 9 are pok, pair or one suit is deng', () => {
  assert.strictEqual(H('9h', 'Kc').name, 'ป๊อก 9');
  assert.strictEqual(H('4s', '4d').name, 'ป๊อก 8 สองเด้ง');     // pair
  assert.strictEqual(H('5h', '3h').name, 'ป๊อก 8 สองเด้ง');     // same suit
  assert.strictEqual(H('Ah', '5c').points, 6);                  // ace counts 1
  assert.strictEqual(H('Kh', 'Qc').name, 'บอด');                // face cards are 0
  assert.strictEqual(H('7h', '6c').name, '3 แต้ม');
  assert.strictEqual(H('Jh', 'Qh').mult, 2);
});

test('three cards: tong, straight flush, sian, straight, three of a suit', () => {
  assert.strictEqual(H('7h', '7c', '7d').name, 'ตอง'); assert.strictEqual(H('7h', '7c', '7d').mult, 5);
  assert.strictEqual(H('4h', '5h', '6h').name, 'สเตรทฟลัช'); assert.strictEqual(H('4h', '5h', '6h').mult, 5);
  assert.strictEqual(H('Jh', 'Qc', 'Kd').name, 'เซียน (สามเหลือง)'); assert.strictEqual(H('Jh', 'Qc', 'Kd').mult, 3);
  assert.strictEqual(H('9h', '10c', 'Jd').name, 'เรียง');
  assert.strictEqual(H('Ah', '2c', '3d').name, 'เรียง');         // ace low
  assert.strictEqual(H('Qh', 'Kc', 'Ad').name, '1 แต้ม');          // Q-K-A is not a run
  assert.notStrictEqual(H('Qh', 'Kc', 'Ad').kind, 'straight');
  assert.strictEqual(H('2h', '5h', '9h').name, '6 แต้ม สามเด้ง'); assert.strictEqual(H('2h', '5h', '9h').mult, 3);
  assert.strictEqual(H('2h', '5c', '9h').mult, 1);               // a pair of suits is not deng with three cards
  assert.strictEqual(PD.evalHand([C('2h')]), null);
});

test('judge: pok beats everything, specials beat points, equal points tie, winner sets the multiplier', () => {
  const j = (bank, pl) => PD.judge(H(...bank), H(...pl));
  assert.deepStrictEqual(j(['9h', 'Kc'], ['7h', '7c', '7d']), { r: 'lose', m: 1 });     // pok 9 beats tong
  assert.deepStrictEqual(j(['8h', 'Kc'], ['9s', '10c']), { r: 'win', m: 1 });          // pok 9 over pok 8
  assert.deepStrictEqual(j(['8h', 'Kc'], ['5d', '3d']), { r: 'tie', m: 1 });           // both pok 8
  assert.deepStrictEqual(j(['5h', '2c'], ['4s', '4d', '4h']), { r: 'win', m: 5 });      // tong vs 7 points
  assert.deepStrictEqual(j(['Jh', 'Qc', 'Kd'], ['9h', '10c', 'Jd']), { r: 'lose', m: 3 }); // sian beats a straight
  assert.deepStrictEqual(j(['7h', '3c'], ['6s', '4d']), { r: 'tie', m: 1 });           // 0 points each
  assert.deepStrictEqual(j(['2h', '3h'], ['6s', 'Kd']), { r: 'win', m: 1 });           // 6 over 5 (bank is deng, player not)
  assert.deepStrictEqual(j(['6h', '3h'], ['5s', '2d']), { r: 'lose', m: 2 });          // bank is pok 9 and suited (deng), player 7
  assert.deepStrictEqual(j(['10h', '2c'], ['4s', '4d', 'Ah']), { r: 'win', m: 1 });    // 9 points (three cards, no deng) vs 2
});

test('entering cards: only after the deal, no duplicates, auto results once both sides are in', () => {
  const s = game(3);
  PD.setBet(s, 'p1', 10); PD.setBet(s, 'p2', 20);
  assert.throws(() => PD.setCards(s, 'p1', [C('2h'), C('3c')]), /แจกไพ่/);
  PD.deal(s);
  assert.throws(() => PD.setCards(s, 'p1', [C('2h')]), /2–3/);
  assert.throws(() => PD.setCards(s, 'p1', [C('2h'), C('2h')]), /ซ้ำ/);
  PD.setCards(s, 'p0', [C('9h'), C('Kc')]);                       // banker: pok 9
  assert.throws(() => PD.setCards(s, 'p1', [C('9h'), C('2c')]), /ซ้ำกับของ P0/);
  PD.setCards(s, 'p1', [C('4s'), C('4d'), C('4h')]);               // tong, but the banker has pok
  assert.strictEqual(PD.revealed(s), false);
  assert.deepStrictEqual(PD.autoResults(s), { p1: { r: 'lose', m: 1 } });
  PD.setCards(s, 'p2', [C('3h'), C('5c')]);                       // 8 points = pok 8
  assert.strictEqual(PD.revealed(s), true);                       // everyone is in
  assert.deepStrictEqual(PD.autoResults(s), { p1: { r: 'lose', m: 1 }, p2: { r: 'lose', m: 1 } });
  PD.settle(s, PD.autoResults(s));
  assert.deepStrictEqual(nets(s), [30, -10, -20]);
  assert.deepStrictEqual(s.pd.rounds[0].cards.p0, [C('9h'), C('Kc')]);
  assert.deepStrictEqual(s.pd.round.cards || {}, {});             // next round starts empty
});

console.log(`
${passed} passed`);
