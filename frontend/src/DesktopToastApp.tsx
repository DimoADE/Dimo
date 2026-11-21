import { ThemeProvider } from '@/components/ThemeProvider';
import { DesktopToastWindow } from '@/components/desktop-toast/DesktopToastWindow';
import { LegacyDesignScope } from '@/components/legacy-design/LegacyDesignScope';
import { readCachedResolvedTheme } from '@/lib/resolvedTheme';
import { ThemeMode } from 'shared/types';

function initialDesktopToastTheme(): ThemeMode {
  const cached = readCachedResolvedTheme();
  if (cached === 'dark') return ThemeMode.DARK;
  if (cached === 'light') return ThemeMode.LIGHT;
  return ThemeMode.SYSTEM;
}

export function DesktopToastApp() {
  return (
    <ThemeProvider initialTheme={initialDesktopToastTheme()}>
      <LegacyDesignScope>
        <DesktopToastWindow />
      </LegacyDesignScope>
    </ThemeProvider>
  );
}
