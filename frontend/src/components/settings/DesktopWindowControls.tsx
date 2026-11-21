import { useTauriClient } from '@/lib/desktopShell';
import { isMac } from '@/utils/platform';
import { WindowControls } from './WindowControls';

export function DesktopWindowControls() {
  const isTauri = useTauriClient();
  if (!isTauri || isMac()) {
    return null;
  }

  return (
    <div className="desktop-window-controls pointer-events-none fixed right-0 top-0 z-[20000] h-9 w-max">
      <div className="pointer-events-auto" data-no-drag>
        <WindowControls />
      </div>
    </div>
  );
}
