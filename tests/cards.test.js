// node tests/cards.test.js
const assert = require('assert');
const E = require('../js/engine.js');
const C = require('../js/cards.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('ok  ', name); }
  catch (e) { console.error('FAIL', name, '\n    ', e.message); process.exitCode = 1; }
}

// 'As' -> card number
const c = (t) => C.SUITS.indexOf(t[1]) * 13 + C.RANKS.indexOf(t[0]);
const cs = (str) => str.split(' ').map(c);
const best = (str) => C.best(cs(str));

test('hand categories', () => {
  const cases = [
    ['As Ks Qs Js Ts 2d 3c', 'Straight Flush'],
    ['9h 9d 9s 9c 2d 3c 4h', 'Four of a Kind'],
    ['9h 9d 9s 2c 2d 3c 4h', 'Full House'],
    ['2h 7h 9h Jh Kh 3c 4d', 'Flush'],
    ['Ah 2d 3s 4c 5h 9c Kd', 'Straight'],
    ['7h 7d 7s Ac 2d 9c Kh', 'Three of a Kind'],
    ['7h 7d 2s 2c Ad 9c Kh', 'Two Pair'],
    ['7h 7d 3s 2c Ad 9c Kh', 'One Pair'],
    ['7h 5d 3s 2c Ad 9c Kh', 'High Card'],
  ];
  cases.forEach(([h, name]) => assert.strictEqual(best(h).name, name, h));
});

test('comparisons: kickers, wheel, board plays', () => {
  const cmp = (a, b) => Math.sign(C.compare(best(a).score, best(b).score));
  assert.strictEqual(cmp('Ah Kd 7s 7c 2d 9c 3h', 'Ah Qd 7s 7c 2d 9c 3h'), 1);      // kicker
  assert.strictEqual(cmp('Ah 2d 3s 4c 5h Kc Kd', '6h 2d 3s 4c 5h Kc Kd'), -1);      // wheel < 6-high straight
  assert.strictEqual(cmp('2h 3d As Ks Qs Js Ts', '4h 5d As Ks Qs Js Ts'), 0);       // board royal: split
  assert.strictEqual(cmp('Kh Kd Ks 2c 2d 9c 3h', 'Ah Ad As 2c 2d 9c 3h'), -1);      // bigger full house
  assert.strictEqual(cmp('As Ah Kd Kc 2d 2c 9h', 'As Ah Kd Kc 2d 2c Qh'), -1);      // two pair, best kicker
});

test('shuffle is a permutation and roughly uniform', () => {
  const d = C.shuffle();
  assert.deepStrictEqual(d.slice().sort((a, b) => a - b), Array.from({ length: 52 }, (_, i) => i));
  const N = 52000; const top = new Array(52).fill(0);
  for (let i = 0; i < N; i++) top[C.shuffle()[0]]++;
  top.forEach((n) => assert.ok(n > 800 && n < 1200, `card frequency ${n}`)); // expected 1000
});

test('deal gives unique cards', () => {
  const d = C.deal(['a', 'b', 'c']);
  const all = [...d.hole.a, ...d.hole.b, ...d.hole.c, ...d.board, ...d.rest];
  assert.strictEqual(all.length, 52 - 3); // 3 burns
  assert.strictEqual(new Set(all).size, all.length);
});

test('sync reveals the board by street and judges the showdown', () => {
  const s = E.newGame({ sb: 5, bb: 10, startStack: 1000, appCards: true });
  ['p0', 'p1'].forEach((id) => E.addPlayer(s, id, id));
  const secrets = {};
  E.startHand(s, 0); C.sync(s, secrets, E);
  assert.deepStrictEqual(s.hand.board, []);
  assert.ok(!JSON.stringify(s).includes('"hole"'), 'hole cards must not be in shared state');
  // rig the deal so p1 wins
  secrets[1] = { hole: { p0: cs('2c 7d'), p1: cs('Ah Ad') }, board: cs('Ks 9h 4c 3d Jc'), rest: [] };
  const first = s.hand.toAct; const other = first === 'p0' ? 'p1' : 'p0';
  E.act(s, first, 'call'); C.sync(s, secrets, E);
  E.act(s, other, 'check'); C.sync(s, secrets, E);
  assert.strictEqual(s.hand.board.length, 3);
  for (let k = 0; k < 6; k++) { E.act(s, s.hand.toAct, 'check'); C.sync(s, secrets, E); }
  assert.ok(s.hand.done);
  assert.deepStrictEqual(s.hand.result, { p1: 20 });
  assert.strictEqual(s.hand.shown.p1.hand, 'One Pair');
  assert.strictEqual(s.history[0].board.length, 5);
});

test('sync splits a tied pot', () => {
  const s = E.newGame({ sb: 5, bb: 10, startStack: 1000, appCards: true });
  ['p0', 'p1'].forEach((id) => E.addPlayer(s, id, id));
  const secrets = { 1: { hole: { p0: cs('2c 3d'), p1: cs('4h 5c') }, board: cs('As Ks Qs Js Ts'), rest: [] } };
  E.startHand(s, 0); C.sync(s, secrets, E);
  E.act(s, s.hand.toAct, 'allin'); C.sync(s, secrets, E);
  E.act(s, s.hand.toAct, 'call'); C.sync(s, secrets, E);
  assert.ok(s.hand.done);
  assert.deepStrictEqual(s.players.map((p) => p.stack), [1000, 1000]);
});

test('omaha uses exactly two hole cards', () => {
  // four hearts in hand + one on board is NOT a flush in Omaha
  assert.notStrictEqual(C.bestOmaha(cs('Ah Kh Qh Jh'), cs('2h 7c 8d 9s 3c')).name, 'Flush');
  // board quads: Omaha must still use two hole cards
  assert.strictEqual(C.bestOmaha(cs('2c 3d 4h 5s'), cs('9h 9d 9s 9c Kd')).name, 'Three of a Kind');
  assert.strictEqual(C.bestOmaha(cs('Ah Kh 2c 3d'), cs('Qh Jh Th 4s 5s')).name, 'Straight Flush');
});

test('PLO deal gives 4 cards each and judges with omaha rules', () => {
  const s = E.newGame({ sb: 5, bb: 10, startStack: 1000, appCards: true, game: 'plo' });
  ['p0', 'p1'].forEach((id) => E.addPlayer(s, id, id));
  const secrets = {};
  E.startHand(s, 0); C.sync(s, secrets, E);
  assert.strictEqual(secrets[1].hole.p0.length, 4);
  // p0 holds 4 hearts (one-heart board: no flush), p1 a pair of kings
  secrets[1] = { hole: { p0: cs('Ah Qh Jh Th'), p1: cs('Kc Kd 2s 3s') }, board: cs('2h 7c 5d 8s 4c'), rest: [] };
  E.act(s, s.hand.toAct, 'call'); C.sync(s, secrets, E);
  for (let k = 0; k < 7; k++) { E.act(s, s.hand.toAct, 'check'); C.sync(s, secrets, E); }
  assert.ok(s.hand.done);
  assert.deepStrictEqual(s.hand.result, { p1: 20 });
});

test('too many players for a PLO deal is refused', () => {
  const s = E.newGame({ appCards: true, game: 'plo' });
  for (let i = 0; i < 12; i++) E.addPlayer(s, 'p' + i, 'p' + i);
  E.startHand(s, 0);
  assert.throws(() => C.sync(s, {}, E), /สูงสุด 11/);
});

console.log(`\n${passed} passed`);
