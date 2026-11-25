import { describe, expect, it } from 'vitest';
import {
  findFallbackWorkspaceFilePath,
  isAbsoluteFilePath,
  resolveFilePathFromRoot,
} from './filePaths';

describe('filePaths', () => {
  it('recognizes Windows drive, POSIX, and UNC absolute paths', () => {
    expect(isAbsoluteFilePath('E:\\0A\\AI助理\\note.md')).toBe(true);
    expect(isAbsoluteFilePath('E:/0A/AI助理/note.md')).toBe(true);
    expect(isAbsoluteFilePath('/workspace/note.md')).toBe(true);
    expect(isAbsoluteFilePath('\\\\server\\share\\note.md')).toBe(true);
    expect(isAbsoluteFilePath('生财航海/AI助理/note.md')).toBe(false);
  });

  it('normalizes dot and parent segments when resolving relative paths from root', () => {
    expect(
      resolveFilePathFromRoot('../生财航海/高手领航2-小志同学.md', 'E:\\0A\\AI助理')
    ).toBe('E:\\0A\\生财航海\\高手领航2-小志同学.md');

    expect(
      resolveFilePathFromRoot('./docs/../README.md', 'E:/0A/AI助理')
    ).toBe('E:/0A/AI助理/README.md');

    expect(
      resolveFilePathFromRoot('../shared/types.ts', '/workspace/project')
    ).toBe('/workspace/shared/types.ts');

    expect(
      resolveFilePathFromRoot('E:\\0A\\AI助理\\..\\notes\\a.md', 'E:/0A/AI助理')
    ).toBe('E:\\0A\\notes\\a.md');
  });

  it('resolves an unambiguous suffix fallback when the joined workspace path is missing', () => {
    const matched = findFallbackWorkspaceFilePath({
      failedPath: 'E:/0A/AI助理/生财航海/AI助理/高手领航2-小志同学.md',
      displayPath: '生财航海/AI助理/高手领航2-小志同学.md',
      rootPath: 'E:/0A/AI助理',
      searchResults: [
        {
          path: '知识库/生财航海/AI助理/高手领航2-小志同学.md',
          is_file: true,
        },
        {
          path: '归档/其他/高手领航2-小志同学.md',
          is_file: true,
        },
      ],
    });

    expect(matched).toBe(
      'E:/0A/AI助理/知识库/生财航海/AI助理/高手领航2-小志同学.md'
    );
  });

  it('falls back to a unique basename match when no suffix matches', () => {
    const matched = findFallbackWorkspaceFilePath({
      failedPath: 'E:/0A/AI助理/生财航海/AI助理/高手领航2-小志同学.md',
      displayPath: '生财航海/AI助理/高手领航2-小志同学.md',
      rootPath: 'E:/0A/AI助理',
      searchResults: [
        {
          path: '笔记/高手领航2-小志同学.md',
          is_file: true,
        },
        {
          path: '笔记/高手领航2-小志同学.md-dir',
          is_file: false,
        },
      ],
    });

    expect(matched).toBe('E:/0A/AI助理/笔记/高手领航2-小志同学.md');
  });

  it('returns null when multiple files match the same basename ambiguously', () => {
    const matched = findFallbackWorkspaceFilePath({
      failedPath: 'E:/0A/AI助理/生财航海/高手领航2-小志同学.md',
      displayPath: '生财航海/高手领航2-小志同学.md',
      rootPath: 'E:/0A/AI助理',
      searchResults: [
        { path: 'a/高手领航2-小志同学.md', is_file: true },
        { path: 'b/高手领航2-小志同学.md', is_file: true },
      ],
    });

    expect(matched).toBeNull();
  });
});
