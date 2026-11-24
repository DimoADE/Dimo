export const fileTreeKeys = {
  all: ['fileTree'] as const,
  byRoot: (rootPath: string | null, depth?: number) =>
    ['fileTree', rootPath, depth] as const,
};
