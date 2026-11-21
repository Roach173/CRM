import { useEffect, useRef } from 'react';

/**
 * Minimal shape of the History API this module depends on. Injecting it
 * (instead of touching `window.history` directly inside the class) keeps
 * `ModalBackStack` a pure, DOM-free unit that can be driven by a fake in a
 * plain Node script — real browser history/popstate timing cannot be
 * exercised deterministically in a test, but the bookkeeping rules that
 * govern it can be.
 */
export interface HistoryLike {
  pushState: (state: unknown, title: string) => void;
  back: () => void;
  /** State of the current history entry, read live. */
  readonly state: unknown;
}

/**
 * Is the current history entry one of our throwaway modal entries (any of
 * them, not necessarily a specific id)? `history.back()` is asynchronous, so
 * during a burst of closes `history.state` still names the entry a previous
 * back() has not consumed yet — and since every modal entry is a throwaway
 * pointing at the same URL, "some modal entry is on top" is the only thing
 * worth checking.
 */
function isModalEntry(state: unknown): boolean {
  return typeof (state as { __modalBackId?: unknown } | null)?.__modalBackId === 'number';
}

interface StackEntry {
  id: number;
  close: () => void;
}

/**
 * Tracks "one throwaway history entry per currently-open modal" as a LIFO
 * stack, so that:
 *
 *  - `open(id)` pushes exactly one entry per id. Calling it again for an id
 *    already on the stack is a no-op. This does NOT, by itself, cover React
 *    19 StrictMode's dev-only effect→cleanup→effect dance — that cleanup
 *    calls `closeByOther(id)` first, which splices the id back off, so the
 *    re-run effect sees no matching id and legitimately pushes again. The
 *    result is still exactly one tracked entry (see `ignorePops` below for
 *    why the extra push/back pair is harmless), just not via this guard.
 *  - `handlePopState()` — called from a real `popstate` (the user pressed
 *    back) — pops the TOP id only and invokes its close callback, so a
 *    nested modal above another open modal closes first, in order. If
 *    nothing is tracked, this popstate belongs to real app navigation and is
 *    ignored here.
 *  - `closeByOther(id)` — called when a modal closes by any means OTHER than
 *    back (X button, Escape, backdrop click, auto-close-after-save) —
 *    removes the id and consumes its now-stale history entry via
 *    `history.back()`, while incrementing `ignorePops` so the `popstate`
 *    that `back()` itself triggers is swallowed instead of re-invoking a
 *    close callback (which already ran, synchronously, via the direct close
 *    path) or, worse, popping and closing some OTHER, still-open modal.
 *
 *    `ignorePops` is a counter, not a boolean: `history.back()` is
 *    asynchronous, so if two modals close by non-back means back-to-back
 *    (e.g. a parent unmounts two stacked modals at once), two suppressions
 *    must be pending simultaneously. A boolean would let the second
 *    `closeByOther` silently clobber the first's "expect one echo" flag, so
 *    when only one of the two echoes actually arrives suppressed, the other
 *    is treated as a genuine user back-press and pops+closes whatever modal
 *    is now on top — one that was never asked to close.
 *
 * This class has no knowledge of React; `useBackButtonClose` below is the
 * only thing that touches `window` / component lifecycle.
 */
export class ModalBackStack {
  private stack: StackEntry[] = [];
  private ignorePops = 0;
  // Is a history.back() we issued still waiting for its echo? back() is
  // asynchronous and — per observed browser behavior — a second back() fired
  // before the first's popstate arrives does NOT reliably resolve against
  // "one step from wherever the first one lands" the way you'd hope; the two
  // can compound and walk more than one real entry back. Two overlays that
  // close within the same tick (e.g. an inner modal's backdrop-click close
  // triggering the outer panel's close right after) used to each fire their
  // own back(), and the pair could walk past every throwaway entry into a
  // real earlier route — even forcing a full reload if that entry isn't
  // bfcache-eligible. So: at most one back() in flight at a time.
  private backPending = false;

  constructor(private history: HistoryLike) {}

  open(id: number, close: () => void): void {
    if (this.stack.some((entry) => entry.id === id)) return;
    this.stack.push({ id, close });
    this.history.pushState({ __modalBackId: id }, '');
  }

  handlePopState(): void {
    if (this.ignorePops > 0) {
      this.ignorePops--;
      this.backPending = false;
      return;
    }
    const top = this.stack.pop();
    top?.close();
  }

  closeByOther(id: number): void {
    const idx = this.stack.findIndex((entry) => entry.id === id);
    if (idx === -1) return; // already consumed by handlePopState, or never pushed
    this.stack.splice(idx, 1);
    // A back() is already in flight — piling another on top is what causes
    // the overshoot described above. Leave this entry's real history slot
    // buried (same as the "app navigated on top of us" case below): harmless,
    // and it'll get swept up by the next real back-button press.
    if (this.backPending) return;
    // The app may have navigated on top of our entry — a <Link> inside the
    // modal pushes a route entry, then closes the modal. back() would then
    // undo that navigation instead of consuming our throwaway entry, so the
    // user lands right back where they tapped from. Leave the (now buried,
    // same-URL) entry alone instead.
    if (!isModalEntry(this.history.state)) return;
    this.ignorePops++;
    this.backPending = true;
    this.history.back();
  }

  /** Test/debug only — current stack order, bottom to top. */
  get openIds(): number[] {
    return this.stack.map((entry) => entry.id);
  }
}

// ─── Browser wiring ─────────────────────────────────────────────────────────
// Lazily constructed so this module stays import-safe outside a browser
// (e.g. the self-check script runs it under plain Node via a fake history).
// A single shared stack + a single shared `popstate` listener means every
// mounted Modal/AlertModal instance coordinates through one source of truth
// instead of racing each other with their own listeners.

let sharedStack: ModalBackStack | null = null;
let idCounter = 0;

function getSharedStack(): ModalBackStack {
  if (!sharedStack) {
    sharedStack = new ModalBackStack({
      pushState: (state, title) => window.history.pushState(state, title),
      back: () => window.history.back(),
      get state() { return window.history.state; },
    });
    window.addEventListener('popstate', () => sharedStack!.handlePopState());
  }
  return sharedStack;
}

/**
 * While `isOpen` is true, pushes a throwaway history entry so pressing
 * back (Android back button/gesture, desktop mouse-back, Alt+Left, …)
 * closes the modal via `onClose` instead of navigating the SPA route out
 * from under it. Any other close path is picked up by watching `isOpen`
 * flip back to false and cleans the entry up so the user is never left
 * needing to press back twice.
 */
export function useBackButtonClose(isOpen: boolean, onClose: () => void): void {
  const idRef = useRef(0);
  if (idRef.current === 0) idRef.current = ++idCounter;
  const id = idRef.current;

  // Always-fresh callback without re-running the effect below on every
  // render (onClose is typically a new closure each render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const pushedRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (isOpen && !pushedRef.current) {
      getSharedStack().open(id, () => onCloseRef.current());
      pushedRef.current = true;
    }

    return () => {
      // Runs on: close-by-other-means (isOpen -> false), unmount while open,
      // and React 19 StrictMode's synthetic extra effect pass.
      if (pushedRef.current) {
        getSharedStack().closeByOther(id);
        pushedRef.current = false;
      }
    };
  }, [isOpen, id]);
}
