# Fantasy Command Center

A draft board and lineup optimizer that runs entirely in your browser. Three static
files — no server, no database, no build step — so it works on GitHub Pages as-is.

## The files

| File | What it is |
|---|---|
| `index.html` | The page structure: five tabs and the tables/forms inside them. |
| `style.css` | Purely how it looks. Safe to fiddle with. |
| `app.js` | All the logic: fetching data, scoring, draft values, the optimizer. |
| `test.js`, `run-tests.sh` | Checks the logic still works. Not needed on the website — don't upload them if you'd rather not. |

## It's already live

<https://dcwarland.github.io/fantasy-command-center/>

GitHub Pages serves whatever is on `main`, so to publish a change: edit the file,
then `git add -A && git commit -m "what changed" && git push`. Pages rebuilds itself
in under a minute.

To check a deploy worked: the badge at the top of the page should show the current
NFL season and your league name. If it says `offline`, the projection download failed — open your
browser's developer console (**View → Developer → JavaScript Console** in Chrome)
and look for a red error.

### Testing it locally first

From the folder containing these files:

```sh
python3 -m http.server 8765
```

Then open <http://localhost:8765>. Press `Ctrl+C` in the terminal to stop it.
(Opening `index.html` by double-clicking mostly works too, but some browsers block
data requests from `file://` pages, so the local server is the reliable way.)

## How to use it

**League page** (opens here) — your league's front page: format dossier, draft
countdown, power rankings, standings, this week's matchups, league schedule strength,
and records/history.

Power rankings are built on four things, not two:

| Weight | Component | What it catches |
|---|---|---|
| 40% | **SRS** | Every margin adjusted for who you played. If the last-place team clobbers the first-place team, that counts far more than the same margin against a weak side — and losing narrowly to the best team barely hurts. Expressed in points per week, centred on zero. |
| 25% | **All-play** | Your record if you'd played *every* team every week. Removes schedule luck entirely. |
| 25% | **Roster strength** | The best legal lineup you can field going forward. |
| 10% | **Record** | It still counts, but least — in an 8-team league where all 8 make the playoffs, wins are noisy. |

Those weights ramp in with games played and reach full strength around six games,
with roster strength taking up the slack before then. Two weeks of results is mostly
noise, and if the schedule hasn't yet connected every team to every other, SRS
genuinely cannot compare one half of the league to the other. **Luck** is how far your
real record sits above or below your all-play record.

Standings show the *same columns from the same rows*, sorted by record instead of by
merit, so the two tables can never disagree.

**Settings tab** (last) — type your Sleeper username, pick your league, hit Import. That pulls
in your exact scoring rules, roster slots and team count. Everything it imported is
then editable, and any edit instantly re-ranks the draft board. If your league isn't
on Sleeper, skip the import and set the slots and scoring by hand.

**Draft Board tab** — sorted by VOR (see below), not by raw projected points. During
a Sleeper draft, click *Find my draft* then tick *Auto-sync* and it crosses off picks
every 5 seconds by itself. Otherwise click `me` / `gone` to track picks manually.

Three things on this tab do the actual thinking for you:

- **Take next** ranks by how much value you'd lose by passing, not by who's best.
  A player you can still get in two rounds is worth less right now than an equally
  good one who'll be gone — so it multiplies value over replacement by the chance
  he disappears before your next pick (estimated from average draft position),
  nudged toward slots you haven't filled.
- **Draft report card** grades the draft on two separate questions: did players fall
  to you past their average draft position (value), and is the roster you ended up
  with actually good (strength versus the rest of the league). Those come apart more
  often than you'd think.
- **Runs** watches the last 8 picks. When a position empties faster than usual the
  cost of waiting jumps, and that's when to reach a round early.
- **Rank: playoff weeks 15–17** re-ranks the entire board — replacement levels,
  VOR, tiers and grades all recomputed — on the three weeks that decide your season
  instead of the full year. Detroit at 1.0 season / 7.4 playoffs versus Indianapolis
  at 7.4 / 1.3 is a genuine pick-changer.

**Lineup tab** — opens with **this week in three decisions** (start / claim / cut),
assembled from your roster, the optimizer and what the rest of Sleeper is doing.
Below that: *Pull my roster from Sleeper*, set the week, and it shows the
highest-scoring legal lineup you can field, plus how many points that beats your
currently-set lineup by.

**Teams & Schedule tab** — *Load league rosters*, then:

- **Compare two teams** slot by slot. Each roster is put into its best legal lineup
  first, because a fourth good running back you can't start doesn't win games.
- **Best available in your league** — everyone nobody owns, ranked by VOR. This is
  your draft's leftovers before the season and your waiver-wire board after it.
- **NFL schedules & byes** for all 32 teams, playoff weeks broken out. Note this is
  a *different* measure from the League page's: this one is about the defences a
  player faces (a drafting question), that one is about the fantasy teams you play
  (a standings question).
- **Trade analyser** — tick who each side sends; both rosters are rebuilt and
  re-solved, so the number shown is the change in points you can actually *start*.
  A player who only upgrades your bench shows as roughly zero, which is the point.
- **Trending across Sleeper** — what every user on the platform is adding and
  dropping in the last 24 hours, marked free or owned in your league. Usually the
  earliest public sign that a player's role has changed.
- **Roster health** — problems a points total won't show you: three players on one
  NFL team (shared bye, shared game script), a kicker spent too early, a position
  you've stacked deeper than you can start, and bye weeks piling up.
- **Were the projections any good?** — measures projections against real box scores
  from four sampled weeks, both sides scored through your league's rules. On 2025 data
  it found quarterback projections ran **16% hot** while tight ends ran 4% cold, and
  that the average weekly miss is around 5.7 points on a ~10-point projection. Players
  who were projected but barely played are counted rather than excluded: if you started
  him and got nothing, the projection cost you the week.

It works on a phone. Below 820px the tables become cards rather than scrolling
sideways, so the draft board is usable one-handed while you're actually drafting.

Your settings and draft progress are saved in your browser (`localStorage`), so a
refresh mid-draft doesn't lose anything. *Erase all saved settings* on the Setup tab
resets it.

## On the design

It's set as a printed football annual — newsprint, ink type, one oxblood accent, ruled
stat sheets instead of floating cards, headings and figures in a serif. There's a dark
variant that swaps only the colour tokens; the type, rules and spacing don't change, so
it reads as the same design either way. It follows your system light/dark setting.

## The two ideas worth understanding

**VOR (Value Over Replacement).** Raw projected points are misleading across
positions: a QB might project for 360 points and a RB for 300, but that doesn't make
the QB the better pick, because *every* team's QB scores a lot. What matters is the
gap between a player and the guy you'd otherwise have at that position — the best
player who won't be starting anywhere in the league. The tool works out how many of
each position get started league-wide (12 teams × 2 RB slots = 24 RBs, plus flex
slots handed to whoever projects highest), and measures each player against the next
man up. That's why kickers and defenses sink to the bottom: everyone's is roughly
the same, so the gap is near zero.

**Tiers.** Within a position, a tier break is where the drop to the next player is
much larger than the drops have been. Inside a tier players are near-interchangeable
(take need or upside); across a break, don't wait.

**Grades vs. tiers** — these answer different questions on purpose. A **grade**
(S++ down to F) says what round a player is worth *overall*, measured in draft rounds
so it scales with league size: in your 8-team league round 1 is 8 picks, so S++ is the
top 4 players and S+ the next 4; a 12-team league stretches both. A **tier** says where
the cliffs are *within his position*. Grades tell you when to take someone; tiers tell
you whether you can afford to wait.

**Strength of schedule** is a proxy, and it's worth knowing why. This API has no
"fantasy points allowed by position" data, so difficulty is measured by each defence's
own projected fantasy output — units that pile up sacks, interceptions and shutouts are
the ones that smother offences. Good for ordering matchups, not a precise forecast. The
schedule and bye weeks themselves are exact: they're reconstructed from the opponent
listed on every weekly projection, asking for defences only (32 rows a week instead of
3,000) to keep it cheap.

## Where the numbers come from, and their limits

Projections come from Sleeper's public API (sourced from Rotowire), cached in your
browser for 6 hours. Sleeper publishes two things per player that don't quite agree:
a headline projected point total, and the component stats behind it. The headline is
modelled separately, and some component lines are unreliable — season-long defenses
overstate by about 13%.

So the tool uses both. It works out what a player's components are worth under
Sleeper's *own* default rules, compares that to *your* rules, and applies the
difference to Sleeper's headline number. Consequences worth knowing:

- With Sleeper's default scoring, every number here matches the Sleeper app exactly
  (verified across all 635 projected players, both feeds).
- Change a rule and projections move proportionally — 6-point passing TDs lift Josh
  Allen from 361.5 to 415.5, for instance.
- A `*` next to a number means there was no headline projection to anchor to, so
  it's a raw stat sum and less trustworthy. Only affects deep-bench players.
- Kicker and defense projections are the weakest, because Sleeper's stat detail for
  them is thin. Their *ordering* is reliable; treat the exact totals loosely.
- Sleeper has no bye-week field in this feed, so a player with no projection for the
  chosen week shows `BYE/—` and 0 points. That's usually a bye, but can also mean
  injured-out or simply not projected.

## Rebuilding / verifying after a change

There's no test framework to install — macOS ships Apple's JavaScript engine, so
`test.js` fakes up just enough of a browser, loads the real `app.js`, and checks it
against live data. Run it after any change to `app.js`:

```sh
sh run-tests.sh            # add --fresh to re-download the projection data
```

You want to see `*** ALL CHECKS PASSED ***` at the bottom. 295 checks currently,
covering:

- Every projected player, both feeds: under Sleeper's default rules the scoring
  engine must reproduce Sleeper's own number exactly.
- Changing a rule must actually move projections (so the anchoring can't silently
  flatten your settings into Sleeper's defaults).
- The optimizer against exhaustive brute force on 300 randomly generated rosters —
  identical totals, no player used twice, no illegal slot.
- Snake draft pick numbers, replacement levels, tier assignment.
- Every draw function against an empty state, a full state, odd league shapes and
  a search that matches nothing — a crash there would blank the page.
- Grade bands landing on the right picks at 8 and 12 teams, and no band left empty.
- Stat-key bridging, against a real 147-rule league config downloaded at test time.
- Strength-of-schedule ranking, including that tied schedules get equal ratings.
- SRS converging on a hand-solved algebraic answer, and the specific case of the
  bottom team hammering the top team moving both ratings the right way.
- All-play catching a team that scores second-best every week but keeps drawing the
  best team, and therefore sits 0-2 while deserving better.
- Power weights ramping down when only two games have been played.
- A uniform 10% shortfall registering as exactly −10% bias, which is what caught the
  bug where projections were anchored and actuals weren't.
- Roster comparison: elite rosters beating weak ones, unstartable players excluded
  from the total, empty and unknown-player rosters not crashing.
- Snake pick maths feeding the recommender: on the clock the wait runs to your next
  pick, off it to your upcoming one.
- That average draft position genuinely separates two otherwise identical players,
  which is the only reason the recommender differs from the plain board.
- Playoff mode summing three weeks correctly and rebuilding replacement levels on
  that basis rather than reusing season figures.
- The trade analyser: giving your best player away must cost you and help them,
  and trading a player for himself must be exactly neutral.
