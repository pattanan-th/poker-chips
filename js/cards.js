// App-dealt cards for games without a physical deck (Hold'em: 2 hole cards, Omaha: 4,
// Short Deck: Hold'em with the 2s-5s taken out).
// The host phone shuffles with the
// browser's cryptographic RNG, keeps the deck outside the shared state, sends each player
// only their own hole cards, reveals the board street by street and judges the showdown.
(function (root) {
  'use strict';

  const RANKS = '23456789TJQKA';
  const SUITS = ['s', 'h', 'd', 'c'];
  const HAND_NAMES = ['High Card', 'One Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];
  // Short Deck order (Triton rules): a flush beats a full house and three of a kind beats a straight
  const SHORT_NAMES = ['High Card', 'One Pair', 'Two Pair', 'Straight', 'Three of a Kind', 'Full House', 'Flush', 'Four of a Kind', 'Straight Flush'];
  const SHORT_RANK = [0, 1, 2, 4, 3, 6, 5, 7, 8]; // standard category -> short-deck category
  const SHORT_MIN = 4; // rank index of the 6
  const BOARD_SHOWN = { preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5 };

  // card = 0..51; rank 0 ('2') .. 12 ('A')
  const rankOf = (c) => c % 13;
  const suitOf = (c) => Math.floor(c / 13);
  const label = (c) => RANKS[rankOf(c)] + SUITS[suitOf(c)];

  const cryptoObj = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto
    : require('crypto').webcrypto;

  // uniform integer in [0, n) — rejection sampling so no value is favoured
  function randInt(n) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / n) * n;
    do cryptoObj.getRandomValues(buf); while (buf[0] >= limit);
    return buf[0] % n;
  }

  // the cards a game plays with: all 52, or 36 (6 to A) in Short Deck
  const deckOf = (game) => Array.from({ length: 52 }, (_, i) => i).filter((c) => game !== 'short' || rankOf(c) >= SHORT_MIN);

  function shuffle(game) {
    const d = deckOf(game);
    for (let i = d.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
  }

  const holeCount = (game) => (game === 'plo' ? 4 : 2);
  // hole cards each + 3 burns + 5 board must fit in the deck: Hold'em 22, Omaha 11, Short Deck 14
  const maxPlayers = (game) => Math.floor((deckOf(game).length - 8) / holeCount(game));

  // Deal like at a table: one card each around (2 or 4 times), then burn-and-turn the board.
  function deal(ids, game) {
    const deck = shuffle(game);
    const hole = {};
    for (let r = 0; r < holeCount(game); r++) ids.forEach((id) => { (hole[id] = hole[id] || []).push(deck.pop()); });
    const board = [];
    [3, 1, 1].forEach((n) => { deck.pop(); for (let k = 0; k < n; k++) board.push(deck.pop()); });
    return { hole, board, rest: deck };
  }

  // score of exactly 5 cards: [category, ...tiebreak ranks], compared element by element
  function score5(cs, game) {
    const sc = score5std(cs, game === 'short');
    if (game === 'short') sc[0] = SHORT_RANK[sc[0]];
    return sc;
  }

  function score5std(cs, shortDeck) {
    const ranks = cs.map(rankOf).sort((a, b) => b - a);
    const flush = cs.every((c) => suitOf(c) === suitOf(cs[0]));
    const uniq = [...new Set(ranks)];
    let straightHigh = -1;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
      else if (!shortDeck && uniq.join() === '12,3,2,1,0') straightHigh = 3; // A-2-3-4-5
      else if (shortDeck && uniq.join() === '12,7,6,5,4') straightHigh = 7; // A-6-7-8-9: the ace plays low
    }
    if (flush && straightHigh >= 0) return [8, straightHigh];
    const counts = {};
    ranks.forEach((r) => { counts[r] = (counts[r] || 0) + 1; });
    // groups ordered by size, then rank
    const groups = Object.entries(counts).map(([r, n]) => [n, Number(r)]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const byGroup = groups.map((g) => g[1]);
    if (groups[0][0] === 4) return [7, ...byGroup];
    if (groups[0][0] === 3 && groups[1][0] === 2) return [6, ...byGroup];
    if (flush) return [5, ...ranks];
    if (straightHigh >= 0) return [4, straightHigh];
    if (groups[0][0] === 3) return [3, ...byGroup];
    if (groups[0][0] === 2 && groups[1][0] === 2) return [2, ...byGroup];
    if (groups[0][0] === 2) return [1, ...byGroup];
    return [0, ...ranks];
  }

  function compare(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  // best 5 of up to 7 cards
  const nameOf = (score, game) => (game === 'short' ? SHORT_NAMES : HAND_NAMES)[score[0]];

  function best(cards, game) {
    if (cards.length < 5) return null;
    let top = null;
    (function pick(start, chosen) {
      if (chosen.length === 5) {
        const sc = score5(chosen, game);
        if (!top || compare(sc, top) > 0) top = sc;
        return;
      }
      for (let i = start; i <= cards.length - (5 - chosen.length); i++) pick(i + 1, chosen.concat(cards[i]));
    })(0, []);
    return { score: top, name: nameOf(top, game) };
  }

  // Omaha: exactly 2 hole cards + exactly 3 board cards
  function bestOmaha(hole, board) {
    if (board.length < 3) return null;
    let top = null;
    for (let a = 0; a < hole.length; a++) for (let b = a + 1; b < hole.length; b++) {
      for (let i = 0; i < board.length; i++) for (let j = i + 1; j < board.length; j++) for (let k = j + 1; k < board.length; k++) {
        const sc = score5([hole[a], hole[b], board[i], board[j], board[k]]);
        if (!top || compare(sc, top) > 0) top = sc;
      }
    }
    return { score: top, name: HAND_NAMES[top[0]] };
  }

  const bestFor = (hole, board, game) => (game === 'plo' ? bestOmaha(hole, board) : best(hole.concat(board), game));

  // Chance (0..1) that `hole` wins against `opps` unknown hands, by dealing out the unseen cards
  // at random `iters` times. A split counts as a share of the pot.
  function equity(hole, board, opps, game, iters) {
    const seen = new Set(hole.concat(board));
    const unseen = [];
    deckOf(game).forEach((c) => { if (!seen.has(c)) unseen.push(c); });
    const n = holeCount(game);
    const need = opps * n + (5 - board.length);
    if (opps < 1) return 1;
    if (need > unseen.length) return null;
    let won = 0;
    for (let t = 0; t < iters; t++) {
      // partial Fisher-Yates: only the cards we need
      for (let i = 0; i < need; i++) {
        const j = i + Math.floor(Math.random() * (unseen.length - i));
        [unseen[i], unseen[j]] = [unseen[j], unseen[i]];
      }
      const full = board.concat(unseen.slice(opps * n, need));
      const mine = bestFor(hole, full, game).score;
      let tied = 1; let lost = false;
      for (let o = 0; o < opps && !lost; o++) {
        const d = compare(bestFor(unseen.slice(o * n, o * n + n), full, game).score, mine);
        if (d > 0) lost = true; else if (d === 0) tied++;
      }
      if (!lost) won += 1 / tied;
    }
    return won / iters;
  }

  // Bring the shared hand in line with the secret deal. Call on the host after every command.
  // secrets: { [handNo]: deal } kept by the host only. Returns true if it awarded the pot.
  function sync(s, secrets, E) {
    const h = s.hand;
    if (!h || !s.settings.appCards) return false;
    let d = secrets[h.no];
    const n = holeCount(h.game);
    if (!d) {
      if (h.done) return false;
      if (h.ids.length > maxPlayers(h.game)) throw new Error(`แอปแจกไพ่ได้สูงสุด ${maxPlayers(h.game)} คน`);
      d = secrets[h.no] = deal(h.ids, h.game);
      Object.keys(secrets).forEach((k) => { if (Number(k) < h.no - 2) delete secrets[k]; });
    }
    // seats that joined the hand after an undo get cards from the same deck
    h.ids.forEach((id) => {
      if (d.hole[id]) return;
      if (d.rest.length < n) throw new Error('ไพ่ในสำรับไม่พอ');
      d.hole[id] = d.rest.splice(-n);
    });
    h.appCards = true;
    if (!h.done) h.board = d.board.slice(0, BOARD_SHOWN[h.street] || 0);
    let awarded = false;
    if (h.street === 'showdown' && !h.done && h.pots) {
      const live = h.ids.filter((id) => !h.folded[id]);
      const res = {};
      live.forEach((id) => { res[id] = bestFor(d.hole[id], d.board, h.game); });
      const winners = h.pots.map((pot) => {
        const top = pot.elig.reduce((m, id) => (compare(res[id].score, m) > 0 ? res[id].score : m), res[pot.elig[0]].score);
        return pot.elig.filter((id) => compare(res[id].score, top) === 0);
      });
      h.shown = {};
      live.forEach((id) => { h.shown[id] = { cards: d.hole[id], hand: res[id].name }; });
      const i = s.log.length - 1;
      if (i >= 0 && /เลือกผู้ชนะ/.test(s.log[i])) s.log[i] = 'Showdown — เปิดไพ่';
      s.log.push(live.map((id) => `${(s.players.find((p) => p.id === id) || {}).name}: ${res[id].name}`).join(' · '));
      E.award(s, winners);
      awarded = true;
    }
    if (h.done) {
      const last = s.history && s.history[s.history.length - 1];
      if (last && last.no === h.no && !last.board) { last.board = h.board || []; if (h.shown) last.shown = h.shown; }
    }
    return awarded;
  }

  // After the hand, a player may turn their cards face up (e.g. after a fold or an uncalled bet).
  function show(s, secrets, id) {
    const h = s.hand; const d = h && secrets[h.no];
    if (!h || !h.done || !h.appCards || !d || !d.hole[id]) throw new Error('โชว์ไพ่ได้หลังจบมือ (เฉพาะโหมดแอปแจกไพ่)');
    h.shown = h.shown || {};
    if (h.shown[id]) return;
    const board = h.board || [];
    const made = board.length >= 3 ? bestFor(d.hole[id], board, h.game) : null;
    h.shown[id] = { cards: d.hole[id], hand: made ? made.name : '' };
    const last = s.history && s.history[s.history.length - 1];
    if (last && last.no === h.no) last.shown = h.shown;
    s.log.push(`${(s.players.find((p) => p.id === id) || {}).name} โชว์ไพ่${made ? ` (${made.name})` : ''}`);
  }

  const Cards = { RANKS, SUITS, HAND_NAMES, label, rankOf, suitOf, randInt, shuffle, deckOf, deal, score5, best, bestOmaha, bestFor, holeCount, maxPlayers, compare, equity, sync, show };
  if (typeof module !== 'undefined' && module.exports) module.exports = Cards;
  else root.Cards = Cards;
})(this);
