# The Graph: roadmap

The order we build the milestone **The Graph: one document, three relationships** in. The
spec is [GRAPH.md](GRAPH.md); this page is only the order and the reasons for it.

**Status is not kept here.** An issue is open or closed on GitHub and its column is on the
project board; a tick on this page would be wrong the day after it was written. Change this
page when the order changes, and say why in the commit.

## Who builds what

Nodes belong to this milestone. That includes the **Rig node**, the container a rig lives
in. What goes inside a rig (IK setup, constraints, controls, components, skin weights) is
the Pro Rigging epic (#1334), built in parallel. Steps 1 and 2 are ordered so that work is
never waiting on this one.

## The order

### 1. The Rig node

- #1357: rig logic lives in one sub-network on the pose wire.

It is first because the rigging work needs somewhere to put things. It builds on the
single-owner rule and named inputs (rule 2 in GRAPH.md §4), and adds the two things a
sub-network on the pose wire needs: an input leaf that carries a pose, and an owner that is
not cooked per frame, whose leaves the evaluator resolves itself.

### 2. Sub-networks grow up

- #1558: sub-networks can nest. Needed once a Rig holds a Solver or another Rig.
- #1576: a pose chain can be longer than 31 layers. Beside #1558 because both are about how
  far one evaluation may reach.
- #1574: a slot past the end of a list input reads the origin silently.
- #1549: socket types convert, or say a converter is needed.
- #1579: a Solver or Lag inside a sub-network that reads the outer Solver's previous output.
- #1580: `addNode` can create a wire of a type its socket does not take.
- #1581: a wire that closes a loop through 34 or more nodes. Beside #1580: both are a check
  `connect` makes that had a way round it.
- #1577: a regeneration compares the layers inside a Rig.

### 3. References

- #1553: one query for every relationship of a node, with reference cycles reported.
- #1552: a channel, driver or constraint aimed at a parameter path that does not exist.
- #1572: Scene, Group and Collection keep parameter keys their schema does not declare.

### 4. One rule each

Both are derived from the query in #1553, so they follow it.

- #1560: one delete rule.
- #1561: one duplicate rule, deep and linked.

### 5. Templates

- #1557: save a sub-network as a reusable node, with definitions stored once.
- #1559: Lag and Spring become Solver presets, not node types.

Before the document work because rig templates wait on it.

#1559 was in step 2 and moved here. The issue calls a preset "the first real user of
templates"; built before them it would be a one-off builder plus a format migration for old
Lag nodes, and then be rebuilt as a template. The engine it needs is already proven: a Solver
over one Mix node matches a Lag sample for sample.

### 6. The document is the graph

- #1550: the scene and render outputs can be rebound by an operation.
- #1562: node positions are stored.
- #1565: no document state outside the graph.
- #1566: every relationship kind survives a save and load.
- #1567: every UI gesture goes through the 8 operations.

### 7. Seeing it

- #1563: a read-only node view, one level at a time.
- #1564: the agent and the node view see the same graph.
- #1556: a read-only spreadsheet of a node's attributes.

## In the milestone, not yet placed in the order

- #1554: material assignment as a per-face reference, with its migration (decided in #1544).
- #1555: each operator declares what it does to every attribute, in one table.
- #606: operators materialise their source instead of holding a handle.
- #1582: a Lag or Solver inside a Solver reads that Solver's inputs, the two integrated
  together. Refused since #1579; it may be easier once templates (#1557) settle what a
  sub-network's state is.
- #1585: applying an operation costs more the larger the graph is. Found by timing a large
  import for #1583, which took the sub-network rules out of that cost.

## Decisions this order is waiting on

- #1552: what to do with a path that does not exist. The issue asks for a check against the
  target's parameter schema; that would refuse legitimate paths, because a channel writes
  onto the evaluated value, not the schema. The choice is between refusing only when the
  measured list of animatable paths is certain, and reporting without refusing.
- #1545: three differences from Houdini (GRAPH.md §6 rows 19, 22 and 29) each need
  keep, change or defer, with the reason.

## Rules for working through it

- One issue, one branch, one commit that closes it. Related commits may share a pull request.
- A change to the project format takes the next free version number; check what main is on
  before choosing one.
- A rule that refuses an edit refuses only what the edit introduces, so a project saved
  before the rule existed still loads and edits.
