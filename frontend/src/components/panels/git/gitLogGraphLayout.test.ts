import { describe, expect, it } from 'vitest';
import { computeGitLogGraphLayout } from './gitLogGraphLayout';

describe('computeGitLogGraphLayout', () => {
  it('lays out a simple linear history on lane 0', () => {
    const layout = computeGitLogGraphLayout([
      { sha: 'c3', parents: ['c2'] },
      { sha: 'c2', parents: ['c1'] },
      { sha: 'c1', parents: [] },
    ]);

    expect(layout.maxLanes).toBe(1);
    expect(layout.rows.map((r) => r.nodeCol)).toEqual([0, 0, 0]);
    expect(layout.rows[0].hasIncomingTop).toBe(false);
    expect(layout.rows[1].hasIncomingTop).toBe(true);
    expect(layout.rows[2].isRoot).toBe(true);
    expect(layout.rows[2].outgoingEdges).toEqual([]);
  });

  it('lays out a branch and merge cleanly across two lanes', () => {
    // Topological order:
    // m (merge c2 + f1) -> f1 (parent c1) -> c2 (parent c1) -> c1 (root)
    const layout = computeGitLogGraphLayout([
      { sha: 'm', parents: ['c2', 'f1'] },
      { sha: 'f1', parents: ['c1'] },
      { sha: 'c2', parents: ['c1'] },
      { sha: 'c1', parents: [] },
    ]);

    expect(layout.maxLanes).toBe(2);

    // Merge commit on lane 0, spawns lane 1 for f1
    const mRow = layout.bySha.get('m')!;
    expect(mRow.isMerge).toBe(true);
    expect(mRow.nodeCol).toBe(0);
    expect(mRow.outgoingEdges).toHaveLength(2);
    expect(mRow.outgoingEdges[0]).toMatchObject({ fromCol: 0, toCol: 0 });
    expect(mRow.outgoingEdges[1]).toMatchObject({ fromCol: 0, toCol: 1 });

    // f1 sits on lane 1 while c2 passes through lane 0
    const f1Row = layout.bySha.get('f1')!;
    expect(f1Row.nodeCol).toBe(1);
    expect(f1Row.passThroughs).toHaveLength(1);
    expect(f1Row.passThroughs[0].col).toBe(0);

    // c2 sits on lane 0, its parent c1 is already on lane 1 -> merges into lane 1
    const c2Row = layout.bySha.get('c2')!;
    expect(c2Row.nodeCol).toBe(0);
    expect(c2Row.outgoingEdges).toEqual([
      { fromCol: 0, toCol: 1, colorIndex: c2Row.colorIndex },
    ]);

    // c1 sits on lane 1 as root
    const c1Row = layout.bySha.get('c1')!;
    expect(c1Row.nodeCol).toBe(1);
    expect(c1Row.isRoot).toBe(true);
  });

  it('handles parallel branch tips converging at a shared ancestor', () => {
    // Two independent branch tips (main tip + feature tip) sharing base commit
    const layout = computeGitLogGraphLayout([
      { sha: 'main-tip', parents: ['base'] },
      { sha: 'feat-tip', parents: ['base'] },
      { sha: 'base', parents: [] },
    ]);

    expect(layout.maxLanes).toBe(2);
    expect(layout.bySha.get('main-tip')!.nodeCol).toBe(0);
    expect(layout.bySha.get('main-tip')!.hasIncomingTop).toBe(false);

    const featRow = layout.bySha.get('feat-tip')!;
    expect(featRow.nodeCol).toBe(1);
    expect(featRow.hasIncomingTop).toBe(false);
    // feat-tip's parent `base` is already tracked in lane 0 -> curves directly to lane 0
    expect(featRow.outgoingEdges).toEqual([
      { fromCol: 1, toCol: 0, colorIndex: featRow.colorIndex },
    ]);

    const baseRow = layout.bySha.get('base')!;
    expect(baseRow.nodeCol).toBe(0);
    expect(baseRow.hasIncomingTop).toBe(true);
    expect(baseRow.isRoot).toBe(true);
  });

  it('handles octopus merges and disconnected roots', () => {
    const layout = computeGitLogGraphLayout([
      { sha: 'octo', parents: ['p1', 'p2', 'p3'] },
      { sha: 'orphan', parents: [] },
      { sha: 'p1', parents: [] },
      { sha: 'p2', parents: [] },
      { sha: 'p3', parents: [] },
    ]);

    expect(layout.bySha.get('octo')!.isMerge).toBe(true);
    expect(layout.bySha.get('octo')!.outgoingEdges).toHaveLength(3);
    expect(layout.bySha.get('orphan')!.hasIncomingTop).toBe(false);
    expect(layout.bySha.get('orphan')!.isRoot).toBe(true);
    expect(layout.maxLanes).toBeGreaterThanOrEqual(4);
  });
});
