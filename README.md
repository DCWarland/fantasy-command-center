# Fantasy Command Center

A draft board and lineup optimizer that runs entirely in your browser. Three static
files — no server, no database, no build step — so it works on GitHub Pages as-is.

## The files

| File | What it is |
|---|---|
| `index.html` | The page structure: three tabs and the tables/forms inside them. |
| `style.css` | Purely how it looks. Safe to fiddle with. |
| `app.js` | All the logic: fetching data, scoring, draft values, the optimizer. |
| `test.js`, `run-tests.sh` | Checks the logic still works. Not needed on the website — don't upload them if you'd rather not. |

## Putting it on GitHub Pages

1. Create a repo on GitHub (public is fine — there's nothing secret in here).
2. Upload all three files to the **root** of the repo, not inside a folder.
3. In the repo: **Settings → Pages**. Under "Build and deployment", set
   **Source** to `Deploy from a branch`, **Branch** to `main` and folder `/ (root)`.
   Click Save.
4. Wait a minute, then open `https://<your-username>.github.io/<repo-name>/`.

To check it worked: the badge at the top of the page should show the current NFL
season and week. If it says `offline`, the projection download failed — open your
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

**Setup tab** — type your Sleeper username, pick your league, hit Import. That pulls
in your exact scoring rules, roster slots and team count. Everything it imported is
then editable, and any edit instantly re-ranks the draft board. If your league isn't
on Sleeper, skip the import and set the slots and scoring by hand.

**Draft Board tab** — sorted by VOR (see below), not by raw projected points. During
a Sleeper draft, click *Find my draft* then tick *Auto-sync* and it crosses off picks
every 5 seconds by itself. Otherwise click `me` / `gone` to track picks manually.

**Lineup tab** — *Pull my roster from Sleeper*, set the week, and it shows the
highest-scoring legal lineup you can field, plus how many points that beats your
currently-set lineup by.

**Teams & Schedule tab** — *Load league rosters*, then:

- **Compare two teams** slot by slot. Each roster is put into its best legal lineup
  first, because a fourth good running back you can't start doesn't win games.
- **Best available in your league** — everyone nobody owns, ranked by VOR. This is
  your draft's leftovers before the season and your waiver-wire board after it.
- **Strength of schedule** for all 32 NFL teams, with the fantasy playoff weeks
  (15&ndash;17) broken out separately, plus every team's bye week.
- **Your bye weeks**, flagged when three or more of your players are idle together.

It works on a phone. Below 820px the tables become cards rather than scrolling
sideways, so the draft board is usable one-handed while you're actually drafting.

Your settings and draft progress are saved in your browser (`localStorage`), so a
refresh mid-draft doesn't lose anything. *Erase all saved settings* on the Setup tab
resets it.

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

You want to see `*** ALL CHECKS PASSED ***` at the bottom. 161 checks currently,
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
- Roster comparison: elite rosters beating weak ones, unstartable players excluded
  from the total, empty and unknown-player rosters not crashing.
