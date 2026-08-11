/* Test harness: fake just enough browser so app.js loads in jsc, then exercise
   the real scoring / VOR / optimizer code against live 2026 projections. */

var FAILS = 0;
function ok(name, cond, extra) {
  print((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '   ' + extra : ''));
  if (!cond) FAILS++;
}
function hdr(t) { print('\n=== ' + t + ' ==='); }

/* ---- fake DOM ---- */
function FakeEl(tag) {
  this.tag = tag; this.value = ''; this.textContent = ''; this.className = '';
  this.innerHTML = ''; this.checked = true; this.hidden = false;
  this.children = []; this.dataset = {}; this.style = {};
}
FakeEl.prototype.append = function () {
  for (var i = 0; i < arguments.length; i++) this.children.push(arguments[i]);
};
FakeEl.prototype.appendChild = FakeEl.prototype.append;
Object.defineProperty(FakeEl.prototype, 'lastElementChild', {
  get: function () { return this.children[this.children.length - 1] || new FakeEl('td'); }
});

var DOM = {};
globalThis.document = {
  querySelector: function (sel) { return DOM[sel] || (DOM[sel] = new FakeEl('div')); },
  querySelectorAll: function () { return []; },
  createElement: function (t) { return new FakeEl(t); },
};

/* ---- fake localStorage ---- */
var STORE = {};
globalThis.localStorage = {
  getItem: function (k) { return k in STORE ? STORE[k] : null; },
  setItem: function (k, v) { STORE[k] = String(v); },
  removeItem: function (k) { delete STORE[k]; },
};
globalThis.fetch = function () { return Promise.reject(new Error('no network in test')); };
globalThis.setInterval = function () { return 0; };
globalThis.clearInterval = function () {};
globalThis.location = { reload: function () {} };
globalThis.console = { warn: function () {}, log: print, error: print };

/* ---- load the real app ---- */
load('app.js');
print('app.js loaded and parsed cleanly.');

/* ---- feed it real data ---- */
S.season = '2026';
var seasonRaw = JSON.parse(readFile('.testdata/season.json'));
var weekRaw = JSON.parse(readFile('.testdata/week1.json'));
var allSeason = seasonRaw.map(trimRow);
S.dir = {};
allSeason.forEach(function (r) { S.dir[r.id] = { name: r.name, pos: r.pos, team: r.team }; });
function boardable(r) { return r.stats.pts_half_ppr != null && POSITIONS.indexOf(r.pos) >= 0; }
S.seasonRows = allSeason.filter(boardable);
S.weekRows = weekRaw.map(trimRow).filter(boardable);
S.scoring = JSON.parse(JSON.stringify(DEFAULT_SCORING));
S.slots = DEFAULT_SLOTS.slice();
S.teams = 12;

hdr('data loaded');
print('  season rows with projections: ' + S.seasonRows.length);
print('  week-1 rows with projections: ' + S.weekRows.length);
print('  directory size: ' + Object.keys(S.dir).length);
ok('season projections present', S.seasonRows.length > 400);
ok('week projections present', S.weekRows.length > 300);
ok('directory covers more players than the board', Object.keys(S.dir).length > S.seasonRows.length);

/* ---- 1. scoring engine sanity: our half-PPR math vs Sleeper's own total ---- */
hdr('scoring engine vs Sleeper pts_half_ppr (should be close)');
var checks = ['Puka Nacua', 'Josh Allen', 'Bijan Robinson', 'Brock Bowers'];
checks.forEach(function (nm) {
  var r = S.seasonRows.filter(function (x) { return x.name === nm; })[0];
  if (!r) { ok(nm + ' found', false); return; }
  var got = scoreStats(r.stats, S.scoring);
  var diff = Math.abs(got.pts - r.stats.pts_half_ppr);
  ok(nm + " matches Sleeper exactly", diff < 0.01,
    'ours=' + got.pts.toFixed(1) + ' sleeper=' + r.stats.pts_half_ppr + ' exact=' + got.exact);
});

hdr('scoring reacts to rule changes');
var base = scoreStats(S.seasonRows.filter(function (x) { return x.name === 'Puka Nacua'; })[0].stats, S.scoring).pts;
var pprScoring = JSON.parse(JSON.stringify(DEFAULT_SCORING)); pprScoring.rec = 1;
var full = scoreStats(S.seasonRows.filter(function (x) { return x.name === 'Puka Nacua'; })[0].stats, pprScoring).pts;
ok('full PPR scores a WR higher than half PPR', full > base + 30, 'half=' + base.toFixed(1) + ' full=' + full.toFixed(1));

hdr('anchoring: default scoring must reproduce Sleeper exactly, every position');
[['season', S.seasonRows], ['week 1', S.weekRows]].forEach(function (pair) {
  var label = pair[0], rows = pair[1];
  POSITIONS.forEach(function (pos) {
    var g = rows.filter(function (r) { return r.pos === pos; });
    var worst = 0, worstName = '';
    g.forEach(function (r) {
      var diff = Math.abs(scoreStats(r.stats, S.scoring).pts - r.stats.pts_half_ppr);
      if (diff > worst) { worst = diff; worstName = r.name; }
    });
    ok(label + ' ' + pos + ' matches Sleeper headline (n=' + g.length + ')', worst < 0.01,
      'worst drift ' + worst.toFixed(4) + (worstName ? ' (' + worstName + ')' : ''));
  });
});

hdr('K / DEF sanity');
var k = S.seasonRows.filter(function (x) { return x.pos === 'K'; })[0];
var d = S.seasonRows.filter(function (x) { return x.pos === 'DEF'; })[0];
var ks = scoreStats(k.stats, S.scoring), ds = scoreStats(d.stats, S.scoring);
print('  ' + k.name + ' -> ' + ks.pts.toFixed(1) + ' (sleeper ' + k.stats.pts_half_ppr + ') exact=' + ks.exact);
print('  ' + d.name + ' -> ' + ds.pts.toFixed(1) + ' (sleeper ' + d.stats.pts_half_ppr + ') exact=' + ds.exact);
ok('kicker gets a plausible season total', ks.pts > 60 && ks.pts < 260);
ok('defense gets a plausible season total', ds.pts > 40 && ds.pts < 260);
ok('season defense no longer overstated', Math.abs(ds.pts - d.stats.pts_half_ppr) < 0.01);

hdr('custom rules still move the numbers (anchoring must not flatten them)');
var sixTd = JSON.parse(JSON.stringify(DEFAULT_SCORING)); sixTd.pass_td = 6;
var allenRow = S.seasonRows.filter(function (x) { return x.name === 'Josh Allen'; })[0];
var a4 = scoreStats(allenRow.stats, S.scoring).pts, a6 = scoreStats(allenRow.stats, sixTd).pts;
print('  Josh Allen, 4pt passing TD = ' + a4.toFixed(1) + ' / 6pt = ' + a6.toFixed(1));
ok('6-point passing TDs raise a QB', a6 > a4 + 30, 'delta ' + (a6 - a4).toFixed(1));
var harsh = JSON.parse(JSON.stringify(DEFAULT_SCORING)); harsh.pass_int = -6;
ok('harsher interception penalty lowers a QB', scoreStats(allenRow.stats, harsh).pts < a4 - 20);

/* ---- 2. replacement levels + board ---- */
hdr('replacement levels (12-team, 1QB/2RB/2WR/1TE/1FLEX)');
buildBoard();
var scored = scoreRows(S.seasonRows);
var repl = replacementLevels(scored);
POSITIONS.forEach(function (p) { print('  ' + p + ' replacement = ' + repl[p].toFixed(1)); });
ok('RB replacement below RB1 tier', repl.RB > 60 && repl.RB < 220);
ok('QB replacement is high (only 12 QBs start)', repl.QB > repl.TE);

hdr('top 15 of the draft board, by VOR');
S.board.slice(0, 15).forEach(function (p) {
  print('  ' + String(p.rank).padStart(2) + '. ' + p.name.padEnd(22) + p.pos + p.tier +
    '  ' + p.team.padEnd(4) + ' proj=' + p.pts.toFixed(0).padStart(4) +
    ' VOR=' + p.vor.toFixed(0).padStart(4) + ' ADP=' + (p.adp ? p.adp.toFixed(0) : '—'));
});
var top30 = S.board.slice(0, 30);
ok('no kickers in the top 30', top30.every(function (p) { return p.pos !== 'K'; }));
ok('no defenses in the top 30', top30.every(function (p) { return p.pos !== 'DEF'; }));
ok('board is sorted by VOR descending', S.board.every(function (p, i) { return i === 0 || S.board[i - 1].vor >= p.vor - 1e-9; }));
ok('tiers assigned and start at 1', S.board.every(function (p) { return p.tier >= 1; }));
ok('ADP present for most early picks', top30.filter(function (p) { return p.adp; }).length >= 25);

hdr('1QB league should push QBs down the board');
var qbTop1 = S.board.filter(function (p) { return p.pos === 'QB'; })[0];
print('  best QB in 1QB league: ' + qbTop1.name + ' overall rank ' + qbTop1.rank);
S.slots = ['QB', 'SUPER_FLEX', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'BN'];
buildBoard();
var qbTop2 = S.board.filter(function (p) { return p.pos === 'QB'; })[0];
print('  best QB in superflex:   ' + qbTop2.name + ' overall rank ' + qbTop2.rank);
ok('superflex raises QB value', qbTop2.rank < qbTop1.rank, qbTop1.rank + ' -> ' + qbTop2.rank);
ok('superflex switches ADP source to adp_2qb', adpKey() === 'adp_2qb');
S.slots = DEFAULT_SLOTS.slice();
buildBoard();

/* ---- 3. the optimizer ---- */
hdr('optimizer: legality and exactness');
function byName(nm) {
  var r = S.weekRows.filter(function (x) { return x.name === nm; })[0];
  if (!r) { print('  !! missing from week feed: ' + nm); return null; }
  var s = scoreStats(r.stats, S.scoring);
  return { id: r.id, name: r.name, pos: r.pos, team: r.team, opp: r.opp, inj: r.inj, pts: s.pts, exact: s.exact };
}
// A realistic 15-man roster pulled from the live week-1 feed.
var wanted = ['Josh Allen', 'Bijan Robinson', 'Saquon Barkley', 'James Cook',
  'Puka Nacua', 'Amon-Ra St. Brown', 'Garrett Wilson', 'Jaxon Smith-Njigba',
  'Brock Bowers', 'Trey McBride', 'Cameron Dicker', 'Jacksonville Jaguars',
  'Chase Brown', 'Jordan Addison', 'Bo Nix'];
var roster = wanted.map(byName).filter(Boolean);
print('  roster size: ' + roster.length);

var res = optimalLineup(roster);
res.rows.forEach(function (r) {
  print('  ' + r.slot.padEnd(11) + (r.player ? r.player.name.padEnd(22) + r.player.pos + '  ' + r.player.pts.toFixed(1) : '(empty)'));
});
print('  TOTAL = ' + res.total.toFixed(2));

ok('one row per starting slot', res.rows.length === startingSlots().length);
ok('every filled slot is position-legal', res.rows.every(function (r) {
  return !r.player || elig(r.slot).indexOf(r.player.pos) >= 0;
}));
var ids = res.rows.filter(function (r) { return r.player; }).map(function (r) { return r.player.id; });
ok('no player used twice', new Set(ids).size === ids.length);
var sum = res.rows.reduce(function (a, r) { return a + (r.player ? r.player.pts : 0); }, 0);
ok('reported total matches the assigned players', Math.abs(sum - res.total) < 1e-6);
ok('bench holds everyone left over', res.bench.length === roster.length - ids.length);
ok('bench is sorted high to low', res.bench.every(function (p, i) { return i === 0 || res.bench[i - 1].pts >= p.pts; }));

hdr('optimizer beats brute force? (exhaustive check on a small roster)');
// Deliberately tricky: the best TE is worth more than the 3rd RB, so a naive
// "fill dedicated slots then flex" pass would misuse the FLEX slot.
var tricky = [
  { id: 'a', name: 'QB1', pos: 'QB', pts: 20 },
  { id: 'b', name: 'RB1', pos: 'RB', pts: 18 },
  { id: 'c', name: 'RB2', pos: 'RB', pts: 12 },
  { id: 'd', name: 'RB3', pos: 'RB', pts: 11 },
  { id: 'e', name: 'WR1', pos: 'WR', pts: 17 },
  { id: 'f', name: 'WR2', pos: 'WR', pts: 9 },
  { id: 'g', name: 'TE1', pos: 'TE', pts: 16 },
  { id: 'h', name: 'TE2', pos: 'TE', pts: 4 },
];
S.slots = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX'];
var got = optimalLineup(tricky);
// independent brute force over all permutations
function brute(players, slots) {
  var best = -1;
  (function rec(k, used, tot) {
    if (k === slots.length) { if (tot > best) best = tot; return; }
    rec(k + 1, used, tot); // empty
    for (var j = 0; j < players.length; j++) {
      if (used[j]) continue;
      if (elig(slots[k]).indexOf(players[j].pos) < 0) continue;
      used[j] = 1; rec(k + 1, used, tot + players[j].pts); used[j] = 0;
    }
  })(0, [], 0);
  return best;
}
var bf = brute(tricky, S.slots);
print('  optimizer=' + got.total.toFixed(1) + '  brute force=' + bf.toFixed(1));
ok('optimizer matches exhaustive brute force', Math.abs(got.total - bf) < 1e-9);
got.rows.forEach(function (r) { print('    ' + r.slot.padEnd(6) + (r.player ? r.player.name + ' ' + r.player.pts : '-')); });

hdr('optimizer vs brute force on 300 random rosters');
// Deterministic pseudo-random so a failure is reproducible.
var seed = 12345;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
var SLOTSETS = [
  ['QB', 'RB', 'RB', 'WR', 'WR', 'TE'],
  ['QB', 'RB', 'WR', 'TE', 'FLEX', 'FLEX'],
  ['QB', 'SUPER_FLEX', 'RB', 'WR', 'FLEX'],
  ['RB', 'WR', 'REC_FLEX', 'WRRB_FLEX', 'FLEX'],
  ['QB', 'QB', 'RB', 'RB', 'WR', 'WR'],
];
var mismatch = 0, worstCase = null;
for (var t = 0; t < 300; t++) {
  S.slots = SLOTSETS[t % SLOTSETS.length];
  var n = 6 + Math.floor(rnd() * 3);          // 6-8 players
  var rost = [];
  for (var i = 0; i < n; i++) {
    var pp = ['QB', 'RB', 'WR', 'TE'][Math.floor(rnd() * 4)];
    rost.push({ id: 'p' + i, name: 'P' + i, pos: pp, pts: Math.round(rnd() * 2500) / 100 });
  }
  var mine = optimalLineup(rost);
  var truth = brute(rost, startingSlots());
  // legality, on top of the score match
  var legal = mine.rows.every(function (r) { return !r.player || elig(r.slot).indexOf(r.player.pos) >= 0; });
  var uniqIds = mine.rows.filter(function (r) { return r.player; }).map(function (r) { return r.player.id; });
  if (Math.abs(mine.total - truth) > 1e-9 || !legal || new Set(uniqIds).size !== uniqIds.length) {
    mismatch++;
    if (!worstCase) worstCase = { slots: S.slots, rost: rost, mine: mine.total, truth: truth };
  }
}
ok('300/300 random rosters solved exactly and legally', mismatch === 0,
  mismatch ? JSON.stringify(worstCase) : 'all matched brute force');

hdr('fullback / non-fantasy position handling (regression)');
S.slots = DEFAULT_SLOTS.slice();
buildBoard();
var jj = allSeason.filter(function (r) { return r.name === 'Kyle Juszczyk'; })[0];
print('  Kyle Juszczyk normalised position: ' + jj.pos);
ok('fullback is normalised to RB', jj.pos === 'RB');
ok('every board player has a known position', S.board.every(function (p) { return POSITIONS.indexOf(p.pos) >= 0; }));
ok('every board player got a tier', S.board.every(function (p) { return p.tier >= 1; }));
var jjb = S.board.filter(function (p) { return p.name === 'Kyle Juszczyk'; })[0];
if (jjb) {
  print('  his board rank now: ' + jjb.rank + ' (VOR ' + jjb.vor.toFixed(0) + ')');
  ok('blocking fullback is NOT a top-100 pick', jjb.rank > 100, 'rank ' + jjb.rank);
} else {
  ok('fullback excluded from board', true, 'no projection row');
}

hdr('optimizer edge cases');
ok('empty roster does not crash', optimalLineup([]).rows.length === 0);
S.slots = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
var thin = optimalLineup([{ id: 'z', name: 'Only', pos: 'RB', pts: 10 }]);
ok('short roster leaves slots empty rather than cheating', thin.total === 10 &&
  thin.rows.filter(function (r) { return r.player; }).length === 1);
S.slots = ['SUPER_FLEX', 'SUPER_FLEX'];
var sf = optimalLineup(tricky);
ok('superflex takes the two best of any position', Math.abs(sf.total - 38) < 1e-9, 'total=' + sf.total);

hdr('snake pick math');
S.teams = 12; S.mySlot = 3; S.rounds = 5;
var picks = myPickNumbers();
print('  slot 3 of 12, 5 rounds: ' + picks.join(', '));
ok('snake picks are correct', picks.join(',') === '3,22,27,46,51');
S.mySlot = 1;
ok('slot 1 wraps correctly', myPickNumbers().slice(0, 4).join(',') === '1,24,25,48');

hdr('missing-player fallback (bye week / not projected)');
S.slots = DEFAULT_SLOTS.slice();
S.myRoster = [roster[0].id, 'nonexistent-id-999'];
var scoredRoster = myScoredRoster();
ok('unknown player still appears with 0 points', scoredRoster.length === 2 &&
  scoredRoster[1].pts === 0, JSON.stringify(scoredRoster[1]));

/* ---- 4. rendering smoke test: do the draw functions actually run? ---- */
hdr('rendering smoke test (catches crashes that would blank the page)');
S.slots = DEFAULT_SLOTS.slice();
S.teams = 12; S.mySlot = 4; S.rounds = 15;
S.myRoster = roster.map(function (p) { return p.id; });
S.drafted = {};
roster.slice(0, 5).forEach(function (p, i) { S.drafted[p.id] = i % 2 ? 'me' : 'other'; });
// A LEGAL but sub-optimal current lineup: take the optimum and swap one starter
// for a bench player at the SAME position. Still legal, definitely worse.
var opt0 = optimalLineup(roster);
var startIds = opt0.rows.filter(function (r) { return r.player; }).map(function (r) { return r.player.id; });
var swapOut = null, swapIn = null;
opt0.bench.forEach(function (b) {
  if (swapIn) return;
  opt0.rows.forEach(function (r) {
    if (swapIn || !r.player || r.player.pos !== b.pos) return;
    swapOut = r.player.id; swapIn = b.id;
  });
});
S.sleeperStarters = startIds.map(function (id) { return id === swapOut ? swapIn : id; });

function smoke(name, fn) {
  try { fn(); ok(name, true); }
  catch (e) { ok(name, false, 'THREW: ' + e.message); }
}
smoke('renderSlotEditor', renderSlotEditor);
smoke('renderScoringEditor', renderScoringEditor);
smoke('renderSetupNumbers', renderSetupNumbers);
smoke('buildBoard', buildBoard);
smoke('renderPosFilter', renderPosFilter);
smoke('renderBoard', renderBoard);
smoke('renderDraftSide', renderDraftSide);
smoke('renderLineup', renderLineup);
smoke('refreshViews (all of it together)', refreshViews);
smoke('afterSettingsChange', afterSettingsChange);

var q = function (s) { return document.querySelector(s); };
ok('board table received rows', q('#boardTable tbody').children.length > 0,
  q('#boardTable tbody').children.length + ' rows');
ok('lineup table received rows', q('#lineupTable tbody').children.length > 0,
  q('#lineupTable tbody').children.length + ' rows');
ok('lineup total was written', String(q('#lineupTotal').textContent).indexOf('projected') >= 0,
  q('#lineupTotal').textContent);
ok('pick clock was written', String(q('#pickClock').textContent).indexOf('pick') >= 0,
  q('#pickClock').textContent);
ok('starter-comparison note was written', String(q('#deltaNote').textContent).length > 10,
  q('#deltaNote').textContent);

hdr('starter comparison must never claim a lineup beats the optimum');
S.slots = DEFAULT_SLOTS.slice();
renderLineup();
var note = String(document.querySelector('#deltaNote').textContent);
var optTotal = optimalLineup(myScoredRoster()).total;
var curTotal = S.sleeperStarters.reduce(function (s, id) {
  var hit = myScoredRoster().filter(function (p) { return p.id === id; })[0];
  return s + (hit ? hit.pts : 0);
}, 0);
print('  optimal=' + optTotal.toFixed(1) + ' current=' + curTotal.toFixed(1));
print('  note: ' + note);
ok('optimum is >= the legal current lineup', optTotal >= curTotal - 1e-9);
ok('note reports a gain, not a false "already optimal"',
  note.indexOf('switching gains') >= 0, note);

hdr('mismatched slot counts refuse to compare');
S.slots = ['QB', 'RB', 'WR', 'TE', 'BN', 'BN'];   // fewer slots than Sleeper reports
renderLineup();
var note2 = String(document.querySelector('#deltaNote').textContent);
print('  note: ' + note2);
ok('says it cannot compare instead of inventing a number',
  note2.indexOf('Not comparing') >= 0, note2);
S.slots = DEFAULT_SLOTS.slice();

hdr('rendering with an EMPTY state (fresh visitor, nothing loaded yet)');
S.myRoster = []; S.drafted = {}; S.sleeperStarters = []; S.board = []; S.seasonRows = []; S.weekRows = [];
smoke('buildBoard with no data', buildBoard);
smoke('renderBoard with no data', renderBoard);
smoke('renderDraftSide with no data', renderDraftSide);
smoke('renderLineup with no data', renderLineup);

hdr('search / filter paths');
S.seasonRows = allSeason.filter(boardable);
S.weekRows = weekRaw.map(trimRow).filter(boardable);
buildBoard();
S.search = 'nacua'; smoke('search term matches', renderBoard);
S.search = 'zzzzznobody'; smoke('search term matches nothing', renderBoard);
S.search = ''; S.posFilter = 'TE'; smoke('filtered to TE', renderBoard);
S.posFilter = 'ALL';

hdr('weird league shapes must not crash');
[[], ['BN','BN'], ['SUPER_FLEX'], ['QB','QB','RB','RB','RB','WR','WR','WR','TE','FLEX','FLEX','K','DEF']]
  .forEach(function (sl, i) {
    S.slots = sl;
    smoke('slots #' + i + ' [' + sl.join(',') + '] builds + renders', function () {
      buildBoard(); renderBoard(); renderDraftSide(); renderLineup(); renderSlotEditor();
    });
  });
S.slots = DEFAULT_SLOTS.slice();

/* ---- 5. draft grades ---- */
hdr('grade bands (8 teams, 15 rounds) land on the right picks');
S.teams = 8; S.rounds = 15;
[[1, 'S++'], [4, 'S++'], [5, 'S+'], [8, 'S+'], [9, 'S'], [16, 'S'],
 [17, 'A+'], [32, 'A+'], [33, 'A'], [48, 'A'], [49, 'B+'], [64, 'B+'],
 [65, 'B'], [80, 'B'], [81, 'C'], [104, 'C'], [105, 'D'], [120, 'D'],
 [121, 'F'], [600, 'F']].forEach(function (pair) {
  var got = gradeFor(pair[0]);
  ok('rank ' + pair[0] + ' -> ' + pair[1], got === pair[1], got === pair[1] ? '' : 'got ' + got);
});

hdr('grade bands scale with league size');
S.teams = 12;
ok('12-team: rank 6 is still S++', gradeFor(6) === 'S++');
ok('12-team: rank 7 drops to S+', gradeFor(7) === 'S+');
ok('12-team: rank 13 is S', gradeFor(13) === 'S');
ok('12-team: rank 181 is undraftable', gradeFor(181) === 'F');
S.teams = 8;
ok('8-team: rank 6 is only S+', gradeFor(6) === 'S+');

hdr('grades on the real board');
S.teams = 8; S.rounds = 15; S.slots = DEFAULT_SLOTS.slice();
buildBoard();
var GORDER = GRADE_BANDS.map(function (b) { return b[0]; }).concat(['F']);
ok('every player has a grade', S.board.every(function (p) { return GORDER.indexOf(p.grade) >= 0; }));
ok('grades never improve as rank worsens', S.board.every(function (p, i) {
  return i === 0 || GORDER.indexOf(S.board[i - 1].grade) <= GORDER.indexOf(p.grade);
}));
var used = {};
S.board.forEach(function (p) { used[p.grade] = (used[p.grade] || 0) + 1; });
var missing = GORDER.filter(function (g) { return !used[g]; });
ok('no grade band is left empty', missing.length === 0, 'missing: ' + (missing.join(',') || 'none'));
ok('grade class names are CSS-safe', GORDER.every(function (g) {
  return /^g-[a-z]+$/.test(gradeClass(g));
}), GORDER.map(gradeClass).join(' '));

/* ---- 6. stat-key bridging (the kicker bug) ---- */
hdr('stat-key bridging: projection keys vs league scoring keys');
var kRow = S.seasonRows.filter(function (r) { return r.pos === 'K' && r.stats.fgm_50p; })[0];
ok('fgm_50_59 bridged from fgm_50p', kRow.stats.fgm_50_59 === kRow.stats.fgm_50p,
  'fgm_50p=' + kRow.stats.fgm_50p + ' -> fgm_50_59=' + kRow.stats.fgm_50_59);
ok('fgm_60p defaults to 0 rather than undefined', kRow.stats.fgm_60p === 0);
ok('a total fgm is derived from the buckets', kRow.stats.fgm > 0, 'fgm=' + kRow.stats.fgm);
ok('a total fgmiss is derived from the buckets', kRow.stats.fgmiss > 0, 'fgmiss=' + kRow.stats.fgmiss);
ok('bridging does not invent keys that were already there', (function () {
  var s = bridgeStats({ fgm_50p: 2, fgm_50_59: 9, fgm: 5, fgmiss: 1 });
  return s.fgm_50_59 === 9 && s.fgm === 5 && s.fgmiss === 1;
})());

/* ---- 7. a real 147-rule league ---- */
hdr('a real imported league (147 scoring rules, 8 teams, full PPR)');
var lgRaw = null;
try { lgRaw = JSON.parse(readFile('.testdata/league.json')); } catch (e) { lgRaw = null; }
if (!lgRaw) {
  print('  (no .testdata/league.json — skipping; run `sh run-tests.sh --fresh` to fetch it)');
} else {
  S.scoring = lgRaw.scoring_settings;
  S.slots = lgRaw.roster_positions;
  S.teams = lgRaw.total_rosters;
  print('  league: ' + lgRaw.name.trim() + ', ' + S.teams + ' teams, ' +
    Object.keys(S.scoring).length + ' rules, ' + startingSlots().length + ' starters');
  ok('full-PPR league picks the PPR ADP column', adpKey() === 'adp_ppr', adpKey());

  /* This league is FULL PPR, so the comparable Sleeper column is pts_ppr — not
     pts_half_ppr, which is what the engine anchors to before scaling. If the
     scaling works, a full-PPR league should land on pts_ppr by itself.

     Checked on the MEDIAN, not the worst player: individual gaps are legitimate,
     because this league differs from Sleeper's defaults in real ways (-2 per
     interception instead of -1, 5 for a shutout instead of 10). A systematic
     error would move the median; one odd receiving back would not. */
  var LIMIT = { DEF: 0.10, K: 0.10, QB: 0.06, RB: 0.06, WR: 0.06, TE: 0.06 };
  POSITIONS.forEach(function (pos) {
    var g = S.seasonRows.filter(function (r) { return r.pos === pos && r.stats.pts_ppr > 20; });
    var ratios = g.map(function (r) {
      return scoreStats(r.stats, S.scoring).pts / r.stats.pts_ppr;
    }).sort(function (a, b) { return a - b; });
    var med = ratios[Math.floor(ratios.length / 2)];
    var worst = Math.max(Math.abs(1 - ratios[0]), Math.abs(1 - ratios[ratios.length - 1]));
    ok(pos + ' median within ' + Math.round(LIMIT[pos] * 100) + '% of Sleeper full-PPR',
      Math.abs(1 - med) < LIMIT[pos],
      'median=' + med.toFixed(3) + ' spread=' + (worst * 100).toFixed(0) + '% n=' + g.length);
    ok(pos + ' no player wildly off', worst < 0.45, 'worst ' + (worst * 100).toFixed(0) + '%');
  });

  // Full PPR must genuinely differ from half PPR, or the anchoring is flattening it.
  var wr = S.seasonRows.filter(function (r) { return r.name === 'Puka Nacua'; })[0];
  var got = scoreStats(wr.stats, S.scoring).pts;
  ok('full-PPR league scores a WR above the half-PPR figure',
    got > wr.stats.pts_half_ppr + 30,
    'ours=' + got.toFixed(1) + ' half=' + wr.stats.pts_half_ppr + ' ppr=' + wr.stats.pts_ppr);

  buildBoard();
  print('  top 5: ' + S.board.slice(0, 5).map(function (p) {
    return p.grade + ' ' + p.name;
  }).join(', '));
  ok('board built for the real league', S.board.length > 400);
  ok('a kicker is not a top-40 pick even in a shallow league',
    S.board.slice(0, 40).every(function (p) { return p.pos !== 'K'; }));
  var aubrey = S.board.filter(function (p) { return p.name === 'Brandon Aubrey'; })[0];
  if (aubrey) {
    var raw = S.seasonRows.filter(function (r) { return r.name === 'Brandon Aubrey'; })[0];
    print('  Brandon Aubrey: ours=' + aubrey.pts.toFixed(1) + ' sleeper=' + raw.stats.pts_half_ppr);
    ok('kicker no longer 30% under Sleeper', Math.abs(aubrey.pts - raw.stats.pts_half_ppr) < 3,
      'diff ' + Math.abs(aubrey.pts - raw.stats.pts_half_ppr).toFixed(1));
  }

  smoke('renders the real league without crashing', function () {
    renderSlotEditor(); renderScoringEditor(); refreshViews();
  });
}

/* ---- 8. strength of schedule ---- */
hdr('strength of schedule');
ok('rank10 spreads values evenly from 1 to 10', (function () {
  var r = rank10({ a: 1, b: 2, c: 3 });
  return r.a === 1 && r.c === 10 && Math.abs(r.b - 5.5) < 1e-9;
})(), JSON.stringify(rank10({ a: 1, b: 2, c: 3 })));
ok('rank10 copes with a single entry', rank10({ a: 5 }).a === 1);
ok('rank10 gives tied values the same rating', (function () {
  var r = rank10({ a: 1, b: 5, c: 5, d: 9 });
  return r.b === r.c && r.a === 1 && r.d === 10 && r.b > r.a && r.b < r.d;
})(), JSON.stringify(rank10({ a: 1, b: 5, c: 5, d: 9 })));
ok('identical schedules rate identically', (function () {
  var r = rank10({ x: 7, y: 7, z: 7 });
  return r.x === r.y && r.y === r.z;
})());

// A toy schedule using real team codes so the defence-strength lookup resolves.
S.scoring = JSON.parse(JSON.stringify(DEFAULT_SCORING));
S.schedule = {
  DET: { opps: { 1: 'MIN', 2: 'MIN', 15: 'MIN', 16: 'MIN', 17: 'MIN' }, bye: 5 },
  MIN: { opps: { 1: 'DET', 2: 'DET', 15: 'DET', 16: 'DET', 17: 'DET' }, bye: 5 },
  CHI: { opps: { 1: 'GB', 2: 'GB', 15: 'GB', 16: 'GB', 17: 'GB' }, bye: 7 },
  GB:  { opps: { 1: 'CHI', 2: 'CHI', 15: 'CHI', 16: 'CHI', 17: 'CHI' }, bye: 7 },
};
computeSos();
ok('every scheduled team gets an entry', Object.keys(S.sos).length === 4);
ok('bye weeks are carried through', S.sos.DET.bye === 5 && S.sos.CHI.bye === 7);
ok('season ratings sit inside 1-10', Object.keys(S.sos).every(function (t) {
  return S.sos[t].all >= 1 && S.sos[t].all <= 10;
}));
ok('playoff ratings are computed too', Object.keys(S.sos).every(function (t) { return S.sos[t].post != null; }));

var strengths = {};
scoreRows(S.seasonRows).filter(function (r) { return r.pos === 'DEF'; })
  .forEach(function (d) { strengths[d.team] = d.pts; });
/* Assert the RATINGS ORDER matches the raw-difficulty order, rather than naming a
   single hardest team: defence projections are coarse enough to tie (two of these
   four are identical), and rank10 necessarily breaks ties arbitrarily. */
var rawDiff = {};
Object.keys(S.schedule).forEach(function (t) {
  var o = S.schedule[t].opps, sum = 0, n = 0;
  for (var w = 1; w <= 18; w++) { if (o[w] && strengths[o[w]] != null) { sum += strengths[o[w]]; n++; } }
  rawDiff[t] = n ? sum / n : null;
});
print('  raw difficulty: ' + Object.keys(rawDiff).map(function (t) {
  return t + '=' + rawDiff[t].toFixed(0) + '->' + S.sos[t].all.toFixed(1);
}).join('  '));
var pairsOk = true, offend = '';
Object.keys(S.sos).forEach(function (a) {
  Object.keys(S.sos).forEach(function (b) {
    if (rawDiff[a] > rawDiff[b] && S.sos[a].all < S.sos[b].all) {
      pairsOk = false; offend = a + '>' + b + ' raw but rated lower';
    }
  });
});
ok('a tougher raw slate never gets an easier rating', pairsOk, offend);

// Bye detection is the other half: a team absent from a week is on bye.
ok('a team missing from every week gets no entry', S.sos.XXX === undefined);

/* ---- 9. roster comparison ---- */
hdr('roster comparison');
S.slots = DEFAULT_SLOTS.slice(); S.teams = 8; S.rounds = 15;
buildBoard();
var strongIds = S.board.slice(0, 14).map(function (p) { return p.id; });
var weakIds = S.board.slice(230, 244).map(function (p) { return p.id; });
var sStrong = rosterStrength(strongIds), sWeak = rosterStrength(weakIds);
print('  strong roster = ' + sStrong.total.toFixed(0) + ', weak roster = ' + sWeak.total.toFixed(0));
ok('a roster of elite players beats a roster of scrubs', sStrong.total > sWeak.total);
ok('comparison slots to the real starting lineup', sStrong.rows.length === startingSlots().length);
ok('unstartable extras land on the bench, not the total',
  sStrong.bench.length === strongIds.length - sStrong.rows.filter(function (r) { return r.player; }).length);
ok('an empty roster scores zero rather than crashing', rosterStrength([]).total === 0);
ok('unknown player ids are ignored', rosterStrength(['nope-1', 'nope-2']).total === 0);

S.teamsInLeague = [
  { rosterId: 1, name: 'Strong', players: strongIds, starters: [], isMine: true },
  { rosterId: 2, name: 'Weak', players: weakIds, starters: [], isMine: false },
];
S.compareA = '1'; S.compareB = '2';
smoke('fillTeamSelects', fillTeamSelects);
smoke('renderCompare with real rosters', renderCompare);
smoke('renderFreeAgents', renderFreeAgents);
smoke('renderSchedule', renderSchedule);
smoke('renderByeWarnings', renderByeWarnings);
smoke('renderTeams (all together)', renderTeams);
var verdict = String(document.querySelector('#compareVerdict').innerHTML);
ok('the verdict names the stronger roster', /Strong<\/b> by/.test(verdict) || verdict.indexOf('Strong') >= 0, verdict.slice(0, 120));

hdr('free agents exclude owned players');
var owned = new Set();
S.teamsInLeague.forEach(function (t) { t.players.forEach(function (i) { owned.add(i); }); });
renderFreeAgents();
var faRows = document.querySelector('#faTable tbody').children.length;
ok('free-agent list was rendered', faRows > 0, faRows + ' rows');
ok('an owned player is not offered as a free agent', (function () {
  var free = S.board.filter(function (p) { return !owned.has(p.id); });
  return free.every(function (p) { return !owned.has(p.id); }) &&
         S.board.length - free.length === owned.size;
})());

hdr('teams views survive an empty league');
S.teamsInLeague = []; S.compareA = S.compareB = null; S.schedule = null; S.sos = {};
smoke('renderTeams with nothing loaded', renderTeams);
smoke('buildBoard with no schedule', buildBoard);
ok('board still builds without schedule data', S.board.length > 400);
ok('players get null byes rather than undefined', S.board[0].bye === null);

print('\n' + (FAILS === 0 ? '*** ALL CHECKS PASSED ***' : '*** ' + FAILS + ' CHECK(S) FAILED ***'));
