import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionComposerImageAttachment } from './session-composer-input/SessionComposerImageAttachment';

const mocks = vi.hoisted(() => ({
  metadata: {
    exists: true,
    file_name: 'pasted.png',
    path: 'C:/tmp/pasted.png',
    size_bytes: 1024,
    format: 'png',
    proxy_url: '/local-file/pasted.png',
  } as {
    exists: boolean;
    file_name?: string;
    path?: string;
    size_bytes?: number;
    format?: string;
    proxy_url?: string;
  } | null,
  isLoading: false,
  hostFileSrc: vi.fn<(path: string) => Promise<string>>(),
  releaseHostFileSrc: vi.fn<(path: string) => void>(),
  openImagePreview: vi.fn(),
}));

vi.mock('@/hooks/useImageMetadata', () => ({
  useImageMetadata: () => ({
    data: mocks.metadata,
    isLoading: mocks.isLoading,
  }),
}));

vi.mock('@/hooks/useOpenImagePreview', () => ({
  useOpenImagePreview: () => mocks.openImagePreview,
}));

vi.mock('@/lib/hostAsset', () => ({
  hostFileSrc: (path: string) => mocks.hostFileSrc(path),
  releaseHostFileSrc: (path: string) => mocks.releaseHostFileSrc(path),
  isBrowserDisplayUrl: (value?: string | null) =>
    Boolean(
      value &&
        (/^(blob:|data:|https?:|asset:)/i.test(value) ||
          value.startsWith('/api/'))
    ),
}));

describe('SessionComposerImageAttachment', () => {
  beforeEach(() => {
    mocks.metadata = {
      exists: true,
      file_name: 'pasted.png',
      path: 'C:/tmp/pasted.png',
      size_bytes: 1024,
      format: 'png',
      proxy_url: '/local-file/pasted.png',
    };
    mocks.isLoading = false;
    mocks.hostFileSrc.mockReset();
    mocks.releaseHostFileSrc.mockReset();
    mocks.openImagePreview.mockReset();
  });

  it('loads hostFileSrc fallback once without self-revoking the resolved blob URL', async () => {
    mocks.hostFileSrc.mockResolvedValue('blob:resolved-host-image');

    const { unmount } = render(
      <SessionComposerImageAttachment
        image={{
          id: 'img-1',
          name: 'pasted.png',
          path: '.vibe-images/pasted.png',
        }}
        disabled={false}
        onRemoveImage={vi.fn()}
      />
    );

    const img = await screen.findByRole('img', { name: 'pasted.png' });
    expect(img).toHaveAttribute('src', 'blob:resolved-host-image');
    expect(mocks.hostFileSrc).toHaveBeenCalledTimes(1);
    expect(mocks.hostFileSrc).toHaveBeenCalledWith('C:/tmp/pasted.png');
    expect(mocks.releaseHostFileSrc).not.toHaveBeenCalled();

    const previewButton = screen.getByRole('button', {
      name: 'Preview pasted.png',
    });
    expect(previewButton).not.toBeDisabled();

    unmount();
    expect(mocks.releaseHostFileSrc).toHaveBeenCalledTimes(1);
    expect(mocks.releaseHostFileSrc).toHaveBeenCalledWith('C:/tmp/pasted.png');
  });

  it('renders a loading indicator instead of a broken-image placeholder while hostFileSrc is pending', async () => {
    let resolveHostSrc!: (url: string) => void;
    mocks.hostFileSrc.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveHostSrc = resolve;
      })
    );

    const { container } = render(
      <SessionComposerImageAttachment
        image={{
          id: 'img-2',
          name: 'pasted.png',
          path: '.vibe-images/pasted.png',
        }}
        disabled={false}
        onRemoveImage={vi.fn()}
      />
    );

    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'pasted.png' })).toBeNull();

    resolveHostSrc('blob:loaded-later');

    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'pasted.png' })).toHaveAttribute(
        'src',
        'blob:loaded-later'
      );
    });
    expect(mocks.releaseHostFileSrc).not.toHaveBeenCalled();
  });
});
