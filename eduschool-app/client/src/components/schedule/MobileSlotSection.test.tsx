// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import MobileSlotSection from './MobileSlotSection';

// The band replaced the old 56px time gutter, which also carried three things
// besides the time: the slot's tap-to-book target, and the «вне сетки» /
// «история» slot-state labels. Losing any of them silently would be a
// regression you'd only notice in production, so pin them here.
describe('MobileSlotSection', () => {
  it('renders the time range and a pluralised lesson count', () => {
    render(<MobileSlotSection start="08:20" end="09:40" count={8} state="normal">x</MobileSlotSection>);
    expect(screen.getByText('08:20 – 09:40')).toBeTruthy();
    expect(screen.getByText('· 8 уроков')).toBeTruthy();
  });

  it('hides the count for an empty slot', () => {
    render(<MobileSlotSection start="08:20" end="09:40" count={0} state="normal">x</MobileSlotSection>);
    expect(screen.queryByText(/уроков|урока|урок/)).toBeNull();
  });

  it('surfaces the slot state as a chip', () => {
    const { rerender } = render(
      <MobileSlotSection start="08:20" end="09:40" count={1} state="conflict">x</MobileSlotSection>,
    );
    expect(screen.getByText('вне сетки')).toBeTruthy();
    rerender(<MobileSlotSection start="08:20" end="09:40" count={1} state="historical">x</MobileSlotSection>);
    expect(screen.getByText('история')).toBeTruthy();
  });

  it('offers "+" only when the slot is bookable, and fires once per tap', () => {
    const onAdd = vi.fn();
    const { rerender } = render(
      <MobileSlotSection start="08:20" end="09:40" count={0} state="normal">x</MobileSlotSection>,
    );
    expect(screen.queryByLabelText('Добавить урок')).toBeNull();

    rerender(
      <MobileSlotSection start="08:20" end="09:40" count={0} state="normal" onAdd={onAdd}>x</MobileSlotSection>,
    );
    // stopPropagation on the button keeps the band's own handler from double-firing.
    screen.getByLabelText('Добавить урок').click();
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});
