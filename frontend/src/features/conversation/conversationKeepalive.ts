/**
 * Registers on-screen conversations for the backend keepalive.
 *
 * The activity bump runs inside the agent runtime (30s, or sooner when the
 * idle timeout is shorter). This module only tells that loop which surfaces
 * are on screen. It does not schedule a timer, connect, resume, or surface a
 * status notice. Hiding the window leaves the registration in place.
 * Off-screen surfaces unregister.
 */

type Registration = {
  generation: number;
  setWatch: (watch: boolean) => Promise<unknown>;
};

type WatchQueue = {
  desired: boolean;
  lastSent: boolean | null;
  inFlight: boolean;
  setWatch: (watch: boolean) => Promise<unknown>;
};

const registrations = new Map<string, Registration>();
const watchQueues = new Map<string, WatchQueue>();
let generationClock = 0;
let pagehideHandler: (() => void) | null = null;

function enqueueWatch(
  conversationId: string,
  watch: boolean,
  setWatch: (watch: boolean) => Promise<unknown>
): void {
  let queue = watchQueues.get(conversationId);
  if (!queue) {
    queue = {
      desired: watch,
      lastSent: null,
      inFlight: false,
      setWatch,
    };
    watchQueues.set(conversationId, queue);
  } else {
    queue.desired = watch;
    queue.setWatch = setWatch;
  }
  if (queue.inFlight) return;
  void drainWatchQueue(conversationId, queue);
}

async function drainWatchQueue(
  conversationId: string,
  queue: WatchQueue
): Promise<void> {
  queue.inFlight = true;
  try {
    while (queue.lastSent !== queue.desired) {
      const target = queue.desired;
      queue.lastSent = target;
      try {
        await queue.setWatch(target);
      } catch {
        // Best-effort keepalive registration; ignore transport failures.
      }
      if (watchQueues.get(conversationId) !== queue) {
        return;
      }
    }
  } finally {
    queue.inFlight = false;
    if (
      watchQueues.get(conversationId) === queue &&
      !queue.desired &&
      !registrations.has(conversationId)
    ) {
      watchQueues.delete(conversationId);
    }
  }
}

function releaseAll(): void {
  const snapshot = [...registrations.entries()];
  registrations.clear();
  for (const [conversationId, registration] of snapshot) {
    enqueueWatch(conversationId, false, registration.setWatch);
  }
}

function bindPagehide(): void {
  if (pagehideHandler != null || typeof window === 'undefined') return;
  pagehideHandler = () => {
    releaseAll();
  };
  window.addEventListener('pagehide', pagehideHandler);
}

export function retainConversationKeepalive(
  conversationId: string,
  setWatch: (watch: boolean) => Promise<unknown>
): () => void {
  bindPagehide();
  generationClock += 1;
  const generation = generationClock;
  registrations.set(conversationId, { generation, setWatch });
  enqueueWatch(conversationId, true, setWatch);
  return () => {
    const current = registrations.get(conversationId);
    if (!current || current.generation !== generation) return;
    registrations.delete(conversationId);
    enqueueWatch(conversationId, false, setWatch);
  };
}

/** Test seam. Production callers release through the function above. */
export function resetConversationKeepaliveForTests(): void {
  registrations.clear();
  watchQueues.clear();
  generationClock = 0;
  if (pagehideHandler != null && typeof window !== 'undefined') {
    window.removeEventListener('pagehide', pagehideHandler);
  }
  pagehideHandler = null;
}
