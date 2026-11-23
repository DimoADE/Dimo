import { ipcRenderer } from 'electron';

export const WEBVIEW_POINTER_DOWN_CHANNEL = 'dimo-browser:pointer-down';

if (typeof window !== 'undefined') {
  window.addEventListener(
    'pointerdown',
    (event) => {
      try {
        ipcRenderer.sendToHost(WEBVIEW_POINTER_DOWN_CHANNEL, {
          button: event.button,
          clientX: event.clientX,
          clientY: event.clientY,
        });
      } catch {
        // Best-effort notification to the embedding renderer.
      }
    },
    true
  );
}
