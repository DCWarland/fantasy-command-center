/* =============================================================================
   Fantasy Command Center — draft board + lineup optimizer
   Runs entirely in the browser. Data comes from Sleeper's public read-only API.

   Reading order if you want to follow the logic:
     1. CONSTANTS      – slot rules and default scoring
     2. PLUMBING       – tiny helpers, saved state, API calls
     3. SCORING ENGINE – turns raw projected stats into YOUR league's points
     4. DRAFT MATH     – value over replacement + tiers
     5. OPTIMIZER      – picks the best legal starting lineup
     6. RENDERING      – draws each tab
     7. WIRING         – buttons, inputs, startup
   ========================================================================== */

/* ============================== 1. CONSTANTS ============================= */

const API = 'https://api.sleeper.app';
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

// Which positions each roster slot will accept.
const SLOT_ELIG = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DEF: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  WRRB_WRT: ['RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};
const BENCH_SLOTS = new Set(['BN', 'IR', 'TAXI']);
// Slot types offered in the setup editor (plus anything your league adds).
const SLOT_MENU = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'REC_FLEX', 'WRRB_FLEX', 'K', 'DEF', 'BN'];

// Half-PPR, matching Sleeper's own default so the numbers here line up with the
// numbers in the Sleeper app. Importing a league overwrites all of this.
const DEFAULT_SCORING = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, pass_2pt: 2,
  rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
  rec: 0.5, rec_yd: 0.1, rec_td: 6, rec_2pt: 2,
  fum_lost: -2,
  xpm: 1, xpmiss: -1,
  fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50p: 5,
  fgmiss_0_19: -1, fgmiss_20_29: -1, fgmiss_30_39: -1, fgmiss_40_49: -1, fgmiss_50p: -1,
  sack: 1, int: 2, fum_rec: 2, safe: 2, blk_kick: 2, def_td: 6, def_st_td: 6, def_kr_td: 6, pr_td: 6,
  pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, pts_allow_14_20: 1,
  pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4,
};
const DEFAULT_SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF',
  'BN', 'BN', 'BN', 'BN', 'BN', 'BN'];

// How the scoring editor is grouped, purely cosmetic.
const SCORING_GROUPS = [
  ['Passing', k => k.startsWith('pass_') || k === 'cmp_pct'],
  ['Rushing', k => k.startsWith('rush_')],
  ['Receiving', k => k.startsWith('rec') || k.startsWith('bonus_rec')],
  ['Kicking', k => k.startsWith('fg') || k.startsWith('xp')],
  ['Defense', k => /^(def|idp|pts_allow|yds_allow|sack|int|fum_rec|ff|safe|blk|tkl|pr_|kr_)/.test(k)],
  ['Other', () => true],
];

const CACHE_MS = 6 * 60 * 60 * 1000; // re-download projections after 6 hours

/* ============================== 2. PLUMBING ============================== */

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const fmt = (n, d = 1) => (n == null || isNaN(n) ? '—' : Number(n).toFixed(d));
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};

// localStorage wrapper. localStorage = a small key/value store the browser keeps
// on disk for this site, so your settings survive a page refresh.
const LS = {
  get(k, dflt) {
    try { const v = localStorage.getItem('ffcc.' + k); return v == null ? dflt : JSON.parse(v); }
    catch (e) { return dflt; }
  },
  set(k, v) {
    try { localStorage.setItem('ffcc.' + k, JSON.stringify(v)); }
    catch (e) { console.warn('Could not save', k, e); }
  },
  del(k) { localStorage.removeItem('ffcc.' + k); },
  clearAll() { Object.keys(localStorage).filter(k => k.startsWith('ffcc.')).forEach(k => localStorage.removeItem(k)); },
};

// Everything the page knows, in one place.
const S = {
  season: null, seasonType: null, week: 1,
  // Prefilled so the league connects on first load; change it in the box to use
  // a different Sleeper account.
  username: LS.get('username', 'TheHadly'),
  userId: LS.get('userId', null),
  leagues: [],
  leagueId: LS.get('leagueId', null),
  leagueName: LS.get('leagueName', ''),
  scoring: LS.get('scoring', { ...DEFAULT_SCORING }),
  slots: LS.get('slots', [...DEFAULT_SLOTS]),
  teams: LS.get('teams', 12),
  mySlot: LS.get('mySlot', 1),
  rounds: LS.get('rounds', 15),
  dir: {},           // player_id -> {name,pos,team} for every NFL player
  seasonRows: [],    // season-long projections (raw stats)
  weekRows: [],      // this week's projections
  board: [],         // scored + valued draft board
  schedule: null,    // {team: {opps:{week:opp}, bye}}
  sos: {},           // {team: {bye, all, post}} strength of schedule, 1-10
  teamsInLeague: [], // every roster in the league, for comparing
  compareA: null, compareB: null,
  tradeA: [], tradeB: [],          // player_ids selected in the trade analyser
  playoffWeeks: null,              // [rows wk15, rows wk16, rows wk17]
  rankMode: LS.get('rankMode', 'season'),   // 'season' | 'playoffs'
  trending: null,                  // {adds:[{player_id,count}], drops:[...]}
  pickLog: LS.get('pickLog', []),  // player_ids in the order they were drafted
  drafted: LS.get('drafted', {}),      // player_id -> 'me' | 'other'
  myRoster: LS.get('myRoster', []),    // player_ids on my team
  sleeperStarters: [],                 // what Sleeper currently has me starting
  draftId: null,
  syncTimer: null,
  posFilter: 'ALL',
  faPos: 'ALL',
  search: '',
};

function save() {
  ['username', 'userId', 'leagueId', 'leagueName', 'scoring', 'slots', 'teams', 'mySlot', 'rounds',
    'drafted', 'myRoster', 'pickLog', 'rankMode'].forEach(k => LS.set(k, S[k]));
}

function say(sel, msg, kind = '') {
  const n = $(sel);
  n.textContent = msg;
  n.className = 'status ' + kind;
}

const elig = slot => SLOT_ELIG[slot] || [slot];
const startingSlots = () => S.slots.filter(s => !BENCH_SLOTS.has(s));

/* Marking picks goes through here so the ORDER is recorded, not just the fact. Run
   detection and "what round did I take my kicker" both need the sequence. */
function markDrafted(id, who) {
  S.drafted[id] = who;
  if (!S.pickLog.includes(id)) S.pickLog.push(id);
  if (who === 'me' && !S.myRoster.includes(id)) S.myRoster.push(id);
  save(); refreshViews();
}

function unmarkDrafted(id) {
  delete S.drafted[id];
  S.pickLog = S.pickLog.filter(i => i !== id);
  S.myRoster = S.myRoster.filter(i => i !== id);
  save(); refreshViews();
}

/* -- Sleeper API ---------------------------------------------------------- */

async function api(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`Sleeper said ${r.status} for ${path}`);
  return r.json();
}

function projUrl(season, week) {
  const pos = POSITIONS.map(p => 'position[]=' + p).join('&');
  const base = week ? `/projections/nfl/${season}/${week}` : `/projections/nfl/${season}`;
  return `${base}?season_type=regular&order_by=pts_half_ppr&${pos}`;
}

/* Sleeper's `position` is the real NFL position, which is not always a fantasy
   position: fullbacks come back as FB, punters as P. Left alone, an FB would get
   no replacement level (so a monstrous, bogus draft value) and could never be
   slotted. Fall back to fantasy_positions so Kyle Juszczyk counts as a RB. */
function fantasyPos(p) {
  if (POSITIONS.includes(p.position)) return p.position;
  return (p.fantasy_positions || []).find(x => POSITIONS.includes(x)) || '';
}

/* Leagues and projections don't always use the same key for the same thing. This
   league scores `fgm_50_59` and `fgm_60p`, but the feed only reports `fgm_50p`; it
   takes -1 for any miss via `fgmiss`, while the feed splits misses into
   `fgmiss_40_49` / `fgmiss_50p`. None of those keys lined up, so kickers came out
   32% low. Fill in the aliases so either vocabulary scores correctly. */
function bridgeStats(s) {
  const out = { ...s };
  const sum = keys => keys.reduce((a, k) => a + (out[k] || 0), 0);

  if (out.fgm_50p != null && out.fgm_50_59 == null) {
    out.fgm_50_59 = out.fgm_50p;   // the feed doesn't split 50-59 from 60+
    if (out.fgm_60p == null) out.fgm_60p = 0;
  }
  if (out.fgm == null) {
    const made = sum(['fgm_0_19', 'fgm_20_29', 'fgm_30_39', 'fgm_40_49', 'fgm_50p']);
    if (made) out.fgm = made;
  }
  if (out.fgmiss == null) {
    const miss = sum(['fgmiss_0_19', 'fgmiss_20_29', 'fgmiss_30_39', 'fgmiss_40_49', 'fgmiss_50p']);
    if (miss) out.fgmiss = miss;
  }
  return out;
}

// Strip the giant API response down to just what we use, so it fits in storage.
function trimRow(r) {
  const p = r.player || {};
  return {
    id: r.player_id,
    name: `${p.first_name || ''} ${p.last_name || ''}`.trim(),
    pos: fantasyPos(p),
    team: r.team || p.team || 'FA',
    inj: p.injury_status || '',
    opp: r.opponent || '',
    stats: bridgeStats(r.stats || {}),
  };
}

async function loadSeason(force) {
  const key = `cache.season.${S.season}`;
  const hit = LS.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit;

  const raw = await api(projUrl(S.season, null));
  const all = raw.map(trimRow);
  const rec = {
    at: Date.now(),
    // Directory of every player so we can name anyone on your roster.
    dir: Object.fromEntries(all.map(r => [r.id, { name: r.name, pos: r.pos, team: r.team }])),
    // Only players with a projection AND a fantasy position belong on the board.
    rows: all.filter(r => r.stats.pts_half_ppr != null && POSITIONS.includes(r.pos)),
  };
  LS.set(key, rec);
  return rec;
}

async function loadWeek(week, force) {
  const key = `cache.week.${S.season}.${week}`;
  const hit = LS.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit;

  const raw = await api(projUrl(S.season, week));
  const rec = {
    at: Date.now(),
    rows: raw.map(trimRow).filter(r => r.stats.pts_half_ppr != null && POSITIONS.includes(r.pos)),
  };
  LS.set(key, rec);
  return rec;
}

// The adp_* keys only matter on the season feed; dropping them keeps the weekly
// caches small enough to sit comfortably in browser storage.
function stripAdp(stats) {
  const out = {};
  Object.keys(stats).forEach(k => { if (!k.startsWith('adp')) out[k] = stats[k]; });
  return out;
}

/* Projections for the fantasy playoff weeks only. Ranking by these instead of the
   full season answers a different and often more useful question: not "who scores
   most this year" but "who scores most in the three weeks that decide it". */
async function loadPlayoffWeeks(force) {
  const key = `cache.playoff.${S.season}`;
  const hit = LS.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit;

  const weeks = await Promise.all(PLAYOFF_WEEKS.map(w =>
    api(projUrl(S.season, w)).then(raw => raw.map(trimRow)
      .filter(r => r.stats.pts_half_ppr != null && POSITIONS.includes(r.pos))
      .map(r => ({ id: r.id, stats: stripAdp(r.stats) })))));

  const rec = { at: Date.now(), weeks };
  LS.set(key, rec);
  return rec;
}

// Total projected points across weeks 15-17 under the current scoring rules.
function playoffTotals() {
  if (!S.playoffWeeks) return null;
  const tot = {};
  S.playoffWeeks.forEach(rows => rows.forEach(r => {
    tot[r.id] = (tot[r.id] || 0) + scoreStats(r.stats, S.scoring).pts;
  }));
  return tot;
}

/* Who the whole Sleeper platform is adding and dropping right now. This is the
   earliest widely-available signal that a player's role has changed — usually
   hours ahead of it being obvious from a box score. */
async function loadTrending() {
  const [adds, drops] = await Promise.all([
    api('/v1/players/nfl/trending/add?lookback_hours=24&limit=25').catch(() => []),
    api('/v1/players/nfl/trending/drop?lookback_hours=24&limit=15').catch(() => []),
  ]);
  return { adds: adds || [], drops: drops || [] };
}

/* ---- the NFL schedule, and strength of schedule ------------------------

   Sleeper publishes no schedule endpoint. But every weekly projection row carries
   that player's opponent for the week — so asking for DEFENCES only (32 rows a week
   instead of ~3000) reconstructs the entire schedule for a fraction of the data,
   bye weeks included: a team missing from a week is a team on bye. */
const PLAYOFF_WEEKS = [15, 16, 17];

async function loadSchedule(force) {
  const key = `cache.sched.${S.season}`;
  const hit = LS.get(key);
  if (!force && hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit;

  const weeks = await Promise.all(
    Array.from({ length: 18 }, (_, i) =>
      api(`/projections/nfl/${S.season}/${i + 1}?season_type=regular&position[]=DEF`)
        .then(rows => rows.map(r => [r.team, r.opponent]))
        .catch(() => []))
  );

  const teams = {};
  weeks.forEach((rows, i) => rows.forEach(([t, opp]) => {
    if (!t) return;
    (teams[t] = teams[t] || { opps: {}, bye: null }).opps[i + 1] = opp || null;
  }));
  Object.keys(teams).forEach(t => {
    for (let w = 1; w <= 18; w++) {
      if (!teams[t].opps[w]) { teams[t].bye = w; break; }
    }
  });

  const rec = { at: Date.now(), teams };
  LS.set(key, rec);
  return rec;
}

/* Spread a set of raw values evenly over 1-10, so the number means "ranked against
   the other 31 teams" rather than depending on an arbitrary scaling constant.

   Ties share the midpoint of the positions they occupy. Without that, two teams with
   genuinely identical schedules would be handed different ratings purely by sort
   order — which is exactly what happened the first time this ran. */
function rank10(raw) {
  const entries = Object.entries(raw).sort((a, b) => a[1] - b[1]);
  const span = Math.max(1, entries.length - 1);
  const out = {};
  for (let i = 0; i < entries.length;) {
    let j = i;
    while (j + 1 < entries.length && entries[j + 1][1] === entries[i][1]) j++;
    const score = 1 + 9 * ((i + j) / 2) / span;
    for (let k = i; k <= j; k++) out[entries[k][0]] = score;
    i = j + 1;
  }
  return out;
}

/* Strength of schedule.

   This API carries no "fantasy points allowed by position" data, so we proxy defensive
   toughness with each defence's OWN projected fantasy output: units that pile up
   sacks, interceptions and shutouts are the ones that smother opposing offences. It's
   a proxy — good for sorting matchups, not for precision — and worth saying so out
   loud rather than dressing it up as more than it is. */
function computeSos() {
  S.sos = {};
  if (!S.schedule) return;

  const strength = {};
  scoreRows(S.seasonRows).filter(r => r.pos === 'DEF').forEach(d => strength[d.team] = d.pts);
  if (!Object.keys(strength).length) return;

  const rawAll = {}, rawPost = {};
  Object.keys(S.schedule).forEach(t => {
    const opps = S.schedule[t].opps;
    const all = [], post = [];
    for (let w = 1; w <= 18; w++) {
      const o = opps[w];
      if (!o || strength[o] == null) continue;
      all.push(strength[o]);
      if (PLAYOFF_WEEKS.includes(w)) post.push(strength[o]);
    }
    const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
    if (all.length) rawAll[t] = avg(all);
    if (post.length) rawPost[t] = avg(post);
  });

  const r1 = rank10(rawAll), r2 = rank10(rawPost);
  Object.keys(S.schedule).forEach(t => {
    S.sos[t] = {
      bye: S.schedule[t].bye,
      all: r1[t] ?? null,     // 1 = easiest slate, 10 = hardest
      post: r2[t] ?? null,    // same, but only the fantasy playoff weeks
    };
  });
}

/* =========================== 3. SCORING ENGINE =========================== */

/* Sleeper uses the SAME key names for "points per stat" as it does for "projected
   stat totals" (pass_yd, rec, sack, ...), so applying a set of scoring rules to a
   player is just a sum of (points per stat x projected stat). */
function dot(stats, weights) {
  let sum = 0;
  for (const k in weights) {
    const w = weights[k];
    if (!w) continue;
    const v = stats[k];
    if (typeof v === 'number') sum += v * w;
  }
  return sum;
}

/* Sleeper gives us two things per player that don't quite agree: a headline
   projected point total, and the projected component stats behind it. The total
   is modelled separately (so a QB's components can add to 20.8 while the headline
   says 22.9), and some component lines are plain wrong — season-long defenses
   overstate by about 13%. Trusting either number alone is a mistake.

   So use both. Work out what these components are worth under Sleeper's own
   default rules, see how YOUR rules differ, and apply that difference to
   Sleeper's headline number. Score like Sleeper's default and you get Sleeper's
   exact projection; score TDs at 6 instead of 4 and you get it scaled up to
   match. `exact:false` means there was no headline number to anchor to, so the
   figure is a raw stat sum and less trustworthy — the UI marks those with a *. */
function scoreStats(stats, scoring) {
  const canned = stats.pts_half_ppr;
  if (typeof canned !== 'number') return { pts: dot(stats, scoring), exact: false };

  const baseline = dot(stats, DEFAULT_SCORING);
  // Nothing meaningful to scale against: either no positive anchor, or a headline
  // number with almost no stat detail behind it (deep-bench players). Take
  // Sleeper's figure as-is and flag it as not adjusted for your rules.
  if (canned <= 0 || baseline <= 1) return { pts: canned, exact: false };

  return { pts: canned * (dot(stats, scoring) / baseline), exact: true };
}

// Which of Sleeper's ADP flavours best matches this league.
function adpKey() {
  const superflex = S.slots.some(s => s === 'SUPER_FLEX') ||
    S.slots.filter(s => s === 'QB').length > 1;
  if (superflex) return 'adp_2qb';
  const rec = S.scoring.rec || 0;
  if (rec >= 1) return 'adp_ppr';
  if (rec > 0) return 'adp_half_ppr';
  return 'adp_std';
}

function scoreRows(rows) {
  const ak = adpKey();
  return rows.map(r => {
    const { pts, exact } = scoreStats(r.stats, S.scoring);
    const adp = r.stats[ak];
    return { ...r, pts, exact, adp: (adp && adp < 900) ? adp : null };
  }).sort((a, b) => b.pts - a.pts);
}

/* ============================= 4. DRAFT MATH ============================= */

/* Value Over Replacement (VOR).
   A player's raw projection is misleading: QBs score more than RBs, but that
   doesn't make them more valuable, because EVERY team's QB scores a lot. What
   matters is the gap to the guy you could have instead — the best player at that
   position who won't be a starter anywhere in the league.

   To find that "replacement" player we work out how many of each position get
   started league-wide: dedicated slots are easy (12 teams x 2 RB = 24 RBs), and
   flex slots go to whoever projects highest among the eligible leftovers. */
function replacementLevels(players) {
  const start = startingSlots();
  const dedicated = {}, flexEligs = [];
  start.forEach(s => {
    const e = elig(s);
    if (e.length === 1) dedicated[e[0]] = (dedicated[e[0]] || 0) + 1;
    else flexEligs.push(e);
  });

  const byPos = {};
  POSITIONS.forEach(p => byPos[p] = players.filter(x => x.pos === p));

  // cursor[p] = how many players at p are already accounted for as starters
  const cursor = {};
  POSITIONS.forEach(p => cursor[p] = (dedicated[p] || 0) * S.teams);

  const flexPool = [...new Set(flexEligs.flat())].filter(p => byPos[p]);
  const flexPicks = flexEligs.length * S.teams;
  for (let i = 0; i < flexPicks; i++) {
    let bestPos = null, bestPts = -Infinity;
    for (const p of flexPool) {
      const cand = byPos[p][cursor[p]];
      if (cand && cand.pts > bestPts) { bestPts = cand.pts; bestPos = p; }
    }
    if (!bestPos) break;
    cursor[bestPos]++;
  }

  const repl = {};
  POSITIONS.forEach(p => {
    const list = byPos[p];
    const next = list[cursor[p]] || list[list.length - 1];
    repl[p] = next ? next.pts : 0;
  });
  return repl;
}

/* Tiers: walking down a position, a "tier break" is where the drop to the next
   player is much bigger than the drops have been. Practically: inside a tier the
   players are interchangeable, so take need or upside; across a break, don't wait. */
function assignTiers(list) {
  const head = list.slice(0, 60);
  const gaps = [];
  for (let i = 1; i < head.length; i++) gaps.push(head[i - 1].vor - head[i].vor);
  const sorted = gaps.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const thresh = Math.max(median * 2.2, 0.5);

  let tier = 1;
  list.forEach((p, i) => {
    if (i > 0 && i < head.length && (list[i - 1].vor - p.vor) > thresh) tier++;
    p.tier = tier;
  });
}

/* Overall letter grade — a rough "what's this player worth in the draft" label.

   The bands are expressed in DRAFT ROUNDS rather than fixed pick numbers, so they
   scale with league size on their own: round 1 is 8 picks in this 8-team league and
   12 in a 12-team league, and the grades follow. S++ is the top half of round 1;
   D is late-round filler.

   Deliberately separate from the positional tier column next to it. Grades answer
   "how early is this player worth taking, overall"; tiers answer "where are the
   cliffs within his position". Rank bands are the honest tool for the first
   question, gap detection for the second. */
const GRADE_BANDS = [
  ['S++', 0.5],  // cornerstone — top half of round 1
  ['S+', 1],     // rest of round 1
  ['S', 2],      // round 2
  ['A+', 4],     // rounds 3-4
  ['A', 6],      // rounds 5-6
  ['B+', 8],     // rounds 7-8
  ['B', 10],     // rounds 9-10
  ['C', 13],     // rounds 11-13
  ['D', Infinity],   // the rest of the draft
];
const gradeClass = g => 'g-' + g.toLowerCase().replace(/\+/g, 'p');

/* The grade says what a player is WORTH IN THE DRAFT, not how good he is in the
   abstract — so it's purely about where he ranks relative to how many picks exist.
   An earlier version also demoted anyone projected below replacement level, which
   was a mistake: in a shallow league with five bench spots, plenty of
   below-replacement players are perfectly reasonable late picks. Absolute value is
   what the VOR column is for. F means he wouldn't get drafted at all. */
function gradeFor(rank) {
  const rounds = rank / Math.max(2, S.teams);
  if (rounds > S.rounds) return 'F';
  return (GRADE_BANDS.find(b => rounds <= b[1]) || ['D'])[0];
}

function buildBoard() {
  const players = scoreRows(S.seasonRows);

  /* In playoff mode a player's value becomes his weeks 15-17 total, and everything
     downstream — replacement level, VOR, tiers, grades — is recomputed on that
     basis. Swapping the number in before replacement level is calculated is what
     keeps the whole board internally consistent. */
  if (S.rankMode === 'playoffs') {
    const tot = playoffTotals();
    if (tot) {
      players.forEach(p => { p.seasonPts = p.pts; p.pts = tot[p.id] ?? 0; });
      players.sort((a, b) => b.pts - a.pts);
    }
  }

  const repl = replacementLevels(players);
  players.forEach(p => p.vor = p.pts - (repl[p.pos] ?? 0));
  POSITIONS.forEach(p => assignTiers(players.filter(x => x.pos === p)));
  players.sort((a, b) => b.vor - a.vor);
  players.forEach((p, i) => {
    p.rank = i + 1;
    p.grade = gradeFor(p.rank);
    const s = S.sos[p.team];
    p.bye = s ? s.bye : null;
    p.sos = s ? s.all : null;
    p.sosPost = s ? s.post : null;
  });
  S.board = players;
}

// Which overall pick numbers are mine, given a snake draft.
function myPickNumbers() {
  const out = [];
  for (let r = 1; r <= S.rounds; r++) {
    const inRound = (r % 2 === 1) ? S.mySlot : (S.teams - S.mySlot + 1);
    out.push((r - 1) * S.teams + inRound);
  }
  return out;
}

/* ============================== 5. OPTIMIZER ============================= */

/* Pick the highest-scoring legal starting lineup.

   Brute force would be slow, so first we shrink the problem: if only 3 of your
   slots can accept a RB, then only your top 3 RBs can possibly start — nobody
   else is reachable. That leaves ~12 candidates. Then we try every combination
   with memoisation (remembering answers to sub-problems we've already solved),
   which makes it exact and instant. */
function optimalLineup(roster) {
  const slots = startingSlots();
  if (!slots.length || !roster.length) return { rows: [], total: 0, bench: roster };

  const capacity = {};
  slots.forEach(s => elig(s).forEach(p => capacity[p] = (capacity[p] || 0) + 1));

  let pool = [];
  for (const p in capacity) {
    pool = pool.concat(
      roster.filter(x => x.pos === p).sort((a, b) => b.pts - a.pts).slice(0, capacity[p])
    );
  }
  pool = [...new Map(pool.map(x => [x.id, x])).values()]
    .sort((a, b) => b.pts - a.pts)
    .slice(0, 22); // hard safety cap on the search space

  // Fill the fussiest slots first — fewer branches, identical answer.
  const order = slots.map((s, i) => ({ slot: s, idx: i }))
    .sort((a, b) => elig(a.slot).length - elig(b.slot).length);

  const memo = new Map();
  function best(k, used) {
    if (k === order.length) return { total: 0, picks: [] };
    const key = k + ':' + used;
    if (memo.has(key)) return memo.get(key);

    const ok = elig(order[k].slot);
    const empty = best(k + 1, used);                       // leaving it empty is legal
    let bestRes = { total: empty.total, picks: [[order[k], null], ...empty.picks] };

    for (let j = 0; j < pool.length; j++) {
      if (used & (1 << j)) continue;
      const pl = pool[j];
      if (!ok.includes(pl.pos)) continue;
      const rest = best(k + 1, used | (1 << j));
      const total = rest.total + pl.pts;
      if (total > bestRes.total) bestRes = { total, picks: [[order[k], pl], ...rest.picks] };
    }
    memo.set(key, bestRes);
    return bestRes;
  }

  const res = best(0, 0);
  const rows = res.picks.slice()
    .sort((a, b) => a[0].idx - b[0].idx)
    .map(([o, pl]) => ({ slot: o.slot, player: pl }));
  const usedIds = new Set(rows.map(r => r.player && r.player.id).filter(Boolean));
  const bench = roster.filter(p => !usedIds.has(p.id)).sort((a, b) => b.pts - a.pts);
  return { rows, total: res.total, bench };
}

// Turn my roster of player_ids into scored player objects for the chosen week.
function myScoredRoster() {
  const byId = {};
  scoreRows(S.weekRows).forEach(r => byId[r.id] = r);
  return S.myRoster.map(id => {
    const hit = byId[id];
    if (hit) return hit;
    const d = S.dir[id] || {};
    // Not in this week's feed: bye week, injured out, or not projected to play.
    return { id, name: d.name || `#${id}`, pos: d.pos || '?', team: d.team || '', opp: 'BYE/—', inj: '', pts: 0, exact: true };
  });
}

/* ====================== 5b. DRAFT INTELLIGENCE ========================== */

/* Which overall pick are we on, and when do I pick again?

   The interesting question during a draft is never "who is best" — the board
   already answers that — it's "who won't be here when I come back". */
function pickContext() {
  const pickNo = Object.keys(S.drafted).length + 1;
  const mine = myPickNumbers();
  const nextMine = mine.find(n => n >= pickNo) || null;
  const afterThat = mine.find(n => n > (nextMine || 0)) || null;
  // If I'm on the clock, what matters is surviving until my following pick.
  const waitUntil = (nextMine === pickNo ? afterThat : nextMine) || pickNo + S.teams;
  return { pickNo, nextMine, afterThat, waitUntil, onClock: nextMine === pickNo };
}

// What my roster still needs, counting only slots dedicated to one position.
function slotDemand() {
  const want = {};
  startingSlots().forEach(s => {
    const e = elig(s);
    if (e.length === 1) want[e[0]] = (want[e[0]] || 0) + 1;
  });
  const have = {};
  const byId = {};
  S.board.forEach(p => byId[p.id] = p);
  S.myRoster.forEach(id => { const p = byId[id]; if (p) have[p.pos] = (have[p.pos] || 0) + 1; });
  return { want, have };
}

/* The pick recommender.

   For each available player, estimate the chance he's gone before my next pick from
   his average draft position, then weigh that against what he's worth. A player I
   can get later is worth less NOW than an equally good player who will vanish — so
   the ranking metric is roughly "points of value I lose by passing":

       urgency = value over replacement  x  probability he's gone  x  need

   The probability is a logistic curve on how far past his ADP my next pick sits.
   ADP is a crowd average, not a forecast of your specific league, so this is a
   nudge on top of VOR rather than an oracle. */
function recommendations(limit = 5) {
  const ctx = pickContext();
  const { want, have } = slotDemand();

  const list = S.board
    .filter(p => !S.drafted[p.id])
    .slice(0, 150)
    .map(p => {
      const gone = p.adp == null ? 0.5 : 1 / (1 + Math.exp(-(ctx.waitUntil - p.adp) / 5));
      const w = want[p.pos] || 0, h = have[p.pos] || 0;
      const short = w - h;
      // Nudge toward unfilled slots, away from positions already stacked deep.
      const needMul = short > 0 ? 1.3 : (h >= w + 2 ? 0.65 : 1);
      return {
        p, gone, short, needMul,
        urgency: Math.max(0, p.vor) * gone * needMul,
      };
    })
    .sort((a, b) => b.urgency - a.urgency);

  return { ...ctx, list: list.slice(0, limit) };
}

/* Positional runs: when the room empties a position faster than usual, the cost of
   waiting rises sharply. Reads the ordered pick log rather than the drafted set. */
function positionalRuns(window = 8) {
  const recent = S.pickLog.slice(-window)
    .map(id => (S.dir[id] || {}).pos)
    .filter(p => POSITIONS.includes(p));
  const counts = {};
  recent.forEach(p => counts[p] = (counts[p] || 0) + 1);
  const hot = Object.keys(counts)
    .filter(p => counts[p] >= Math.max(3, Math.ceil(recent.length / 2)))
    .sort((a, b) => counts[b] - counts[a]);
  return { n: recent.length, counts, hot };
}

/* Roster construction problems that a points total won't show you. */
function rosterWarnings() {
  const out = [];
  const byId = {};
  S.board.forEach(p => byId[p.id] = p);
  const mine = S.myRoster.map(id => byId[id]).filter(Boolean);
  if (!mine.length) return out;

  // Several players on one NFL team share a bye AND a game script — if that
  // offence has a bad day, so does your whole week.
  const byTeam = {};
  mine.forEach(p => (byTeam[p.team] = byTeam[p.team] || []).push(p));
  Object.keys(byTeam).forEach(t => {
    const list = byTeam[t];
    if (list.length >= 3) {
      out.push({
        level: 'warn',
        text: `${list.length} of your players are on ${t} (${list.map(p => p.name).join(', ')}). ` +
          `They share a bye week and rise and fall with the same offence.`,
      });
    }
  });

  // Kickers and defences are near-interchangeable, so spending an early pick is waste.
  mine.forEach(p => {
    if (p.pos !== 'K' && p.pos !== 'DEF') return;
    const idx = S.pickLog.indexOf(p.id);
    if (idx < 0) return;
    const round = Math.ceil((idx + 1) / Math.max(2, S.teams));
    if (round <= S.rounds - 3) {
      out.push({
        level: 'warn',
        text: `${p.pos} ${p.name} went in round ${round}. Kickers and defences vary so little ` +
          `that they belong in your last couple of rounds — that pick could have been depth.`,
      });
    }
  });

  const { want, have } = slotDemand();
  const round = Math.ceil(S.pickLog.length / Math.max(2, S.teams));
  POSITIONS.forEach(pos => {
    const w = want[pos] || 0, h = have[pos] || 0;
    if (w && !h && round >= 7) {
      out.push({ level: 'warn', text: `Still no ${pos} and you're into round ${round}.` });
    }
    if (w && h >= w + 2 && (pos === 'QB' || pos === 'K' || pos === 'DEF')) {
      out.push({
        level: 'info',
        text: `${h} ${pos}s on a roster that starts ${w}. In a ${S.teams}-team league the ` +
          `backup is replaceable off waivers — that's a spent roster spot.`,
      });
    }
  });

  return out;
}

/* Trade evaluation: rebuild both rosters with the players swapped and re-solve each
   optimal lineup. What matters is the change in points you can actually START, which
   is why a deal that looks even on paper can still be lopsided. */
function evaluateTrade(teamA, teamB, sendA, sendB) {
  const after = (team, out, inc) =>
    team.players.filter(id => !out.includes(id)).concat(inc);
  return {
    aBefore: rosterStrength(teamA.players).total,
    aAfter: rosterStrength(after(teamA, sendA, sendB)).total,
    bBefore: rosterStrength(teamB.players).total,
    bAfter: rosterStrength(after(teamB, sendB, sendA)).total,
  };
}

/* ============================== 6. RENDERING ============================= */

/* -- setup tab ----------------------------------------------------------- */

function renderSlotEditor() {
  const box = $('#slotEditor');
  box.innerHTML = '';
  const counts = {};
  S.slots.forEach(s => counts[s] = (counts[s] || 0) + 1);
  const types = [...new Set([...SLOT_MENU, ...Object.keys(counts)])];

  types.forEach(type => {
    const wrap = el('div', 'slot');
    wrap.append(el('b', '', type));
    const minus = el('button', 'tiny', '−');
    const n = el('span', '', String(counts[type] || 0));
    const plus = el('button', 'tiny', '+');
    minus.onclick = () => { const i = S.slots.lastIndexOf(type); if (i >= 0) S.slots.splice(i, 1); afterSettingsChange(); };
    plus.onclick = () => { S.slots.push(type); afterSettingsChange(); };
    wrap.append(minus, n, plus);
    box.append(wrap);
  });
}

function renderScoringEditor() {
  const box = $('#scoringEditor');
  box.innerHTML = '';
  /* An imported league carries every rule Sleeper supports — 147 of them here, most
     set to zero. Showing all of that is noise, so hide the zeroes behind a toggle. */
  const all = Object.keys(S.scoring).sort();
  const showAll = $('#showAllScoring').checked;
  const keys = showAll ? all : all.filter(k => S.scoring[k]);
  $('#scoringCount').textContent = showAll
    ? `all ${all.length} rules`
    : `${keys.length} active rules (${all.length - keys.length} worth 0 hidden)`;
  const taken = new Set();

  SCORING_GROUPS.forEach(([title, test]) => {
    const mine = keys.filter(k => !taken.has(k) && test(k));
    mine.forEach(k => taken.add(k));
    if (!mine.length) return;

    const g = el('div', 'scoring-group');
    g.append(el('h3', '', title));
    mine.forEach(k => {
      const f = el('div', 'field');
      f.append(el('span', '', k));
      const inp = el('input');
      inp.type = 'number'; inp.step = '0.01'; inp.value = S.scoring[k];
      inp.oninput = () => {
        S.scoring[k] = parseFloat(inp.value) || 0;
        save(); refreshViews();
      };
      f.append(inp);
      g.append(f);
    });
    box.append(g);
  });
}

function renderSetupNumbers() {
  $('#teams').value = S.teams;
  $('#draftSlot').value = S.mySlot;
  $('#rounds').value = S.rounds;
  $('#username').value = S.username;
}

/* -- draft tab ----------------------------------------------------------- */

function posChip(pos) {
  return `<span class="pos pos-${pos}">${pos}</span>`;
}

// Low strength-of-schedule numbers are good news, high ones are bad news.
const sosCls = v => v == null ? '' : (v <= 4 ? 'val-up' : v >= 7 ? 'val-down' : '');

function renderPosFilter() {
  const box = $('#posFilter');
  box.innerHTML = '';
  ['ALL', ...POSITIONS].forEach(p => {
    const c = el('span', 'chip' + (S.posFilter === p ? ' on' : ''), p);
    c.onclick = () => { S.posFilter = p; renderBoard(); };
    box.append(c);
  });
}

function renderBoard() {
  renderPosFilter();
  const tb = $('#boardTable tbody');
  tb.innerHTML = '';
  const hide = $('#hideDrafted').checked;
  const q = S.search.toLowerCase();
  const currentPick = Object.keys(S.drafted).length + 1;

  const rows = S.board.filter(p => {
    if (hide && S.drafted[p.id]) return false;
    if (S.posFilter !== 'ALL' && p.pos !== S.posFilter) return false;
    if (q && !p.name.toLowerCase().includes(q)) return false;
    return true;
  }).slice(0, 300);

  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="13" class="empty">Nothing to show — check your filters, or load projections on the Setup tab.</td></tr>';
    return;
  }

  rows.forEach(p => {
    const tr = el('tr', 'row-' + p.pos);
    const status = S.drafted[p.id];
    if (status) tr.className += status === 'me' ? ' mine' : ' gone';

    // "Value" = how far past his average draft position he's still available.
    const value = p.adp ? p.adp - currentPick : null;
    const valCls = value == null ? '' : (value > 0 ? 'val-up' : 'val-down');
    const star = p.exact ? '' : '<span class="approx">*</span>';

    /* The data-label attributes are what make this table readable on a phone: the
       narrow-screen CSS hides the header row and prints each label inline instead,
       so one <tr> renders as a table on desktop and a card on mobile — one set of
       markup, no second rendering path to keep in sync. */
    tr.innerHTML = `
      <td class="c-rank n">${p.rank}</td>
      <td class="c-grade"><span class="grade ${gradeClass(p.grade)}">${p.grade}</span></td>
      <td class="c-player">${p.name}${p.inj ? `<span class="inj">${p.inj}</span>` : ''}</td>
      <td class="c-pos">${posChip(p.pos)}</td>
      <td class="c-team" data-label="Team">${p.team}</td>
      <td class="c-proj n" data-label="Proj">${fmt(p.pts, 0)}${star}</td>
      <td class="c-vor n" data-label="VOR">${fmt(p.vor, 0)}</td>
      <td class="c-tier" data-label="Tier">${p.pos}${p.tier}</td>
      <td class="c-bye n" data-label="Bye">${p.bye || '—'}</td>
      <td class="c-sos n ${sosCls(p.sos)}" data-label="SoS">${p.sos ? fmt(p.sos, 1) : '—'}</td>
      <td class="c-adp n" data-label="ADP">${p.adp ? fmt(p.adp, 0) : '—'}</td>
      <td class="c-val n ${valCls}" data-label="Val">${value == null ? '—' : (value > 0 ? '+' : '') + fmt(value, 0)}</td>
      <td class="c-actions"></td>`;

    const cell = tr.lastElementChild;
    if (status) {
      const undo = el('button', 'tiny', 'undo');
      undo.onclick = () => unmarkDrafted(p.id);
      cell.append(undo);
    } else {
      const mine = el('button', 'tiny primary', 'me');
      mine.onclick = () => markDrafted(p.id, 'me');
      const gone = el('button', 'tiny', 'gone');
      gone.onclick = () => markDrafted(p.id, 'other');
      cell.append(mine, gone);
    }
    tb.append(tr);
  });
}

function renderRecommend() {
  const box = $('#recommend');
  box.innerHTML = '';
  if (!S.board.length) { box.innerHTML = '<p class="empty">Waiting for projections.</p>'; return; }

  const r = recommendations(5);
  $('#recContext').textContent = r.onClock
    ? `you're on the clock at ${r.pickNo}`
    : `pick ${r.pickNo} · you're up at ${r.nextMine || '—'}`;

  r.list.forEach((row, i) => {
    const p = row.p;
    const line = el('div', 'rec' + (i === 0 ? ' top' : ''));
    const pct = Math.round(row.gone * 100);
    const why = [];
    if (row.short > 0) why.push(`fills your ${p.pos} slot`);
    if (pct >= 65) why.push(`${pct}% likely gone by pick ${r.waitUntil}`);
    else if (pct <= 30) why.push(`only ${pct}% likely gone by ${r.waitUntil} — you can wait`);
    else why.push(`${pct}% chance he's gone by ${r.waitUntil} — a coin flip`);
    if (row.needMul < 1) why.push('you are already deep here');

    line.innerHTML =
      `<div class="rec-head"><span class="grade ${gradeClass(p.grade)}">${p.grade}</span>` +
      `<b>${p.name}</b> ${posChip(p.pos)} <span class="rec-team">${p.team}</span></div>` +
      `<div class="rec-why">VOR ${fmt(p.vor, 0)} · ADP ${p.adp ? fmt(p.adp, 0) : '—'} · ${why.join(' · ')}</div>`;
    box.append(line);
  });
}

function renderRuns() {
  const box = $('#runs');
  box.innerHTML = '';
  const r = positionalRuns(8);
  if (!r.n) { box.innerHTML = '<span class="hint">No picks logged yet.</span>'; return; }

  const parts = POSITIONS.filter(p => r.counts[p]).map(p =>
    `<span class="run ${r.hot.includes(p) ? 'hot' : ''}">${posChip(p)} ${r.counts[p]}</span>`);
  box.innerHTML = `<div class="run-row">${parts.join('')}</div>` +
    `<p class="hint">Last ${r.n} picks. ` +
    (r.hot.length
      ? `<b>${r.hot.join(' and ')} ${r.hot.length > 1 ? 'are' : 'is'} going fast</b> — waiting will cost you more than usual.`
      : 'No run in progress.') + '</p>';
}

function renderWarnings() {
  const box = $('#warnings');
  box.innerHTML = '';
  const list = rosterWarnings();
  if (!list.length) {
    box.innerHTML = '<p class="hint">Nothing to flag' +
      (S.myRoster.length ? '.' : ' — no players on your roster yet.') + '</p>';
    return;
  }
  list.forEach(w => {
    const d = el('div', 'warn ' + w.level);
    d.textContent = w.text;
    box.append(d);
  });
}

function renderTrending() {
  const box = $('#trendingBody');
  box.innerHTML = '';
  if (!S.trending) { box.innerHTML = '<p class="empty">Not loaded yet.</p>'; return; }

  const owned = new Set();
  S.teamsInLeague.forEach(t => t.players.forEach(id => owned.add(id)));
  const byId = {};
  S.board.forEach(p => byId[p.id] = p);

  [['adds', 'Being added'], ['drops', 'Being dropped']].forEach(([key, title]) => {
    const rows = (S.trending[key] || []).slice(0, 12);
    if (!rows.length) return;
    const grp = el('div', 'trend-grp');
    grp.append(el('h3', '', title));
    rows.forEach(t => {
      const d = S.dir[t.player_id] || {};
      const p = byId[t.player_id];
      const line = el('div', 'trend-line');
      const taken = owned.has(t.player_id);
      line.innerHTML =
        `<span class="trend-name">${d.name || '#' + t.player_id}` +
        `${d.pos ? ' ' + posChip(d.pos) : ''} <span class="rec-team">${d.team || ''}</span></span>` +
        `<span class="trend-meta">${(t.count / 1000).toFixed(1)}k` +
        (p ? ` · VOR ${fmt(p.vor, 0)}` : '') +
        (taken ? ' · <span class="val-down">owned</span>' : ' · <span class="val-up">free</span>') +
        `</span>`;
      grp.append(line);
    });
    box.append(grp);
  });
}

function renderTradePickers() {
  const find = id => S.teamsInLeague.find(t => String(t.rosterId) === String(id));
  const A = find(S.compareA), B = find(S.compareB);
  const byId = {};
  S.board.forEach(p => byId[p.id] = p);

  [['#tradeListA', A, 'tradeA'], ['#tradeListB', B, 'tradeB']].forEach(([sel, team, key]) => {
    const box = $(sel);
    box.innerHTML = '';
    if (!team) return;
    box.append(el('h3', '', team.name));
    if (!team.players.length) {
      box.append(el('p', 'hint', 'Empty roster.'));
      return;
    }
    team.players
      .map(id => byId[id])
      .filter(Boolean)
      .sort((a, b) => b.pts - a.pts)
      .forEach(p => {
        const lab = el('label', 'trade-pick');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = S[key].includes(p.id);
        cb.onchange = () => {
          S[key] = cb.checked ? S[key].concat([p.id]) : S[key].filter(i => i !== p.id);
          renderTradeResult();
        };
        lab.append(cb);
        const span = el('span');
        span.innerHTML = `${p.name} ${posChip(p.pos)} <span class="rec-team">${fmt(p.pts, 0)}</span>`;
        lab.append(span);
        box.append(lab);
      });
  });
}

function renderTradeResult() {
  const out = $('#tradeResult');
  const find = id => S.teamsInLeague.find(t => String(t.rosterId) === String(id));
  const A = find(S.compareA), B = find(S.compareB);
  if (!A || !B || (!S.tradeA.length && !S.tradeB.length)) {
    out.innerHTML = '';
    return;
  }
  const r = evaluateTrade(A, B, S.tradeA, S.tradeB);
  const dA = r.aAfter - r.aBefore, dB = r.bAfter - r.bBefore;
  const sign = v => (v > 0 ? '+' : '') + fmt(v, 0);
  const cls = v => v > 0.5 ? 'val-up' : v < -0.5 ? 'val-down' : '';

  let verdict;
  if (Math.abs(dA - dB) < 5) verdict = 'Close to even.';
  else if (dA > dB) verdict = `<b>${A.name}</b> wins this trade.`;
  else verdict = `<b>${B.name}</b> wins this trade.`;

  out.innerHTML =
    `<div class="trade-side"><b>${A.name}</b> ${fmt(r.aBefore, 0)} → ${fmt(r.aAfter, 0)} ` +
    `<span class="${cls(dA)}">${sign(dA)}</span></div>` +
    `<div class="trade-side"><b>${B.name}</b> ${fmt(r.bBefore, 0)} → ${fmt(r.bAfter, 0)} ` +
    `<span class="${cls(dB)}">${sign(dB)}</span></div>` +
    `<div class="trade-verdict">${verdict} Change is in points you can actually start, ` +
    `so a player who only upgrades your bench shows as roughly zero.</div>`;
}

function renderDraftSide() {
  // my picks, laid into starting slots
  const roster = S.myRoster.map(id => S.board.find(p => p.id === id))
    .filter(Boolean);
  const { rows } = optimalLineup(roster);
  const box = $('#myRosterDraft');
  box.innerHTML = '';
  if (!S.myRoster.length) box.innerHTML = '<p class="empty">No picks yet.</p>';
  rows.forEach(r => {
    const line = el('div', 'slot-line');
    line.append(el('span', '', r.slot));
    line.append(el('span', '', r.player ? `${r.player.name} (${r.player.pos})` : '—'));
    box.append(line);
  });
  const extra = roster.filter(p => !rows.some(r => r.player && r.player.id === p.id));
  extra.forEach(p => {
    const line = el('div', 'slot-line');
    line.append(el('span', '', 'BN'));
    line.append(el('span', '', `${p.name} (${p.pos})`));
    box.append(line);
  });

  // next picks
  const currentPick = Object.keys(S.drafted).length + 1;
  const next = myPickNumbers().filter(n => n >= currentPick).slice(0, 3);
  $('#pickClock').textContent = next.length ? `pick ${currentPick} · mine: ${next.join(', ')}` : `pick ${currentPick}`;

  // needs
  const needBox = $('#needs');
  needBox.innerHTML = '';
  const have = {};
  roster.forEach(p => have[p.pos] = (have[p.pos] || 0) + 1);
  const want = {};
  startingSlots().forEach(s => {
    const e = elig(s);
    if (e.length === 1) want[e[0]] = (want[e[0]] || 0) + 1;
  });
  POSITIONS.forEach(p => {
    const w = want[p] || 0, h = have[p] || 0;
    if (!w && !h) return;
    const short = w - h;
    const chip = el('div', 'need' + (short > 0 ? ' urgent' : ''));
    chip.innerHTML = `${posChip(p)} ${h}/${w}`;
    needBox.append(chip);
  });

  // top available by position
  const posBox = $('#byPosition');
  posBox.innerHTML = '';
  POSITIONS.forEach(p => {
    const top = S.board.filter(x => x.pos === p && !S.drafted[x.id]).slice(0, 3);
    if (!top.length) return;
    const g = el('div', 'grp');
    g.innerHTML = `<b class="pos pos-${p}">${p}</b>`;
    top.forEach(x => {
      const line = el('div', 'line');
      line.append(el('span', '', `${x.name}`));
      line.append(el('span', '', `${fmt(x.vor, 0)} VOR · ${p}${x.tier}`));
      g.append(line);
    });
    posBox.append(g);
  });
}

/* -- lineup tab ---------------------------------------------------------- */

function renderLineup() {
  const roster = myScoredRoster();
  const { rows, total, bench } = optimalLineup(roster);
  const startingIds = new Set(S.sleeperStarters);

  const tb = $('#lineupTable tbody');
  tb.innerHTML = '';
  if (!roster.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty">Add players above, or draft some on the Draft Board tab.</td></tr>';
    $('#lineupTotal').textContent = '';
    $('#benchTable tbody').innerHTML = '';
    $('#deltaNote').textContent = '';
    return;
  }

  rows.forEach(r => {
    const p = r.player;
    const tr = el('tr', p ? 'row-' + p.pos : '');
    const flag = (p && S.sleeperStarters.length && !startingIds.has(p.id)) ? ' ⚠️' : '';
    tr.innerHTML = `
      <td class="c-slot slot-cell">${r.slot}</td>
      <td class="c-player">${p ? p.name + flag : '<span class="empty">empty</span>'}${p && p.inj ? `<span class="inj">${p.inj}</span>` : ''}</td>
      <td class="c-pos">${p ? posChip(p.pos) : ''}</td>
      <td class="c-team" data-label="Team">${p ? p.team : ''}</td>
      <td class="c-opp" data-label="Opp">${p ? (p.opp || '—') : ''}</td>
      <td class="c-proj n" data-label="Proj">${p ? fmt(p.pts) + (p.exact ? '' : '<span class="approx">*</span>') : '—'}</td>
      <td class="c-actions"></td>`;
    tb.append(tr);
  });

  $('#lineupTotal').textContent = `${fmt(total)} projected`;

  /* How much the optimizer beats what Sleeper currently has you starting.
     Only meaningful if both lineups are the same shape — if you've edited the slot
     counts since importing, we'd be comparing a 9-man lineup against a 7-man one
     and reporting a bogus "gain". Say so instead of lying. */
  const slotCount = startingSlots().length;
  if (!S.sleeperStarters.length) {
    $('#deltaNote').textContent = '';
  } else if (S.sleeperStarters.length !== slotCount) {
    say('#deltaNote', `Not comparing against your Sleeper lineup: you have ${slotCount} ` +
      `starting slots set up here, but Sleeper reports ${S.sleeperStarters.length}.`);
  } else {
    /* Score the current lineup by running those same players through the optimizer.
       Summing them raw would let a lineup Sleeper reports as legal-but-odd total
       MORE than the optimum, and we'd print a self-contradicting "already optimal".
       Restricted to a subset of the roster, the optimum can only be lower. */
    const starters = roster.filter(p => S.sleeperStarters.includes(p.id));
    const cur = optimalLineup(starters).total;
    const gain = total - cur;
    $('#deltaNote').textContent = gain > 0.05
      ? `Your current Sleeper lineup projects ${fmt(cur)} — switching gains ${fmt(gain)} points.`
      : `Your current Sleeper lineup is already optimal (${fmt(cur)}).`;
    $('#deltaNote').className = 'status ' + (gain > 0.05 ? '' : 'ok');
  }

  const bt = $('#benchTable tbody');
  bt.innerHTML = '';
  if (!bench.length) bt.innerHTML = '<tr><td colspan="6" class="empty">Everyone is starting.</td></tr>';
  bench.forEach(p => {
    const tr = el('tr', 'row-' + p.pos);
    tr.innerHTML = `
      <td class="c-player">${p.name}${p.inj ? `<span class="inj">${p.inj}</span>` : ''}</td>
      <td class="c-pos">${posChip(p.pos)}</td>
      <td class="c-team" data-label="Team">${p.team}</td>
      <td class="c-opp" data-label="Opp">${p.opp || '—'}</td>
      <td class="c-proj n" data-label="Proj">${fmt(p.pts)}</td>
      <td class="c-actions"></td>`;
    const drop = el('button', 'tiny', 'remove');
    drop.onclick = () => unmarkDrafted(p.id);
    tr.lastElementChild.append(drop);
    bt.append(tr);
  });
}

/* -- teams: comparison, free agents, schedule ---------------------------- */

// Score a set of player_ids against the season-long projections and slot them
// optimally. That "best legal lineup" total is the fairest single number for how
// strong a roster is — it ignores players who can't actually start.
function rosterStrength(playerIds) {
  const byId = {};
  S.board.forEach(p => byId[p.id] = p);
  const roster = playerIds.map(id => byId[id]).filter(Boolean);
  return { ...optimalLineup(roster), roster };
}

function teamOptions() {
  return S.teamsInLeague.map(t => ({
    id: String(t.rosterId),
    label: t.name + (t.isMine ? ' (you)' : '') + ` · ${t.players.length} players`,
  }));
}

function fillTeamSelects() {
  const opts = teamOptions();
  [['#cmpA', 'compareA'], ['#cmpB', 'compareB']].forEach(([sel, key], i) => {
    const node = $(sel);
    node.innerHTML = '';
    opts.forEach(o => {
      const el2 = el('option', '', o.label);
      el2.value = o.id;
      node.append(el2);
    });
    if (!S[key] && opts.length) {
      // default to you vs. whoever is next
      const mine = S.teamsInLeague.find(t => t.isMine);
      const fallback = opts[Math.min(i, opts.length - 1)].id;
      S[key] = i === 0 && mine ? String(mine.rosterId)
        : opts.find(o => o.id !== S.compareA)?.id || fallback;
    }
    if (S[key]) node.value = S[key];
  });
}

function renderCompare() {
  const box = $('#compareBody');
  box.innerHTML = '';
  if (!S.teamsInLeague.length) {
    box.innerHTML = '<p class="empty">Load the league\'s teams first.</p>';
    $('#compareVerdict').textContent = '';
    return;
  }
  const find = id => S.teamsInLeague.find(t => String(t.rosterId) === String(id));
  const A = find(S.compareA), B = find(S.compareB);
  if (!A || !B) return;

  if (!A.players.length && !B.players.length) {
    box.innerHTML = '<p class="empty">Both rosters are empty — nobody in this league has ' +
      'drafted yet, so there is nothing to compare. This fills in the moment the draft runs.</p>';
    $('#compareVerdict').textContent = '';
    return;
  }

  const sA = rosterStrength(A.players), sB = rosterStrength(B.players);

  const table = el('table');
  table.innerHTML = '<thead><tr><th>' + A.name + '</th><th class="num-col">Proj</th>' +
    '<th class="mid">Slot</th><th class="num-col">Proj</th><th>' + B.name + '</th>' +
    '<th class="num-col">Edge</th></tr></thead>';
  const tb = el('tbody');

  sA.rows.forEach((rowA, i) => {
    const rowB = sB.rows[i];
    const pa = rowA.player, pb = rowB && rowB.player;
    const va = pa ? pa.pts : 0, vb = pb ? pb.pts : 0;
    const d = va - vb;
    const tr = el('tr');
    tr.innerHTML = `
      <td class="c-player ${d > 0 ? 'win' : ''}">${pa ? pa.name : '<span class="empty">—</span>'}</td>
      <td class="n" data-label="A">${pa ? fmt(va, 0) : '—'}</td>
      <td class="mid slot-cell" data-label="Slot">${rowA.slot}</td>
      <td class="n" data-label="B">${pb ? fmt(vb, 0) : '—'}</td>
      <td class="c-player ${d < 0 ? 'win' : ''}">${pb ? pb.name : '<span class="empty">—</span>'}</td>
      <td class="n ${d > 0 ? 'val-up' : d < 0 ? 'val-down' : ''}" data-label="Edge">${d ? (d > 0 ? '+' : '') + fmt(d, 0) : '—'}</td>`;
    tb.append(tr);
  });
  table.append(tb);
  const wrap = el('div', 'table-wrap');
  wrap.append(table);
  box.append(wrap);

  const diff = sA.total - sB.total;
  const lead = diff > 0 ? A : B;
  $('#compareVerdict').innerHTML =
    `<b>${A.name}</b> ${fmt(sA.total, 0)} &nbsp;vs&nbsp; <b>${B.name}</b> ${fmt(sB.total, 0)} — ` +
    `<b>${lead.name}</b> by ${fmt(Math.abs(diff), 0)} projected points ` +
    `(${fmt(Math.abs(diff) / 17, 1)} per week). Bench depth: ` +
    `${A.name} ${sA.bench.length}, ${B.name} ${sB.bench.length}.`;
}

function renderFreeAgents() {
  const tb = $('#faTable tbody');
  tb.innerHTML = '';
  if (!S.teamsInLeague.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty">Load the league\'s teams first.</td></tr>';
    return;
  }
  const owned = new Set();
  S.teamsInLeague.forEach(t => t.players.forEach(id => owned.add(id)));
  const pos = S.faPos;
  const free = S.board.filter(p => !owned.has(p.id) && (pos === 'ALL' || p.pos === pos)).slice(0, 60);

  if (!free.length) {
    tb.innerHTML = '<tr><td colspan="7" class="empty">Nobody available.</td></tr>';
    return;
  }
  free.forEach(p => {
    const tr = el('tr', 'row-' + p.pos);
    tr.innerHTML = `
      <td class="c-grade"><span class="grade ${gradeClass(p.grade)}">${p.grade}</span></td>
      <td class="c-player">${p.name}${p.inj ? `<span class="inj">${p.inj}</span>` : ''}</td>
      <td class="c-pos">${posChip(p.pos)}</td>
      <td class="c-team" data-label="Team">${p.team}</td>
      <td class="c-proj n" data-label="Proj">${fmt(p.pts, 0)}</td>
      <td class="c-vor n" data-label="VOR">${fmt(p.vor, 0)}</td>
      <td class="c-bye n" data-label="Bye">${p.bye || '—'}</td>`;
    tb.append(tr);
  });
  $('#faCount').textContent = `${owned.size} players owned across ${S.teamsInLeague.length} teams`;
}

function renderSchedule() {
  const tb = $('#schedTable tbody');
  tb.innerHTML = '';
  const teams = Object.keys(S.sos).sort();
  if (!teams.length) {
    tb.innerHTML = '<tr><td colspan="4" class="empty">Schedule not loaded yet — ' +
      'press the button above.</td></tr>';
    return;
  }
  teams.sort((a, b) => (S.sos[a].all ?? 99) - (S.sos[b].all ?? 99));
  teams.forEach(t => {
    const s = S.sos[t];
    const tr = el('tr');
    tr.innerHTML = `
      <td class="c-player">${t}</td>
      <td class="n" data-label="Bye">${s.bye || '—'}</td>
      <td class="n ${sosCls(s.all)}" data-label="Season">${s.all ? fmt(s.all, 1) : '—'}</td>
      <td class="n ${sosCls(s.post)}" data-label="Playoffs">${s.post ? fmt(s.post, 1) : '—'}</td>`;
    tb.append(tr);
  });
}

function renderTeams() {
  fillTeamSelects();
  renderCompare();
  renderTradePickers();
  renderTradeResult();
  renderFreeAgents();
  renderSchedule();
  renderByeWarnings();
  renderWarnings();
  renderTrending();
}

// Stacking byes is a real way to lose a week, so flag it on your own roster.
function renderByeWarnings() {
  const box = $('#byeWarn');
  box.innerHTML = '';
  if (!S.myRoster.length || !Object.keys(S.sos).length) return;
  const byWeek = {};
  const byId = {};
  S.board.forEach(p => byId[p.id] = p);
  S.myRoster.forEach(id => {
    const p = byId[id];
    if (!p || !p.bye) return;
    (byWeek[p.bye] = byWeek[p.bye] || []).push(p);
  });
  Object.keys(byWeek).sort((a, b) => a - b).forEach(w => {
    const list = byWeek[w];
    const chip = el('div', 'need' + (list.length >= 3 ? ' urgent' : ''));
    chip.innerHTML = `<b>Wk ${w}</b> — ${list.length}: ` +
      list.map(p => `${p.name} (${p.pos})`).join(', ');
    box.append(chip);
  });
}

function refreshViews() {
  buildBoard();
  renderBoard();
  renderRecommend();
  renderRuns();
  renderDraftSide();
  renderLineup();
  renderTeams();
}

function afterSettingsChange() {
  save();
  renderSlotEditor();
  refreshViews();
}

/* =============================== 7. WIRING ============================== */

/* -- league import ------------------------------------------------------- */

async function findLeagues(name) {
  if (!name) { say('#setupStatus', 'Type your Sleeper username first.', 'err'); return null; }
  say('#setupStatus', 'Looking you up…');
  try {
    const user = await api(`/v1/user/${encodeURIComponent(name)}`);
    if (!user || !user.user_id) throw new Error('no such Sleeper user');
    S.username = name;
    S.userId = user.user_id;
    S.leagues = (await api(`/v1/user/${user.user_id}/leagues/nfl/${S.season}`)) || [];
    save();

    if (!S.leagues.length) {
      say('#setupStatus', `Found ${name}, but no ${S.season} NFL leagues on that account.`, 'err');
      return [];
    }
    const sel = $('#leagueSelect');
    sel.innerHTML = '';
    S.leagues.forEach(l => {
      const o = el('option', '', `${(l.name || '').trim()} (${l.total_rosters} teams)`);
      o.value = l.league_id;
      sel.append(o);
    });
    if (S.leagueId && S.leagues.some(l => l.league_id === S.leagueId)) sel.value = S.leagueId;
    $('#leagueRow').hidden = false;
    say('#setupStatus', `Found ${S.leagues.length} league(s).`, 'ok');
    return S.leagues;
  } catch (e) {
    say('#setupStatus', `Couldn't look that up: ${e.message}`, 'err');
    return null;
  }
}

async function importLeague(id) {
  if (!id) return false;
  say('#setupStatus', 'Importing league settings…');
  try {
    const l = await api(`/v1/league/${id}`);
    S.leagueId = id;
    S.leagueName = (l.name || '').trim();
    S.slots = l.roster_positions || S.slots;
    S.teams = l.total_rosters || S.teams;
    if (l.scoring_settings) S.scoring = { ...l.scoring_settings };
    if (l.draft_id) S.draftId = l.draft_id;   // saves looking it up separately
    save();

    renderSlotEditor(); renderScoringEditor(); renderSetupNumbers(); updateBadge();
    refreshViews();
    const ppr = S.scoring.rec >= 1 ? 'full PPR' : S.scoring.rec > 0 ? `${S.scoring.rec} PPR` : 'standard';
    say('#setupStatus', `Imported "${S.leagueName}" — ${S.teams} teams, ${ppr}, ` +
      `${startingSlots().length} starting slots (${startingSlots().join('/')}), ` +
      `${Object.keys(S.scoring).length} scoring rules.`, 'ok');
    if (S.draftId) await loadDraftInfo(true);
    return true;
  } catch (e) {
    say('#setupStatus', `Import failed: ${e.message}`, 'err');
    return false;
  }
}

$('#loadUser').onclick = () => findLeagues($('#username').value.trim());
$('#importLeague').onclick = () => importLeague($('#leagueSelect').value);

$('#resetScoring').onclick = () => {
  S.scoring = { ...DEFAULT_SCORING };
  save(); renderScoringEditor(); refreshViews();
};

$('#showAllScoring').onchange = renderScoringEditor;

['teams', 'draftSlot', 'rounds'].forEach(id => {
  $('#' + id).oninput = () => {
    S.teams = Math.max(2, parseInt($('#teams').value) || 12);
    S.mySlot = Math.min(S.teams, Math.max(1, parseInt($('#draftSlot').value) || 1));
    S.rounds = Math.max(1, parseInt($('#rounds').value) || 15);
    save(); refreshViews();
  };
});

$('#refreshData').onclick = () => bootData(true);

$('#wipe').onclick = () => {
  LS.clearAll();
  location.reload();
};

/* -- draft board --------------------------------------------------------- */

$('#search').oninput = e => { S.search = e.target.value; renderBoard(); };
$('#hideDrafted').onchange = renderBoard;

/* Pull the draft: how many rounds, and which slot is yours.

   A draft exists well before it has an order — Sleeper leaves `draft_order` empty
   until the commissioner sets or randomises the slots, which is where this league is
   right now. Say so plainly rather than silently pretending slot 1. */
async function loadDraftInfo(quiet) {
  try {
    if (!S.draftId) {
      if (!S.leagueId) throw new Error('import a league on the Setup tab first');
      const drafts = await api(`/v1/league/${S.leagueId}/drafts`);
      if (!drafts || !drafts.length) throw new Error('this league has no draft yet');
      S.draftId = (drafts.find(x => x.status === 'drafting') || drafts[0]).draft_id;
    }
    const d = await api(`/v1/draft/${S.draftId}`);
    if (d.settings) {
      S.teams = d.settings.teams || S.teams;
      S.rounds = d.settings.rounds || S.rounds;
    }
    const slot = d.draft_order && S.userId ? d.draft_order[S.userId] : null;
    if (slot) {
      S.mySlot = slot;
      say('#draftStatus', `${d.type} draft, ${d.status}. You're slot ${slot} of ${S.teams}, ` +
        `${S.rounds} rounds.`, 'ok');
    } else {
      say('#draftStatus', `${d.type} draft, ${d.status}, ${S.rounds} rounds. The draft order ` +
        `isn't set yet, so your slot will import itself once it is — using slot ${S.mySlot} ` +
        `for the pick numbers below in the meantime.`);
    }
    save(); renderSetupNumbers(); refreshViews();
    // Only pull picks once the thing is actually running, or manual marks get wiped.
    if (d.status === 'drafting' || d.status === 'complete') await syncPicks();
    return true;
  } catch (e) {
    if (!quiet) say('#draftStatus', `No luck: ${e.message}`, 'err');
    return false;
  }
}

$('#findDraft').onclick = () => loadDraftInfo(false);

async function syncPicks() {
  if (!S.draftId) return;
  try {
    const picks = await api(`/v1/draft/${S.draftId}/picks`);
    // Sleeper is the source of truth while syncing, so rebuild from its picks —
    // in pick_no order, because run detection depends on the sequence.
    S.drafted = {};
    S.myRoster = [];
    S.pickLog = [];
    picks.slice()
      .sort((a, b) => (a.pick_no || 0) - (b.pick_no || 0))
      .forEach(p => {
        if (!p.player_id) return;
        const mine = (p.picked_by && p.picked_by === S.userId) || (p.draft_slot === S.mySlot);
        S.drafted[p.player_id] = mine ? 'me' : 'other';
        S.pickLog.push(p.player_id);
        if (mine) S.myRoster.push(p.player_id);
      });
    save();
    refreshViews();
    say('#draftStatus', `${picks.length} picks in. You have ${S.myRoster.length}.`, 'ok');
  } catch (e) {
    say('#draftStatus', `Sync error: ${e.message}`, 'err');
  }
}

$('#autoSync').onchange = e => {
  clearInterval(S.syncTimer);
  if (e.target.checked) {
    if (!S.draftId) { e.target.checked = false; return say('#draftStatus', 'Find your draft first.', 'err'); }
    S.syncTimer = setInterval(syncPicks, 5000);
    syncPicks();
  }
};

/* -- lineup -------------------------------------------------------------- */

$('#week').oninput = async () => {
  const w = Math.min(18, Math.max(1, parseInt($('#week').value) || 1));
  S.week = w;
  say('#lineupStatus', `Loading week ${w} projections…`);
  try {
    S.weekRows = (await loadWeek(w)).rows;
    say('#lineupStatus', `Week ${w} loaded (${S.weekRows.length} players projected).`, 'ok');
    renderLineup();
  } catch (e) {
    say('#lineupStatus', `Could not load week ${w}: ${e.message}`, 'err');
  }
};

$('#pullRoster').onclick = async () => {
  if (!S.leagueId || !S.userId) return say('#lineupStatus', 'Connect and import a league on the Setup tab first.', 'err');
  say('#lineupStatus', 'Fetching your roster…');
  try {
    const rosters = await api(`/v1/league/${S.leagueId}/rosters`);
    const mine = rosters.find(r => r.owner_id === S.userId) ||
      rosters.find(r => (r.co_owners || []).includes(S.userId));
    if (!mine) throw new Error('no roster on this league belongs to you');
    S.myRoster = mine.players || [];
    S.sleeperStarters = (mine.starters || []).filter(id => id && id !== '0');
    save(); refreshViews();
    say('#lineupStatus', `Loaded ${S.myRoster.length} players (${S.sleeperStarters.length} currently starting).`, 'ok');
  } catch (e) {
    say('#lineupStatus', `Couldn't load roster: ${e.message}`, 'err');
  }
};

$('#addPlayer').oninput = e => {
  const q = e.target.value.trim().toLowerCase();
  const box = $('#addResults');
  box.innerHTML = '';
  if (q.length < 3) return;
  S.board.filter(p => p.name.toLowerCase().includes(q) && !S.myRoster.includes(p.id))
    .slice(0, 8)
    .forEach(p => {
      const b = el('button', 'tiny', `+ ${p.name} (${p.pos})`);
      b.onclick = () => {
        S.myRoster.push(p.id);
        save(); refreshViews();
        $('#addPlayer').value = ''; box.innerHTML = '';
      };
      box.append(b);
    });
};

/* -- teams & schedule ---------------------------------------------------- */

async function loadLeagueTeams() {
  if (!S.leagueId) return say('#teamsStatus', 'Import a league on the Setup tab first.', 'err');
  say('#teamsStatus', 'Loading every roster…');
  try {
    const [rosters, users] = await Promise.all([
      api(`/v1/league/${S.leagueId}/rosters`),
      api(`/v1/league/${S.leagueId}/users`),
    ]);
    const nameFor = {};
    (users || []).forEach(u => {
      nameFor[u.user_id] = (u.metadata && u.metadata.team_name) || u.display_name || 'Unknown';
    });
    S.teamsInLeague = (rosters || []).map(r => ({
      rosterId: r.roster_id,
      name: nameFor[r.owner_id] || `Team ${r.roster_id}`,
      players: r.players || [],
      starters: (r.starters || []).filter(id => id && id !== '0'),
      isMine: r.owner_id === S.userId,
    }));
    S.compareA = S.compareB = null;   // re-pick the defaults now that names exist
    renderTeams();

    const total = S.teamsInLeague.reduce((a, t) => a + t.players.length, 0);
    say('#teamsStatus', `${S.teamsInLeague.length} teams, ${total} players rostered` +
      (total ? '.' : ' — every roster is empty because the draft has not run yet.'),
      total ? 'ok' : '');
  } catch (e) {
    say('#teamsStatus', `Could not load rosters: ${e.message}`, 'err');
  }
}

$('#loadTeams').onclick = loadLeagueTeams;

$('#loadSched').onclick = async () => {
  say('#teamsStatus', 'Rebuilding the schedule from 18 weeks of data…');
  try {
    S.schedule = (await loadSchedule(true)).teams;
    computeSos();
    refreshViews();
    say('#teamsStatus', `Schedule rebuilt for ${Object.keys(S.sos).length} teams.`, 'ok');
  } catch (e) {
    say('#teamsStatus', `Schedule failed: ${e.message}`, 'err');
  }
};

// Changing a side of the comparison invalidates whatever was ticked for the trade.
$('#cmpA').onchange = e => {
  S.compareA = e.target.value; S.tradeA = [];
  renderCompare(); renderTradePickers(); renderTradeResult();
};
$('#cmpB').onchange = e => {
  S.compareB = e.target.value; S.tradeB = [];
  renderCompare(); renderTradePickers(); renderTradeResult();
};
$('#clearTrade').onclick = () => {
  S.tradeA = []; S.tradeB = [];
  renderTradePickers(); renderTradeResult();
};
$('#faPos').onchange = e => { S.faPos = e.target.value; renderFreeAgents(); };

$('#loadTrending').onclick = async () => {
  say('#teamsStatus', 'Asking Sleeper what the platform is doing…');
  try {
    S.trending = await loadTrending();
    renderTrending();
    say('#teamsStatus', `${S.trending.adds.length} trending adds, ${S.trending.drops.length} drops.`, 'ok');
  } catch (e) {
    say('#teamsStatus', `Trending unavailable: ${e.message}`, 'err');
  }
};

/* -- ranking mode -------------------------------------------------------- */

function updateModeNote() {
  $('#modeNote').textContent = S.rankMode === 'playoffs'
    ? 'Ranking by projected points in weeks 15–17 only.'
    : '';
}

$('#rankMode').onchange = async e => {
  S.rankMode = e.target.value;
  save();
  if (S.rankMode === 'playoffs' && !S.playoffWeeks) {
    say('#dataStatus', 'Loading weeks 15–17…');
    try {
      S.playoffWeeks = (await loadPlayoffWeeks(false)).weeks;
      say('#dataStatus', 'Playoff-week projections loaded.', 'ok');
    } catch (err) {
      say('#dataStatus', `Could not load playoff weeks: ${err.message}`, 'err');
      S.rankMode = 'season';
      $('#rankMode').value = 'season';
      save();
    }
  }
  refreshViews();
  updateModeNote();
};

/* -- tabs ---------------------------------------------------------------- */

$$('.tab').forEach(t => t.onclick = () => {
  $$('.tab').forEach(x => x.classList.toggle('active', x === t));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + t.dataset.tab));
});

/* -- startup ------------------------------------------------------------- */

async function bootData(force) {
  say('#dataStatus', 'Downloading projections…');
  try {
    const season = await loadSeason(force);
    S.dir = season.dir;
    S.seasonRows = season.rows;

    const wk = await loadWeek(S.week, force);
    S.weekRows = wk.rows;

    // Schedule is cheap (32 rows a week) and feeds byes + strength of schedule.
    try {
      S.schedule = (await loadSchedule(force)).teams;
      computeSos();
    } catch (e) {
      console.warn('schedule unavailable', e);
    }

    // Two tiny requests; the waiver signal is worth having ready up front.
    try { S.trending = await loadTrending(); } catch (e) { console.warn('trending unavailable', e); }

    // Only pay for the playoff weeks if that ranking mode is actually selected.
    if (S.rankMode === 'playoffs' && !S.playoffWeeks) {
      try { S.playoffWeeks = (await loadPlayoffWeeks(force)).weeks; }
      catch (e) { S.rankMode = 'season'; console.warn('playoff weeks unavailable', e); }
    }

    const age = Math.round((Date.now() - season.at) / 60000);
    say('#dataStatus', `${S.seasonRows.length} players projected for ${S.season}; week ${S.week} ` +
      `loaded; schedule for ${Object.keys(S.sos).length} teams. Cached ${age} min ago.`, 'ok');
    refreshViews();
  } catch (e) {
    say('#dataStatus', `Projection download failed: ${e.message}`, 'err');
  }
}

function updateBadge() {
  const bits = [];
  if (S.season) {
    bits.push(S.seasonType === 'regular' ? `${S.season} · week ${S.week}` : `${S.season} ${S.seasonType || ''}`.trim());
  }
  if (S.leagueName) bits.push(S.leagueName);
  $('#stateBadge').textContent = bits.join('  ·  ') || 'offline';
}

async function init() {
  renderSetupNumbers();
  renderSlotEditor();
  renderScoringEditor();
  $('#rankMode').value = S.rankMode;
  updateModeNote();

  try {
    const st = await api('/v1/state/nfl');
    S.season = st.season;
    S.seasonType = st.season_type;
    S.week = Math.min(18, Math.max(1, st.display_week || st.week || 1));
    $('#week').value = S.week;
  } catch (e) {
    S.season = String(new Date().getFullYear());
  }
  updateBadge();

  /* Connect the league without making you click through it. First visit: look up the
     saved username and import automatically if there's exactly one league (no guessing
     which one you meant). Later visits: settings are already saved, so just refresh
     the draft, which is the part that changes. */
  if (!S.leagueId && S.username) {
    const leagues = await findLeagues(S.username);
    if (leagues && leagues.length === 1) await importLeague(leagues[0].league_id);
  } else if (S.leagueId) {
    findLeagues(S.username);            // repopulate the dropdown, no need to wait
    loadDraftInfo(true);
  }

  await bootData(false);
}

init();
