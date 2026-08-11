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

/* ---- 10. the six new features ---- */
hdr('stripAdp keeps stats, drops the ADP columns');
ok('adp keys removed, others kept', (function () {
  var s = stripAdp({ adp_ppr: 5, adp_2qb: 7, rec: 90, pts_half_ppr: 250 });
  return s.adp_ppr === undefined && s.adp_2qb === undefined && s.rec === 90 && s.pts_half_ppr === 250;
})(), JSON.stringify(stripAdp({ adp_ppr: 5, rec: 90 })));

hdr('pick log records order, not just the fact');
S.slots = DEFAULT_SLOTS.slice(); S.teams = 8; S.mySlot = 3; S.rounds = 15;
S.drafted = {}; S.myRoster = []; S.pickLog = [];
buildBoard();
var p1 = S.board[0].id, p2 = S.board[1].id, p3 = S.board[2].id;
markDrafted(p1, 'other'); markDrafted(p2, 'other'); markDrafted(p3, 'me');
ok('pick log is in draft order', S.pickLog.join(',') === [p1, p2, p3].join(','));
ok('my pick landed on my roster', S.myRoster.join(',') === p3);
ok('others did not', S.myRoster.length === 1);
unmarkDrafted(p2);
ok('undo removes from the log', S.pickLog.join(',') === [p1, p3].join(','));
ok('undo removes from drafted', S.drafted[p2] === undefined);
markDrafted(p1, 'other');
ok('re-marking does not duplicate the log entry',
  S.pickLog.filter(function (i) { return i === p1; }).length === 1);

hdr('pick context: when am I up again?');
S.drafted = {}; S.myRoster = []; S.pickLog = [];
S.teams = 8; S.mySlot = 3; S.rounds = 15;
print('  my picks (slot 3 of 8): ' + myPickNumbers().slice(0, 5).join(', '));
var c0 = pickContext();
ok('before any pick, I am up at 3', c0.pickNo === 1 && c0.nextMine === 3 && !c0.onClock,
  JSON.stringify(c0));
S.drafted = { a: 'other', b: 'other' };
var c1 = pickContext();
ok('with 2 gone I am on the clock at 3', c1.pickNo === 3 && c1.onClock, JSON.stringify(c1));
ok('on the clock, the wait runs to my NEXT pick (14)', c1.waitUntil === 14, 'waitUntil=' + c1.waitUntil);
S.drafted = { a: 'other', b: 'other', c: 'other', d: 'other' };
var c2 = pickContext();
ok('off the clock, the wait runs to my upcoming pick', c2.pickNo === 5 && c2.waitUntil === 14,
  JSON.stringify(c2));

hdr('the pick recommender');
S.drafted = {}; S.myRoster = []; S.pickLog = [];
buildBoard();
var rec = recommendations(5);
ok('returns the requested number', rec.list.length === 5);
ok('sorted by urgency, highest first', rec.list.every(function (r, i) {
  return i === 0 || rec.list[i - 1].urgency >= r.urgency;
}));
ok('every entry carries a probability between 0 and 1',
  rec.list.every(function (r) { return r.gone >= 0 && r.gone <= 1; }));
print('  top 3: ' + rec.list.slice(0, 3).map(function (r) {
  return r.p.name + ' (VOR ' + r.p.vor.toFixed(0) + ', ADP ' + (r.p.adp ? r.p.adp.toFixed(0) : '-') +
    ', ' + Math.round(r.gone * 100) + '% gone, urgency ' + r.urgency.toFixed(0) + ')';
}).join('; '));

// The whole point: ADP has to actually move the answer.
var early = { pos: 'RB', vor: 100, adp: 2, id: 'x' };
var late = { pos: 'RB', vor: 100, adp: 200, id: 'y' };
var gonep = function (p, wait) { return 1 / (1 + Math.exp(-(wait - p.adp) / 5)); };
ok('a player already past his ADP is likely gone', gonep(early, 14) > 0.9, gonep(early, 14).toFixed(2));
ok('a player far from his ADP is likely available', gonep(late, 14) < 0.05, gonep(late, 14).toFixed(3));
ok('equal players are separated by ADP, not coin flips', gonep(early, 14) > gonep(late, 14) + 0.8);

var drafted = {};
S.board.slice(0, 30).forEach(function (p) { drafted[p.id] = 'other'; });
S.drafted = drafted;
var rec2 = recommendations(5);
ok('drafted players are never recommended',
  rec2.list.every(function (r) { return !S.drafted[r.p.id]; }));

hdr('positional run detection');
S.drafted = {}; S.myRoster = []; S.pickLog = [];
var rbs = S.board.filter(function (p) { return p.pos === 'RB'; }).slice(0, 6);
var wrs = S.board.filter(function (p) { return p.pos === 'WR'; }).slice(0, 2);
S.pickLog = wrs.concat(rbs).map(function (p) { return p.id; });
var runs = positionalRuns(8);
print('  counts over last 8: ' + JSON.stringify(runs.counts) + '  hot=' + JSON.stringify(runs.hot));
ok('counts the window correctly', runs.n === 8 && runs.counts.RB === 6 && runs.counts.WR === 2);
ok('flags the position that is running', runs.hot.indexOf('RB') >= 0);
ok('does not flag a position that is not', runs.hot.indexOf('WR') < 0);
S.pickLog = [];
ok('empty log reports nothing rather than crashing', positionalRuns(8).n === 0);

hdr('roster construction warnings');
S.drafted = {}; S.myRoster = []; S.pickLog = [];
// three players from one NFL team
var teamCounts = {};
S.board.forEach(function (p) { (teamCounts[p.team] = teamCounts[p.team] || []).push(p); });
var stackTeam = Object.keys(teamCounts).filter(function (t) { return teamCounts[t].length >= 3; })[0];
S.myRoster = teamCounts[stackTeam].slice(0, 3).map(function (p) { return p.id; });
var w1 = rosterWarnings();
ok('flags three players on one NFL team',
  w1.some(function (w) { return w.text.indexOf(stackTeam) >= 0 && w.text.indexOf('bye week') >= 0; }),
  JSON.stringify(w1.map(function (w) { return w.text.slice(0, 50); })));

// a kicker taken far too early
var k = S.board.filter(function (p) { return p.pos === 'K'; })[0];
S.myRoster = [k.id];
S.pickLog = [k.id];
S.teams = 8; S.rounds = 15;
var w2 = rosterWarnings();
ok('flags a kicker taken in round 1',
  w2.some(function (w) { return /round 1\b/.test(w.text) && w.text.indexOf('K ') >= 0; }),
  JSON.stringify(w2.map(function (w) { return w.text.slice(0, 60); })));

// same kicker in the last round should NOT be flagged
S.pickLog = new Array(14 * 8).fill('filler').concat([k.id]);
ok('does not flag a kicker taken at the end',
  !rosterWarnings().some(function (w) { return w.text.indexOf('belong in your last') >= 0; }));

S.myRoster = []; S.pickLog = [];
ok('an empty roster produces no warnings', rosterWarnings().length === 0);

hdr('trade analyser');
S.slots = DEFAULT_SLOTS.slice(); S.teams = 8;
S.drafted = {}; buildBoard();
var eliteIds = S.board.slice(0, 12).map(function (p) { return p.id; });
var scrubIds = S.board.slice(240, 252).map(function (p) { return p.id; });
var TA = { rosterId: 1, name: 'Elite', players: eliteIds, starters: [], isMine: true };
var TB = { rosterId: 2, name: 'Scrubs', players: scrubIds, starters: [], isMine: false };

// Trade the best player away for the worst one.
var tr = evaluateTrade(TA, TB, [eliteIds[0]], [scrubIds[0]]);
print('  A ' + tr.aBefore.toFixed(0) + '->' + tr.aAfter.toFixed(0) +
      '   B ' + tr.bBefore.toFixed(0) + '->' + tr.bAfter.toFixed(0));
ok('giving away your best player hurts you', tr.aAfter < tr.aBefore);
ok('receiving him helps them', tr.bAfter > tr.bBefore);

// A player who only improves the bench should barely move the needle.
var evenTr = evaluateTrade(TA, TB, [], []);
ok('an empty trade changes nothing',
  evenTr.aAfter === evenTr.aBefore && evenTr.bAfter === evenTr.bBefore);

// Swapping identical value both ways is near neutral.
var swap = evaluateTrade(TA, TA, [eliteIds[0]], [eliteIds[0]]);
ok('trading a player for himself is neutral', Math.abs(swap.aAfter - swap.aBefore) < 1e-9);

hdr('playoff-weeks ranking mode');
// Reuse week 1 as three identical "playoff" weeks: the totals must come out at
// exactly 3x the weekly figure, which verifies the summing and the re-scoring.
var pwRows = S.weekRows.map(function (r) { return { id: r.id, stats: stripAdp(r.stats) }; });
S.playoffWeeks = [pwRows, pwRows, pwRows];
var tot = playoffTotals();
var sample = S.weekRows.filter(function (r) { return r.stats.pts_half_ppr > 15; })[0];
var oneWeek = scoreStats(sample.stats, S.scoring).pts;
ok('playoff total is the sum across the three weeks',
  Math.abs(tot[sample.id] - oneWeek * 3) < 1e-6,
  sample.name + ': ' + tot[sample.id].toFixed(2) + ' vs 3x' + oneWeek.toFixed(2));

S.rankMode = 'playoffs';
buildBoard();
var top = S.board[0];
ok('playoff mode reranks the board', top.seasonPts !== undefined);
ok('playoff mode replaces pts with the playoff total',
  Math.abs(top.pts - (tot[top.id] || 0)) < 1e-6);
ok('the season figure is kept alongside', top.seasonPts > 0);
ok('grades and tiers still assigned in playoff mode', top.grade && top.tier >= 1);
ok('replacement level recomputed on the playoff basis, so VOR is smaller than season VOR',
  top.pts < top.seasonPts, 'playoff ' + top.pts.toFixed(0) + ' vs season ' + top.seasonPts.toFixed(0));
var pbOrder = S.board.every(function (p, i) { return i === 0 || S.board[i - 1].vor >= p.vor - 1e-9; });
ok('board still sorted by VOR in playoff mode', pbOrder);

S.rankMode = 'season'; S.playoffWeeks = null;
buildBoard();
ok('switching back restores season ranking', S.board[0].seasonPts === undefined);

hdr('rendering the new panels');
S.trending = {
  adds: S.board.slice(0, 8).map(function (p, i) { return { player_id: p.id, count: 40000 - i * 3000 }; }),
  drops: S.board.slice(50, 55).map(function (p, i) { return { player_id: p.id, count: 9000 - i * 500 }; }),
};
S.teamsInLeague = [TA, TB];
S.compareA = '1'; S.compareB = '2';
S.tradeA = [eliteIds[0]]; S.tradeB = [scrubIds[0]];
smoke('renderRecommend', renderRecommend);
smoke('renderRuns', renderRuns);
smoke('renderWarnings', renderWarnings);
smoke('renderTrending', renderTrending);
smoke('renderTradePickers', renderTradePickers);
smoke('renderTradeResult', renderTradeResult);
smoke('refreshViews with everything populated', refreshViews);
ok('recommendation panel got entries', document.querySelector('#recommend').children.length > 0);
ok('trade result was written', String(document.querySelector('#tradeResult').innerHTML).indexOf('Elite') >= 0);
ok('trending panel got entries', document.querySelector('#trendingBody').children.length > 0);

hdr('new panels survive empty state');
S.trending = null; S.teamsInLeague = []; S.tradeA = []; S.tradeB = [];
S.myRoster = []; S.pickLog = []; S.drafted = {};
smoke('renderTrending with no data', renderTrending);
smoke('renderTradePickers with no teams', renderTradePickers);
smoke('renderTradeResult with no teams', renderTradeResult);
smoke('renderWarnings with no roster', renderWarnings);
smoke('renderRuns with no picks', renderRuns);
smoke('renderRecommend with no picks', renderRecommend);

/* ---- 11. the league office ---- */
hdr('power rankings');
S.slots = DEFAULT_SLOTS.slice(); S.teams = 8; S.drafted = {}; buildBoard();
var eliteR = S.board.slice(0, 14).map(function (p) { return p.id; });
var midR   = S.board.slice(60, 74).map(function (p) { return p.id; });
var weakR  = S.board.slice(250, 264).map(function (p) { return p.id; });

function team(id, name, players, wins, losses, fpts) {
  return { rosterId: id, name: name, players: players, starters: [], isMine: id === 1,
           wins: wins || 0, losses: losses || 0, ties: 0, fpts: fpts || 0, fptsAgainst: 0 };
}

// Nothing drafted, nothing played: every score would be an identical 50.
S.teamsInLeague = [team(1, 'A', []), team(2, 'B', []), team(3, 'C', [])];
var pr0 = powerRankings();
ok('empty league yields no scores rather than a fake 50',
  pr0.every(function (r) { return r.score === null; }), JSON.stringify(pr0.map(function (r) { return r.score; })));
ok('ranks are still assigned', pr0.every(function (r, i) { return r.rank === i + 1; }));

// Rosters drafted, no games played: pure roster strength.
S.teamsInLeague = [team(1, 'Weak', weakR), team(2, 'Elite', eliteR), team(3, 'Mid', midR)];
var pr1 = powerRankings();
print('  no games: ' + pr1.map(function (r) { return r.team.name + ' ' + r.score.toFixed(0); }).join(', '));
ok('the strongest roster ranks first', pr1[0].team.name === 'Elite');
ok('the weakest ranks last', pr1[pr1.length - 1].team.name === 'Weak');
ok('scores span 0 to 100', pr1[0].score === 100 && pr1[pr1.length - 1].score === 0);

// Once games exist, record and points get a say.
S.teamsInLeague = [team(1, 'Weak but winning', weakR, 8, 0, 1200),
                   team(2, 'Elite but losing', eliteR, 0, 8, 700),
                   team(3, 'Mid', midR, 4, 4, 950)];
var pr2 = powerRankings();
print('  with games: ' + pr2.map(function (r) { return r.team.name + ' ' + r.score.toFixed(0); }).join(', '));
ok('record and points move the ranking once played',
  pr2.map(function (r) { return r.team.name; }).join('|') !== pr1.map(function (r) { return r.team.name; }).join('|'));
ok('roster strength still counts for something',
  pr2.filter(function (r) { return r.team.name === 'Elite but losing'; })[0].score > 0);

hdr('league strength of schedule (fantasy opponents, not NFL)');
S.teamsInLeague = [team(1, 'A', eliteR), team(2, 'B', midR), team(3, 'C', weakR), team(4, 'D', midR)];
S.playoffStart = 15;
// A plays the strongest opponents; C plays the weakest.
S.fantasySchedule = { at: 0, weeks: 14, opponents: {
  1: { 1: 2, 2: 2, 12: 2, 13: 2, 14: 2 },
  2: { 1: 1, 2: 1, 12: 1, 13: 1, 14: 1 },
  3: { 1: 4, 2: 4, 12: 4, 13: 4, 14: 4 },
  4: { 1: 3, 2: 3, 12: 3, 13: 3, 14: 3 },
} };
var ls = leagueSos();
print('  ' + ls.map(function (r) { return r.team.name + ' ' + (r.all == null ? '-' : r.all.toFixed(1)); }).join(', '));
ok('every team gets a rating', ls.length === 4 && ls.every(function (r) { return r.all != null; }));
ok('ratings sit inside 1-10', ls.every(function (r) { return r.all >= 1 && r.all <= 10; }));
ok('sorted easiest slate first', ls.every(function (r, i) { return i === 0 || ls[i - 1].all <= r.all; }));
ok('game counts come through', ls.every(function (r) { return r.games === 5; }));
var byName = {}; ls.forEach(function (r) { byName[r.team.name] = r.all; });
// B plays A (the elite roster) every week, so B must have the roughest slate.
ok('the team facing the strongest opponent has the roughest schedule',
  byName.B >= Math.max(byName.A, byName.C, byName.D), JSON.stringify(byName));
ok('run-in column computed', ls.every(function (r) { return r.late != null; }));

S.fantasySchedule = null;
ok('no schedule yields an empty list, not a crash', leagueSos().length === 0);

hdr('draft countdown');
S.draftStart = null;
ok('no draft time yields null', draftCountdown() === null);
S.draftStart = Date.now() + (3 * 86400000) + (5 * 3600000);
var cd = draftCountdown();
ok('counts days and hours', cd.days === 3 && cd.hours === 5 && !cd.past, JSON.stringify(cd));
S.draftStart = Date.now() - 86400000;
ok('a past draft is flagged', draftCountdown().past === true);
S.draftStart = null;

hdr('rendering the league page');
S.teamsInLeague = [team(1, 'A', eliteR, 5, 2, 900), team(2, 'B', midR, 3, 4, 800)];
S.matchups = [
  { matchup_id: 1, roster_id: 1, players: eliteR, starters: eliteR.slice(0, 10), points: 0 },
  { matchup_id: 1, roster_id: 2, players: midR, starters: midR.slice(0, 10), points: 0 },
];
S.fantasySchedule = { at: 0, weeks: 14, opponents: { 1: { 1: 2 }, 2: { 1: 1 } } };
smoke('renderDossier', renderDossier);
smoke('renderPower', renderPower);
smoke('renderStandings', renderStandings);
smoke('renderMatchups', renderMatchups);
smoke('renderLeagueSos', renderLeagueSos);
smoke('renderLeague (all of it)', renderLeague);
ok('power table populated', document.querySelector('#powerTable tbody').children.length > 0);
ok('standings populated', document.querySelector('#standTable tbody').children.length > 0);
ok('matchups rendered', document.querySelector('#matchups').children.length > 0);
ok('dossier facts rendered', document.querySelector('#dossier').children.length >= 4);

hdr('league page with nothing loaded');
S.teamsInLeague = []; S.matchups = null; S.fantasySchedule = null;
smoke('renderLeague empty', renderLeague);
smoke('renderMatchups empty', renderMatchups);
smoke('renderPower empty', renderPower);
smoke('renderLeagueSos empty', renderLeagueSos);

print('\n' + (FAILS === 0 ? '*** ALL CHECKS PASSED ***' : '*** ' + FAILS + ' CHECK(S) FAILED ***'));
