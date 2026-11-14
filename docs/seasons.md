# The first three seasons

Status: plan only. The campaign it describes is designed in
[`campaign-design.md`](campaign-design.md) and not yet built.

Three seasons are planned before the first one is deployed. They tell one continuous story, and
each is adjusted by how the season before it ended.

Clock defaults (all configuration): a season lasts six weeks, the intermission between seasons
one week, and the campaign tick is one minute.

## 1. How one season shapes the next

**A season is data.** A `SeasonConfig` holds the portal network, the portal activation budget,
the countries, the rule changes, the scheduled disruptions, the scoring weights and the story
text. Nothing about a season is hard-coded.

**An ending is measured.** When a season is archived, a small set of outcome measures is
computed from the archived state:

| Measure | Computed from |
|---|---|
| Accord index (0 to 1) | share of treaty terms fulfilled, and how much shared infrastructure was used by a country that did not build it |
| Conflict index | province-days under occupation (always 0 in season 1) |
| Disruption response | how the season's disruption was met (a value per season, below) |
| Busiest trade route | the corridor with the most freight delivered |
| Champion country, best-run city | final scores |
| Planets discovered | portal activations |
| Dominant and scarcest goods | production and shortage totals |
| Megaproject result | season 3 only |

**The next season has hooks.** A season template lists hooks. Each hook reads one measure and
has two or three branches, one of them the **default**. A pure function,
`nextSeason(template, outcomes)`, picks a branch for every hook and returns the next
`SeasonConfig`. Because every hook has a default, each season is completely specified before
the previous one has been played.

**Solo and online play the same seasons.** A single-player campaign runs these seasons, hooks
and story exactly as an online one, with computer-run countries in place of other players.
Every season opens at peace.

**Carry-over rules.**

- Carry-over changes the world and the story. It never changes a team's treasury, stockpile or
  starting territory. Veterans start level with newcomers.
- Winners are remembered by name: the champion country and the best-run city become named
  landmarks, and their players keep cosmetics.
- No hook requires a war. Every season can be played in peace whichever branches are chosen.
- Planets persist across seasons by id, seed and generator version. Their player edits are
  archived, not kept in play.

## 2. Season 1: First Light

**Story.** The Grid powers up. Three young countries, Cyan, Red and Amber, hold a third of the
land each. On the edge of the city stands a gate that has never been lit.

**Opening bulletin.** *"Power is nominal across all sectors. Three administrations have been
registered. One gate terminal reports: dormant. Begin."*

**Setup.** The home Grid only. One dormant portal known at the start and one more to find.
Activation budget: 2.

**In play.** Cities, roads and zoning; food, fuel and construction materials; freight on the
road network; national votes; treaties; peaceful province transfers and accession; the first
generated planet. There are no war rules this season.

**Disruption.** In week four a surge from the Sea of Simulation closes the low crossings
(the existing surge events in `sim.atmosphere.events`). Freight must share the high crossing,
which has limited capacity, or a bypass must be funded.

**Scoring.** Service reliability, fulfilled contracts, shared infrastructure used by others,
growth.

**Disruption response** recorded for season 2: `bypass` (a bypass was funded and finished),
`shared` (the crossing was shared under a treaty), or `unresolved`.

**Closing bulletins.**

- High accord: *"The crossings are open and the ledgers balance. The administrations have
  learned to carry each other's freight."*
- Low accord: *"The crossings are open. The administrations count what they are owed."*

## 3. Season 2: Open Gates

**Story.** The gates answer. The network reaches three or four planets, and one good the Grid
depends on turns out to lie mostly off-world. Whoever runs the terminals decides what moves.

**Opening bulletin.** *"Gate terminals report: open. Destinations resolved. Freight queues are
forming. Capacity is finite."*

**Setup.** The planets discovered in season 1 return with the same seeds. The cities players
built there are archived and reappear as neutral cities under their mayors' names. Network of
three to four planets. Activation budget: 3. One of the three goods is produced mostly
off-world.

**New in play.** Terminal capacity upgrades and leases; reserved capacity in treaties; optional
war, with telegraphed mobilisation, occupation distinct from sovereignty, and ceasefires that
reopen civilian passage.

**Disruption.** In week three a signal storm cuts one portal link. It can be repaired by a
funded project, freight can be rerouted through other terminals, or countries can contest the
links that remain.

**Hooks from season 1.**

| Measure | Branch | Effect on season 2 |
|---|---|---|
| Accord index | high | The season opens with "the Accord": a shared neutral freight terminal on the home Grid, open to all |
| | low (default) | The season opens with fewer crossings between countries; each is a chokepoint |
| Disruption response | `bypass` | The bypass exists from the start |
| | `shared` (default) | The high crossing has been widened |
| | `unresolved` | The low crossings are weak and close again in week two |
| Busiest trade route | always | That corridor is a data highway from the start |
| Champion, best-run city | always | Both are named landmarks on the map |

**Disruption response** recorded for season 3: `repaired`, `rerouted` or `abandoned`.

**Closing bulletins.**

- No conflict: *"Every gate is lit and none is guarded. The queues are long and orderly."*
- Conflict: *"Every gate is lit. Some of them changed hands to stay that way."*

## 4. Season 3: The Dimming

**Story.** The home Grid's energy is failing. Fuel output falls a little every week. Far out on
the network stands the site of the Relay, a beam tower that could carry power across the
gates, if anyone can agree to build it.

**Opening bulletin.** *"Output is below nominal and falling. Projection: sectors will go dark
in order of distance from the core. One remedy is on file. It has never been built."*

**Setup.** The whole network of season 2. Fuel output on the home Grid falls each week; the
scarcest good of season 2 is hit hardest alongside it.

**New in play.** Federations, which combine national governance while cities keep their
autonomy. The Relay megaproject: a fluted cylinder of vertical slats on a pedestal with a beam
rising to the sky (book pp. 60 to 62), built in stages from all three goods delivered through
the portals. Any country or coalition may build it. Completing it ends the Dimming for
everyone.

**Disruption.** The Dimming itself, on a published schedule.

**Hooks from season 2.**

| Measure | Branch | Effect on season 3 |
|---|---|---|
| Conflict index | above zero | Scarred provinces: damaged infrastructure and cheap land where the fighting was, with reconstruction contracts that score |
| | zero (default) | One extra portal activation |
| Disruption response | `repaired` | The Dimming starts two weeks later |
| | `rerouted` (default) | The Dimming starts on schedule |
| | `abandoned` | The cut planet starts isolated and must be reconnected |
| Scarcest good | always | That good is the one the Dimming hits hardest |

**Closing bulletins.**

- Built by a coalition: *"The beam is up. It was raised by many hands and it lights them all."*
- Built by one country: *"The beam is up. One administration holds the switch."*
- Not built: *"Output: minimal. The outer sectors are dark. The gates still answer."*

## 5. After season 3

The Relay's fate opens a fourth season.

- **Built by a coalition.** Power is plentiful and shared. Season 4 turns outward: a larger
  activation budget, deeper chains of planets, and scoring that favours exploration and new
  settlements.
- **Built by one country.** Power is plentiful and owned. Season 4 opens with a published
  energy tariff set by the Relay's holder, and a second Relay site for anyone who wants an
  alternative.
- **Not built.** The home Grid's outer provinces start dark. Season 4 is a migration: countries
  begin on the off-world planets and work their way back to relight the Grid.

## 6. Check

When the season code exists, `npm run seasons` runs every combination of branches through
`nextSeason` and verifies each resulting configuration: the portal network is connected, every
country has a viable start, no team receives resources from carry-over, and no branch makes
war necessary.
