// Sokoban solver: push-optimal per room, then stitched together.
//
// The level is a hallway with rooms off it (one door each). A box pushed
// out of a door into the hallway can never come back, so every box stays in
// its room and each room is an independent push-optimal problem; the level
// optimum is the sum of the rooms' optima. Each room is solved with a
// push-based A* (cost = pushes) over box positions plus the player's
// reachable region, with a min-assignment heuristic, dead-square pruning
// and 2x2 freeze pruning. Rooms are joined by plain walks along the
// hallway. Deterministic: fixed node budgets, fixed orderings, no clock,
// no randomness, no environment reads beyond the input/output dirs.
//
// Run: MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed work budgets (expansions), never the clock: deterministic output.
// Practice rooms need at most ~1,100 expansions each; the budgets below
// leave wide headroom while bounding the whole run far inside the 60
// second wall even if a scored room is far harder. The run budget is
// shared by every room of every instance, so one hard room cannot eat
// the wall the other instances need.
const ROOM_BUDGET = 80000;
const RUN_BUDGET = 250000;
const STATE_CAP = 400000;

const DIRS: [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

interface Parsed {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parse(text: string): Parsed {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** Breadth-first walk distances from `from` over `cells`, ignoring boxes. */
function bfsDist(w: number, cells: Set<number>, from: number): Map<number, number> {
  const dist = new Map<number, number>([[from, 0]]);
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!;
    const cx = c % w;
    const cy = Math.floor(c / w);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0) continue;
      const n = ny * w + nx;
      if (!cells.has(n) || dist.has(n)) continue;
      dist.set(n, dist.get(c)! + 1);
      q.push(n);
    }
  }
  return dist;
}

/**
 * One breadth-first walk from `from` over `cells` avoiding `blocked`:
 * the parent map (cell -> [previous cell, step letter]) covering the
 * whole reachable region, so one search serves every candidate push
 * from the same player position. Deterministic neighbour order.
 */
function walkBfs(
  w: number,
  cells: Set<number>,
  blocked: Set<number>,
  from: number,
): Map<number, [number, string]> {
  const prev = new Map<number, [number, string]>([[from, [-1, '']]]);
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!;
    const cx = c % w;
    const cy = Math.floor(c / w);
    for (const [dx, dy, ch] of DIRS) {
      const n = (cy + dy) * w + (cx + dx);
      if (!cells.has(n) || blocked.has(n) || prev.has(n)) continue;
      prev.set(n, [c, ch]);
      q.push(n);
    }
  }
  return prev;
}

/** Rebuild the walk string to `to` from a walkBfs parent map. */
function walkString(prev: Map<number, [number, string]>, from: number, to: number): string | null {
  if (from === to) return '';
  if (!prev.has(to)) return null;
  let s = '';
  let cur = to;
  while (cur !== from) {
    const [p, letter] = prev.get(cur)!;
    s = letter + s;
    cur = p;
  }
  return s;
}

/**
 * A walk from `from` to `to` over `cells` avoiding `blocked`, as a move
 * string, or null when unreachable. Deterministic neighbour order.
 */
function walkPath(
  w: number,
  cells: Set<number>,
  blocked: Set<number>,
  from: number,
  to: number,
): string | null {
  return walkString(walkBfs(w, cells, blocked, from), from, to);
}

/** Cells from which a goal is reachable in the push graph (box moves, player ignored). */
function liveCells(w: number, cells: Set<number>, goals: number[]): Set<number> {
  const live = new Set<number>(goals);
  const q = [...goals];
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!;
    const cx = c % w;
    const cy = Math.floor(c / w);
    // A box now at c could have been pushed here from a neighbour n:
    // push direction d = c - n, needs the cell behind n (n - d) to be floor.
    for (const [dx, dy] of DIRS) {
      const nx = cx - dx;
      const ny = cy - dy;
      const n = ny * w + nx;
      if (!cells.has(n) || live.has(n)) continue;
      const bx = nx - dx;
      const by = ny - dy;
      const behind = by * w + bx;
      if (!cells.has(behind)) continue;
      live.add(n);
      q.push(n);
    }
  }
  return live;
}

/** True when a box not on a goal sits inside a fully blocked 2x2 square. */
function frozen2x2(
  w: number,
  h: number,
  wall: Uint8Array,
  boxSet: Set<number>,
  boxes: number[],
  goalSet: Set<number>,
): boolean {
  for (const b of boxes) {
    if (goalSet.has(b)) continue;
    const bx = b % w;
    const by = Math.floor(b / w);
    for (const [ox, oy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
      const x0 = bx + ox;
      const y0 = by + oy;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
      let full = true;
      let hasBox = false;
      for (let yy = y0; yy <= y0 + 1; yy++) {
        for (let xx = x0; xx <= x0 + 1; xx++) {
          const c = yy * w + xx;
          if (boxSet.has(c)) hasBox = true;
          else if (!wall[c]) { full = false; break; }
        }
        if (!full) break;
      }
      if (full && hasBox) return true;
    }
  }
  return false;
}

interface PushResult {
  moves: string;
  endPlayer: number;
  pushes: number;
}

/**
 * Push-optimal A* over one independent region. `cells` are the squares the
 * player may walk and boxes may occupy; `goals` the goals inside it.
 * Returns the move string from `player`, or null when the budget runs out.
 */
function pushAStar(
  w: number,
  h: number,
  wall: Uint8Array,
  cells: Set<number>,
  goals: number[],
  boxes0: number[],
  player0: number,
  budget: number,
  work: { left: number },
): PushResult | null {
  const goalSet = new Set(goals);
  const live = liveCells(w, cells, goals);
  if (boxes0.some((b) => !live.has(b))) return null;
  if (boxes0.every((b) => goalSet.has(b))) return { moves: '', endPlayer: player0, pushes: 0 };

  // Walking distances between cells, ignoring boxes (admissible per pair).
  const distFrom = new Map<number, Map<number, number>>();
  for (const c of cells) distFrom.set(c, bfsDist(w, cells, c));

  const n = boxes0.length;
  // All goal permutations, fixed order, for the assignment heuristic.
  const perms: number[][] = [];
  const build = (used: boolean[], cur: number[]): void => {
    if (cur.length === n) { perms.push([...cur]); return; }
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      used[j] = true;
      cur.push(j);
      build(used, cur);
      cur.pop();
      used[j] = false;
    }
  };
  build(new Array(n).fill(false), []);

  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    for (const p of perms) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const d = distFrom.get(boxes[i])!.get(goals[p[i]]!);
        if (d === undefined) { s = Infinity; break; }
        s += d;
      }
      if (s < best) best = s;
    }
    return best;
  };

  // State storage: boxes, player, parent, the moves that made it, pushes,
  // and the closed-set key (boxes + canonical player region) fixed at birth,
  // so a pop never re-derives the region it was stored with.
  const stBoxes: number[][] = [boxes0.slice()];
  const stPlayer: number[] = [player0];
  const stParent: number[] = [-1];
  const stMoves: string[] = [''];
  const stG: number[] = [0];
  const stKey: string[] = [''];

  const regionOf = (boxes: number[], from: number): number[] => {
    const blocked = new Set(boxes);
    const seen = new Set<number>([from]);
    const q = [from];
    for (let i = 0; i < q.length; i++) {
      const c = q[i]!;
      const cx = c % w;
      const cy = Math.floor(c / w);
      for (const [dx, dy] of DIRS) {
        const nn = (cy + dy) * w + (cx + dx);
        if (!cells.has(nn) || blocked.has(nn) || seen.has(nn)) continue;
        seen.add(nn);
        q.push(nn);
      }
    }
    return [...seen].sort((a, b) => a - b);
  };

  const keyOf = (boxes: number[], player: number): string => {
    const region = regionOf(boxes, player);
    return boxes.join(',') + '|' + region[0];
  };

  const closed = new Map<string, number>();
  const h0 = heuristic(boxes0);
  if (h0 === Infinity) return null;
  stKey[0] = keyOf(boxes0, player0);
  closed.set(stKey[0]!, 0);

  // Binary heap of [f, -g, seq, state]. Fixed tie-breaks: deeper first, then oldest.
  const heap: [number, number, number, number][] = [];
  let seq = 0;
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  heapPush([h0, 0, seq++, 0]);

  let expanded = 0;
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    const boxes = stBoxes[s]!;
    const player = stPlayer[s]!;
    const g = stG[s]!;
    if (closed.get(stKey[s]!) !== g) continue;
    if (boxes.every((b) => goalSet.has(b))) {
      let moves = '';
      for (let t = s; t > 0; t = stParent[t]!) moves = stMoves[t]! + moves;
      return { moves, endPlayer: player, pushes: g };
    }
    if (expanded >= budget || work.left <= 0) return null;
    expanded++;
    work.left--;
    const boxSet = new Set(boxes);
    // One walk search serves every candidate push from this position.
    const reach = walkBfs(w, cells, boxSet, player);
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi]!;
      const bx = b % w;
      const by = Math.floor(b / w);
      for (const [dx, dy, ch] of DIRS) {
        const dest = (by + dy) * w + (bx + dx);
        if (!cells.has(dest) || boxSet.has(dest)) continue;
        const behind = (by - dy) * w + (bx - dx);
        if (!cells.has(behind) || !reach.has(behind)) continue;
        const walk = walkString(reach, player, behind);
        if (walk === null) continue;
        const nb = boxes.slice();
        nb[bi] = dest;
        nb.sort((a, b2) => a - b2);
        if (nb.some((x) => !live.has(x))) continue;
        const nbSet = new Set(nb);
        if (frozen2x2(w, h, wall, nbSet, nb, goalSet)) continue;
        const key = keyOf(nb, b);
        const seen = closed.get(key);
        if (seen !== undefined && seen <= g + 1) continue;
        const hh = heuristic(nb);
        if (hh === Infinity) continue;
        if (stBoxes.length >= STATE_CAP) return null;
        const t = stBoxes.length;
        stBoxes.push(nb);
        stPlayer.push(b);
        stParent.push(s);
        stMoves.push(walk + ch);
        stG.push(g + 1);
        stKey.push(key);
        closed.set(key, g + 1);
        heapPush([g + 1 + hh, -(g + 1), seq++, t]);
      }
    }
  }
  return null;
}

interface Room {
  door: number;
  hall: number;
  cells: Set<number>;
  goals: number[];
  boxes: number[];
}

/** Split the level into its rooms via the doors off the player's hallway row. */
function findRooms(p: Parsed): Room[] | null {
  const hr = Math.floor(p.player / p.w);
  const rooms: Room[] = [];
  const allCells = new Set<number>();
  for (let i = 0; i < p.w * p.h; i++) if (!p.wall[i]) allCells.add(i);
  for (const side of [-1, 1] as const) {
    const doorRow = hr + side;
    if (doorRow < 0 || doorRow >= p.h) continue;
    for (let x = 0; x < p.w; x++) {
      const door = doorRow * p.w + x;
      if (p.wall[door]) continue;
      const inside = (hr + 2 * side) * p.w + x;
      if (inside < 0 || inside >= p.w * p.h || p.wall[inside]) continue;
      // Flood the room from just inside its door, staying on this side.
      const cells = new Set<number>([door]);
      const q = [inside];
      cells.add(inside);
      for (let i = 0; i < q.length; i++) {
        const c = q[i]!;
        const cx = c % p.w;
        const cy = Math.floor(c / p.w);
        for (const [dx, dy] of DIRS) {
          const nn = (cy + dy) * p.w + (cx + dx);
          if (p.wall[nn] || cells.has(nn)) continue;
          const ny = Math.floor(nn / p.w);
          if (side === -1 && ny >= doorRow) continue;
          if (side === 1 && ny <= doorRow) continue;
          cells.add(nn);
          q.push(nn);
        }
      }
      const hall = hr * p.w + x;
      cells.add(hall);
      const goals = p.goals.filter((g) => cells.has(g));
      const boxes = p.boxes.filter((b) => cells.has(b));
      if (boxes.length === 0 || goals.length !== boxes.length) continue;
      rooms.push({ door, hall, cells, goals, boxes });
    }
  }
  if (rooms.length === 0) return null;
  // Every box must belong to exactly one room.
  const covered = rooms.reduce((a, r) => a + r.boxes.length, 0);
  if (covered !== p.boxes.length) return null;
  rooms.sort((a, b) => a.door - b.door);
  return rooms;
}

function solve(text: string, work: { left: number }): string {
  const p = parse(text);
  if (p.boxes.every((b) => p.goals.includes(b))) return '';
  const rooms = findRooms(p);
  if (rooms !== null) {
    const allCells = new Set<number>();
    for (let i = 0; i < p.w * p.h; i++) if (!p.wall[i]) allCells.add(i);
    let moves = '';
    let player = p.player;
    let boxes = p.boxes.slice();
    for (const room of rooms) {
      if (room.boxes.every((b) => room.goals.includes(b))) continue;
      const boxSet = new Set(boxes);
      const toHall = walkPath(p.w, allCells, boxSet, player, room.hall);
      if (toHall === null) return '';
      const solved = pushAStar(p.w, p.h, p.wall, room.cells, room.goals, room.boxes, room.hall, ROOM_BUDGET, work);
      if (solved === null) return '';
      moves += toHall + solved.moves;
      player = solved.endPlayer;
      // The room's boxes are now on its goals; refresh the global picture.
      const roomBoxSet = new Set(room.boxes);
      boxes = boxes.filter((b) => !roomBoxSet.has(b)).concat(room.goals.slice());
      boxes.sort((a, b) => a - b);
    }
    return moves;
  }
  // No detectable doors: answer nothing rather than risk a whole-level
  // search, whose state space (the product of the rooms) can exhaust the
  // memory and the wall and zero the whole run.
  return '';
}

const work = { left: RUN_BUDGET };
for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'), work);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
