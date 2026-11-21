import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { getDesktopShell } from '@/lib/desktopShell';
import { cn } from '@/lib/utils';
import { isMac } from '@/utils/platform';

interface AppTitleBarProps {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  className?: string;
}

function isNoWindowDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'button, a, input, textarea, select, [role="button"], [role="menuitem"], [role="combobox"]'
    )
  );
}

function toggleDesktopWindowMaximize(): void {
  void getDesktopShell()
    .window.toggleMaximize()
    .catch(() => undefined);
}

export function AppTitleBar({
  left,
  center,
  right,
  className,
}: AppTitleBarProps) {
  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isNoWindowDragTarget(event.target)) return;
    if (isMac()) return;
    toggleDesktopWindowMaximize();
  };

  return (
    <div
      data-window-drag-region
      className={cn(
        'settings-titlebar window-chrome relative h-9 shrink-0 select-none text-foreground',
        className
      )}
      onDoubleClick={onDoubleClick}
    >
      <div data-window-drag-region className="absolute inset-0" />

      <div
        data-window-drag-region
        className="relative z-10 flex h-full items-center px-3"
      >
        <div className="min-w-0 flex-1">{left}</div>
        {right ? <div className="ml-auto shrink-0">{right}</div> : null}
      </div>

      {center ? (
        <div
          data-window-drag-region
          className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2"
        >
          <div>{center}</div>
        </div>
      ) : null}
    </div>
  );
}
