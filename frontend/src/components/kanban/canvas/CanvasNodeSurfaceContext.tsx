import { createContext, useContext } from 'react';

export interface CanvasNodeSurfaceInfo {
  instanceId: string;
  zIndex: number;
}

export const CanvasNodeSurfaceContext =
  createContext<CanvasNodeSurfaceInfo | null>(null);

export function useCanvasNodeSurfaceInfo(): CanvasNodeSurfaceInfo | null {
  return useContext(CanvasNodeSurfaceContext);
}
