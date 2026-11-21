import { describe, it, expect } from 'vitest';
import { ModalBackStack, type HistoryLike } from './useBackButtonClose';

// Fake history: records pushes, and lets the test decide when the `popstate`
// that a real browser fires asynchronously after back() actually arrives.
function fakeHistory(stack: () => ModalBackStack) {
  const pushes: unknown[] = [];
  const entries: unknown[] = [null]; // bottom = the app route the modal opened over
  const history: HistoryLike = {
    pushState: (state) => { pushes.push(state); entries.push(state); },
    back: () => { entries.pop(); stack().handlePopState(); },
    get state() { return entries[entries.length - 1]; },
  };
  return { history, pushes, entries };
}

describe('ModalBackStack', () => {
  it('back closes the top modal only, innermost first', () => {
    let s!: ModalBackStack;
    const { history } = fakeHistory(() => s);
    s = new ModalBackStack(history);

    const closed: number[] = [];
    s.open(1, () => closed.push(1));
    s.open(2, () => closed.push(2));

    s.handlePopState();
    expect(closed).toEqual([2]);
    expect(s.openIds).toEqual([1]);

    s.handlePopState();
    expect(closed).toEqual([2, 1]);
    expect(s.openIds).toEqual([]);
  });

  it('closing by other means (X/Escape) does not close the modal underneath', () => {
    let s!: ModalBackStack;
    const { history } = fakeHistory(() => s);
    s = new ModalBackStack(history);

    const closed: number[] = [];
    s.open(1, () => closed.push(1));
    s.open(2, () => closed.push(2));

    // #2 closed via its X button — the echoed popstate must be swallowed.
    s.closeByOther(2);
    expect(closed).toEqual([]);
    expect(s.openIds).toEqual([1]);

    // The still-open #1 keeps its entry: one back press closes it.
    s.handlePopState();
    expect(closed).toEqual([1]);
  });

  it('two simultaneous non-back closes swallow both echoes', () => {
    let s!: ModalBackStack;
    const pending: (() => void)[] = [];
    // Defer the echoes so both suppressions are in flight at once.
    const entries: unknown[] = [null];
    s = new ModalBackStack({
      pushState: (state) => { entries.push(state); },
      // Real back() applies asynchronously: the entry is still current when
      // the next closeByOther runs.
      back: () => pending.push(() => { entries.pop(); s.handlePopState(); }),
      get state() { return entries[entries.length - 1]; },
    });

    const closed: number[] = [];
    s.open(1, () => closed.push(1));
    s.open(2, () => closed.push(2));
    s.open(3, () => closed.push(3));

    s.closeByOther(3);
    s.closeByOther(2);
    pending.forEach((run) => run());

    expect(closed).toEqual([]);
    expect(s.openIds).toEqual([1]);
  });

  it('does not stack a second back() while one is still in flight', () => {
    // Reproduces the real bug: an inner modal (e.g. a student profile card)
    // closes via backdrop click, and the outer panel it sits on top of (e.g.
    // a day/slot sheet) closes in the same tick right after. Both used to
    // fire their own history.back(); since the second one didn't wait for
    // the first's popstate, the pair resolved as "go back 2" in a real
    // browser and could walk straight past every throwaway entry into a
    // real earlier route (observed: a live click-outside repro that landed
    // on a completely different page). At most one back() may be in flight.
    let s!: ModalBackStack;
    const backCalls: number[] = [];
    const entries: unknown[] = [null];
    s = new ModalBackStack({
      pushState: (state) => { entries.push(state); },
      // Deliberately never resolves synchronously — mirrors a real
      // history.back(), whose popstate echo always arrives later.
      back: () => { backCalls.push(entries.length); },
      get state() { return entries[entries.length - 1]; },
    });

    s.open(1, () => {});
    s.open(2, () => {});

    s.closeByOther(2);
    s.closeByOther(1);

    expect(backCalls.length).toBe(1);
    expect(s.openIds).toEqual([]);
  });

  it('leaves its entry buried when the app navigated on top of it', () => {
    let s!: ModalBackStack;
    const { history, entries } = fakeHistory(() => s);
    s = new ModalBackStack(history);

    const closed: number[] = [];
    s.open(1, () => closed.push(1));

    // A <Link> inside the modal: the router pushes a route entry, then the
    // modal closes. back() here would undo the navigation.
    entries.push({ idx: 1 });
    s.closeByOther(1);

    expect(entries[entries.length - 1]).toEqual({ idx: 1 });
    expect(s.openIds).toEqual([]);
    expect(closed).toEqual([]);
  });

  it('ignores popstate from real navigation when nothing is open', () => {
    let s!: ModalBackStack;
    const { history, pushes } = fakeHistory(() => s);
    s = new ModalBackStack(history);

    expect(() => s.handlePopState()).not.toThrow();
    expect(pushes).toEqual([]);
  });
});
