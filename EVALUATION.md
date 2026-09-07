# BUST — model evaluation

*Report for the weights in `assets/net/`. Paths like `ckpt/final.pt`,
`agents.py` and `tests/wraparound_case.json` refer to the training project,
which lives outside this repo; the numbers below are what those weights scored.*

Checkpoint `ckpt/final.pt` (iteration 120), 463,650 parameters, 64 channels x 6 residual blocks.
Trained on 7x7 Duel, 384 self-play games per iteration at 96 simulations per move.

Elo differences are per-match-up, not a shared pool: "+300 vs Hard" means this model scores against *that* bot what a 300-point favourite would. Intervals are 95%.

## Against the shipped bots (Duel, 7x7)

| Opponent | Sims | Result (W-L-D) | Score | Elo | 95% interval | Mean plies |
|---|---:|---|---:|---:|---|---:|
| random | 32 | 112-0-0 | 100.0% | +939 | +939 to +939 | 42 |
| easy | 32 | 112-0-0 | 100.0% | +939 | +939 to +939 | 42 |
| medium | 32 | 111-1-0 | 99.1% | +818 | +627 to +939 | 44 |
| hard | 32 | 107-5-0 | 95.5% | +532 | +418 to +877 | 45 |
| expert | 32 | 55-1-0 | 98.2% | +696 | +502 to +818 | 47 |
| random | 96 | 112-0-0 | 100.0% | +939 | +939 to +939 | 42 |
| easy | 96 | 112-0-0 | 100.0% | +939 | +939 to +939 | 42 |
| medium | 96 | 112-0-0 | 100.0% | +939 | +939 to +939 | 45 |
| hard | 96 | 112-0-0 | 100.0% | +939 | +939 to +939 | 45 |
| expert | 96 | 56-0-0 | 100.0% | +818 | +818 to +818 | 48 |

## Against Brutal, in the browser, with the real clocks

Everything above runs the alpha-beta bots as a Python port with the wall-clock
budget removed, so they always finish their search. This is the other check:
the shipped `src/nn-bot.js` against the shipped `chooseMove(state, 'brutal')`,
both in Node, both on the real engine, real clocks on both sides.

| | |
|---|---|
| Result | **40-0 to the network** over 40 games |
| Opening | 20/20 |
| Replying | 20/20 |
| Mean move time | neural 1031 ms, brutal **3 ms** |

That last number is the one worth keeping. `expert` and `brutal` are the same
search in `ai.js` -- same depth 3, same evaluation, same ordering, zero noise
and zero blunder rate -- and differ only in `budgetMs` (1100 vs 1600). At 7x7
the search finishes in about 3 ms, so neither rung ever reaches its clock and
the two play identical moves. That is also why removing the clock in the Python
port cost the baseline nothing: there was nothing to cut off.

## How much the search is worth

Same weights, more simulations per move, all against the same opponent (`hard`, a 2-ply alpha-beta search). Simulation 0 is the raw policy with no search at all.

| Sims | Result (W-L-D) | Score | Elo vs hard |
|---:|---|---:|---:|
| 0 | 82-30-0 | 73.2% | +175 |
| 8 | 108-4-0 | 96.4% | +573 |
| 16 | 105-7-0 | 93.8% | +470 |
| 32 | 110-2-0 | 98.2% | +696 |
| 64 | 109-3-0 | 97.3% | +624 |
| 128 | 110-2-0 | 98.2% | +696 |

## Training progress

Each snapshot against the final model, both at 32 simulations. A score of 50% would mean no progress after that point.

| Snapshot | Overall | Elo gap | Wins when it opens | Wins when it replies |
|---|---:|---:|---:|---:|
| iter 20 | 37.1% | -92 | 53/112 | 30/112 |
| iter 40 | 47.8% | -16 | 68/112 | 39/112 |
| iter 60 | 52.2% | +16 | 72/112 | 45/112 |
| iter 80 | 54.9% | +34 | 78/112 | 45/112 |
| iter 100 | 44.6% | -37 | 58/112 | 42/112 |
| iter 120 | 50.0% | -0 | 67/112 | 45/112 |

The opening seat wins the great majority of games between strong players here, so the overall column compresses towards 50% however big the gap really is. The last column — games won from the *second* seat — is the sensitive one.

Read down that column and the run is done by about iteration 60. Iterations 20
and 40 are clearly weaker; 60, 80, 100 and 120 are indistinguishable from each
other and from the final model. A longer head-to-head confirms it: iteration 80
against the final model over 896 games with randomised openings scores
**51.9% ± 1.7** — a coin flip. The last 40 iterations bought nothing measurable.

That is worth knowing before spending another night on it. More iterations at
this size will not help; a bigger network, more simulations per move, or more
games per iteration might. What did land is all in the first half of the run.

## The first-seat advantage

The model against itself, seats never swapped, Gumbel noise on so the games differ. Under *random* play the seats are even (50.4% over 9,500 games), so anything here is an edge that only appears once both sides play well.

| Board | Seats | Opening seat wins | Mean plies |
|---|---:|---:|---:|
| 7x7 (Duel) | 2 | 96/112 (86%) | 59 |
| 8x8 | 2 | 57/112 (51%) | 51 |
| 9x9 | 2 | 71/112 (63%) | 50 |
| 11x11 | 2 | 61/112 (54%) | 51 |

An opening claims a 3x3 zone and no two zones may overlap, so on a 7x7 board
the first seat can take the middle and leave the second nothing but the rim,
where a bust throws balls off the board. Then it moves first as well. The edge
is specific to 7x7 and mostly gone by 8x8 — the next section separates the two
possible causes and settles which it is.

## Outside Duel

The network is fully convolutional, so it runs on any board size. It was trained on two seats, though, and its *search* assumes what two-seat search assumes: that a point for me is a point against you. Against three opponents that is false, and the effect is not subtle — adding simulations makes the same weights play worse.

Seat 0 is the one under test; the other seats all play the opponent listed. Seat 0 opens first, which is worth a lot in this game, so the row that matters is the **control**: the same seat played by the bot the neural rung would be replacing.

Each row here met its own set of opponents and its own luck, and the three
network rows disagree with each other across the table — which is a sign the
comparison is underpowered, not a result. "Choosing the free-for-all method"
below repeats it properly, with all the candidates at one table.

| Mode | Board | Opponents | Seat 0 | Wins | Win rate |
|---|---|---|---|---:|---:|
| Rumble | 8x8 | 3 x hard | `hard` bot (control) | 27/112 | 24% |
| Rumble | 8x8 | 3 x hard | network, policy only | 68/112 | 61% |
| Rumble | 8x8 | 3 x hard | network, one-ply own-perspective | 48/112 | 43% |
| Rumble | 8x8 | 3 x hard | network, 32-sim two-seat search | 19/112 | 17% |
| Rumble | 8x8 | 3 x expert | `expert` bot (control) | 18/56 | 32% |
| Rumble | 8x8 | 3 x expert | network, policy only | 20/56 | 36% |
| Rumble | 8x8 | 3 x expert | network, one-ply own-perspective | 30/56 | 54% |
| Rumble | 8x8 | 3 x expert | network, 32-sim two-seat search | 16/56 | 29% |
| Big Arena | 10x10 | 3 x hard | `hard` bot (control) | 28/112 | 25% |
| Big Arena | 10x10 | 3 x hard | network, policy only | 72/112 | 64% |
| Big Arena | 10x10 | 3 x hard | network, one-ply own-perspective | 63/112 | 56% |
| Big Arena | 10x10 | 3 x hard | network, 32-sim two-seat search | 28/112 | 25% |
| Chaos | 10x10 + walls | 3 x hard | `hard` bot (control) | 26/112 | 23% |
| Chaos | 10x10 + walls | 3 x hard | network, policy only | 58/112 | 52% |
| Chaos | 10x10 + walls | 3 x hard | network, one-ply own-perspective | 96/112 | 86% |
| Chaos | 10x10 + walls | 3 x hard | network, 32-sim two-seat search | 37/112 | 33% |

Chance alone would be 25%.

## The weights the browser actually loads

The exported model — BatchNorm folded in, weights rounded to float16 — played the float32 original 112 games and scored **50.0%** (56-56-0). Halving the download costs nothing measurable in strength.


## Where the first-seat advantage comes from

The table above shows an edge that is specific to 7x7 and mostly gone by 9x9.
This isolates the cause. The model plays itself, seats never swapped, and the
only thing that changes is how much of the opening round is taken out of its
hands and made random.

| Board | Opening round | Opening seat wins | Mean plies |
|---|---|---:|---:|
| 7x7 | both seats pick their own opening | 194/224 (87%) | 58 |
| 7x7 | the opener's placement is forced random | 89/224 (40%) | 53 |
| 7x7 | both placements are forced random | 137/224 (61%) | 49 |
| 9x9 | both seats pick their own opening | 126/224 (56%) | 49 |
| 9x9 | the opener's placement is forced random | 130/224 (58%) | 48 |
| 9x9 | both placements are forced random | 129/224 (58%) | 49 |
| 11x11 | both seats pick their own opening | 132/224 (59%) | 51 |
| 11x11 | the opener's placement is forced random | 146/224 (65%) | 47 |
| 11x11 | both placements are forced random | 132/224 (59%) | 47 |

Read the 7x7 rows in order. When both seats choose, the opener wins 87%. Take
the opener's *choice* away and leave the reply free, and it drops to 40% — the
advantage does not shrink, it changes hands. Take both choices away and it
settles at 61%, which is about what moving first is worth on its own.

So on 7x7 the game is decided by who gets to pick their 3x3 zone, not by who
moves first. On 9x9 and 11x11 the same three rows are flat at 56-65%: there is
room for both seats to take a good zone, so the choice stops being worth
anything and only the move-first edge is left.

That reads as a board-size problem rather than a rule problem. A 7x7 board has
exactly one central zone worth having, and the non-overlap rule hands it to
whoever asks first. Widening Duel to 9x9 costs nothing else and takes the
opener from 87% to 56%. If 7x7 is the board you want, a pie rule — the opener
nominates two zones and the other seat picks which one it takes — would do the
same job without changing the map.

(Caveat on the wider boards: the model was trained at 7x7 and is playing 9x9
and 11x11 on transfer, so those rows compare the two seats to each other, not
absolute strength. The 7x7 rows have no such caveat, and they are the ones
carrying the argument.)

## Choosing the free-for-all method

Three ways to use the same weights at a four-seat table, and the first
measurements of them disagreed with each other — each method met different
opponents in different games. Seating them at one table and rotating them
through every position pairs the comparison exactly.

| Board | prior | one-ply k=8 | one-ply all | alpha-beta |
|---|---:|---:|---:|---:|
| 8x8 (vs `expert`) | 125/224 (56%) | 47/224 (21%) | 28/224 (12%) | 24/224 (11%) |
| 10x10 (vs `expert`) | 86/224 (38%) | 42/224 (19%) | 67/224 (30%) | 29/224 (13%) |
| 10x10 + walls (vs `hard`) | 47/224 (21%) | 56/224 (25%) | 59/224 (26%) | 62/224 (28%) |

Chance is 25%. The raw prior wins the two open boards outright, so that is what
ships. The one-ply variant — scoring each candidate's resulting position from
*my* seat rather than the mover's — looked better in the unpaired runs and is
not; it is in the codebase (`agents.py`, and `ffaLookahead` in `nn-bot.js`)
because it was worth measuring, not because it is used.

The walled row is the one that changed a shipping decision. On a walled board
every neural method lands at or below the `hard` bot, which is not surprising —
Duel and Rumble have no walls, so the network never saw one. So the rung
declines walled tables as well as team ones, and Chaos keeps its alpha-beta bot.

## The 5x5 model from the July run, head to head

The repo root holds an earlier project: a 376k-parameter net trained for 300
iterations on a 5x5 board under the rules in root `engine.py`. Those rules are a
close cousin of the shipped ones — uniform capacity 3, bust at 4, `dots - 3` to
each orthogonal neighbour — but not the same game. The opening drops a 3-dot
cell without bursting, only diagonal adjacency is barred for the second seat,
and cascades run FIFO with a cell never bursting twice.

So there is no neutral ground, and the comparison is run twice, on 5x5 both
times, with both networks driven by the *same* Gumbel search at 96 simulations
and the seats alternated. Each network also plays a random mover in each rule
set first: that is the guard against an encoding adapter quietly crippling one
side, which would look exactly like weakness. All four sanity matches were
60-0.

| Rules | New model | Wins opening | Wins replying |
|---|---:|---:|---:|
| Old (root `engine.py`) — the old model's home | **40.5%** (81-119) | 54/100 | 27/100 |
| Shipped (`BustGame`) on 5x5 | **56.5%** (113-87) | 94/100 | 19/100 |

Read each row by seat and both are internally consistent: on the old rules the
old model is better from *both* seats (73/100 opening against the new model's
54, 46/100 replying against 27), and on the shipped rules the new model is
better from both (94 against 81, and 19 against 6). Each network is better at
the game it was trained on, and the old model's margin at home — 19 points in
each seat — is if anything the larger of the two.

The reading is not "one model is better". It is that these are models of
different rule sets. The new model transferred to a rules change it had never
seen and still took 40.5%; the old model transferred the other way and took
43.5%. Neither collapsed, and neither is a strict upgrade of the other.

What the old model cannot do is leave 5x5. Its policy head ends in
`Linear(2*25 -> 25)`, so 7x7 Duel — never mind 12x12 Mayhem — is not a match it
can be entered in at all. That, rather than any strength result, is why the new
network is fully convolutional.

Also worth noting from the seat columns: under the shipped opening rule the
opener wins 87.5% of these 5x5 games, against 63.5% under the old rule. The 3x3
non-overlap zone is the imbalance, and a 5x5 board is the worst case for it —
which is the same finding as the section above, arriving from a different
direction.
