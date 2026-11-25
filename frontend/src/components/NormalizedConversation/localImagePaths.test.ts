import { describe, expect, it } from 'vitest';
import { resolveLocalMarkdownImagePath } from './localImagePaths';

describe('resolveLocalMarkdownImagePath', () => {
  it('collapses parent directory segments relative to workspacePath', () => {
    expect(
      resolveLocalMarkdownImagePath('../assets/diagram.png', 'E:\\0A\\notes\\sub')
    ).toBe('E:\\0A\\notes\\assets\\diagram.png');
    expect(
      resolveLocalMarkdownImagePath('../../shared/logo.svg', '/tmp/a/b/c')
    ).toBe('/tmp/a/shared/logo.svg');
  });

  it('normalizes Windows and POSIX file:// URLs with percent-encoding', () => {
    expect(
      resolveLocalMarkdownImagePath(
        'file:///E:/Outside%20Notes/%E5%9B%BE%E7%89%87.png'
      )
    ).toBe('E:/Outside Notes/图片.png');
    expect(
      resolveLocalMarkdownImagePath(
        'file://localhost/C:/Users/Alice/sub/../pic.webp'
      )
    ).toBe('C:/Users/Alice/pic.webp');
    expect(
      resolveLocalMarkdownImagePath('file:///Users/alice/docs/../pic.png')
    ).toBe('/Users/alice/pic.png');
  });

  it('decodes percent-encoded relative paths and strips query/hash suffixes', () => {
    expect(
      resolveLocalMarkdownImagePath(
        './images/%E6%88%AA%E5%9B%BE%201.png?v=2#center',
        '/tmp/outside'
      )
    ).toBe('/tmp/outside/images/截图 1.png');
    expect(
      resolveLocalMarkdownImagePath('./100%_done.png', '/tmp/outside')
    ).toBe('/tmp/outside/100%_done.png');
  });

  it('resolves arbitrary non-project absolute paths and ignores remote URLs', () => {
    expect(
      resolveLocalMarkdownImagePath('D:/External/sub/../cover.jpg')
    ).toBe('D:/External/cover.jpg');
    expect(
      resolveLocalMarkdownImagePath('https://example.com/a.png', '/tmp/outside')
    ).toBeNull();
    expect(
      resolveLocalMarkdownImagePath('data:image/png;base64,AAAA', '/tmp/outside')
    ).toBeNull();
    expect(
      resolveLocalMarkdownImagePath('#section', '/tmp/outside')
    ).toBeNull();
  });
});
