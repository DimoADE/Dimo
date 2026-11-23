import type { GitLogEntry } from 'shared/types';

export const GRAPH_LANE_COLOR_COUNT = 6;

export interface GraphPassThrough {
  col: number;
  colorIndex: number;
}

export interface GraphEdge {
  fromCol: number;
  toCol: number;
  colorIndex: number;
}

export interface GitLogGraphRow {
  sha: string;
  nodeCol: number;
  colorIndex: number;
  hasIncomingTop: boolean;
  isMerge: boolean;
  isRoot: boolean;
  /** Active lanes passing straight from top to bottom without touching this node */
  passThroughs: GraphPassThrough[];
  /** Additional lanes converging from top into this commit node */
  incomingMerges: GraphEdge[];
  /** Outgoing connections from this commit node downward to parent lanes */
  outgoingEdges: GraphEdge[];
  /** Number of columns needed to render this row cleanly */
  laneCount: number;
}

export interface GitLogGraphLayout {
  rows: GitLogGraphRow[];
  bySha: Map<string, GitLogGraphRow>;
  maxLanes: number;
}

interface ActiveLane {
  sha: string;
  colorIndex: number;
}

/**
 * Computes a deterministic per-row commit graph layout from topologically
 * ordered commits (`git log --topo-order`). Each row produces self-contained
 * top-to-bottom SVG instructions so virtualized lists (Virtuoso) can render
 * individual rows without gaps or misalignment.
 */
export function computeGitLogGraphLayout(
  entries: ReadonlyArray<Pick<GitLogEntry, 'sha' | 'parents'>>
): GitLogGraphLayout {
  const lanes: Array<ActiveLane | null> = [];
  let nextColorIndex = 0;

  const allocateColor = () => {
    const color = nextColorIndex % GRAPH_LANE_COLOR_COUNT;
    nextColorIndex += 1;
    return color;
  };

  const allocateLane = (sha: string, colorIndex: number): number => {
    const emptyIdx = lanes.findIndex((lane) => lane === null);
    if (emptyIdx !== -1) {
      lanes[emptyIdx] = { sha, colorIndex };
      return emptyIdx;
    }
    lanes.push({ sha, colorIndex });
    return lanes.length - 1;
  };

  const trimTrailingNulls = () => {
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }
  };

  const rows: GitLogGraphRow[] = [];
  const bySha = new Map<string, GitLogGraphRow>();
  let maxLanes = 1;

  for (const entry of entries) {
    const matchingCols: number[] = [];
    for (let col = 0; col < lanes.length; col += 1) {
      if (lanes[col]?.sha === entry.sha) {
        matchingCols.push(col);
      }
    }

    const hasIncomingTop = matchingCols.length > 0;
    let nodeCol: number;
    let colorIndex: number;

    if (hasIncomingTop) {
      nodeCol = matchingCols[0];
      colorIndex = lanes[nodeCol]!.colorIndex;
    } else {
      colorIndex = allocateColor();
      nodeCol = allocateLane(entry.sha, colorIndex);
    }

    const matchingSet = new Set(matchingCols);
    const passThroughs: GraphPassThrough[] = [];
    for (let col = 0; col < lanes.length; col += 1) {
      const lane = lanes[col];
      if (lane && !matchingSet.has(col) && col !== nodeCol) {
        passThroughs.push({ col, colorIndex: lane.colorIndex });
      }
    }

    const incomingMerges: GraphEdge[] = [];
    for (let i = 1; i < matchingCols.length; i += 1) {
      const col = matchingCols[i];
      const lane = lanes[col];
      if (lane) {
        incomingMerges.push({
          fromCol: col,
          toCol: nodeCol,
          colorIndex: lane.colorIndex,
        });
      }
      lanes[col] = null;
    }

    const outgoingEdges: GraphEdge[] = [];
    const parents = entry.parents ?? [];

    if (parents.length === 0) {
      lanes[nodeCol] = null;
    } else {
      // First parent continues this branch's primary lane when not already tracked.
      const primaryParent = parents[0];
      const existingPrimaryCol = lanes.findIndex(
        (lane, idx) => idx !== nodeCol && lane?.sha === primaryParent
      );

      if (existingPrimaryCol !== -1) {
        outgoingEdges.push({
          fromCol: nodeCol,
          toCol: existingPrimaryCol,
          colorIndex,
        });
        lanes[nodeCol] = null;
      } else {
        lanes[nodeCol] = { sha: primaryParent, colorIndex };
        outgoingEdges.push({
          fromCol: nodeCol,
          toCol: nodeCol,
          colorIndex,
        });
      }

      // Secondary parents (merge commits) connect to an existing lane or spawn a new one.
      for (let pIdx = 1; pIdx < parents.length; pIdx += 1) {
        const parentSha = parents[pIdx];
        const existingCol = lanes.findIndex((lane) => lane?.sha === parentSha);
        if (existingCol !== -1) {
          outgoingEdges.push({
            fromCol: nodeCol,
            toCol: existingCol,
            colorIndex: lanes[existingCol]!.colorIndex,
          });
        } else {
          const parentColor = allocateColor();
          const newCol = allocateLane(parentSha, parentColor);
          outgoingEdges.push({
            fromCol: nodeCol,
            toCol: newCol,
            colorIndex: parentColor,
          });
        }
      }
    }

    const activeSpan = Math.max(
      nodeCol + 1,
      ...passThroughs.map((p) => p.col + 1),
      ...incomingMerges.map((e) => Math.max(e.fromCol, e.toCol) + 1),
      ...outgoingEdges.map((e) => Math.max(e.fromCol, e.toCol) + 1)
    );

    trimTrailingNulls();

    const row: GitLogGraphRow = {
      sha: entry.sha,
      nodeCol,
      colorIndex,
      hasIncomingTop,
      isMerge: parents.length > 1,
      isRoot: parents.length === 0,
      passThroughs,
      incomingMerges,
      outgoingEdges,
      laneCount: activeSpan,
    };
    rows.push(row);
    bySha.set(entry.sha, row);
    if (activeSpan > maxLanes) {
      maxLanes = activeSpan;
    }
  }

  return { rows, bySha, maxLanes };
}
