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

console.log(`\n${passed} passed`);
