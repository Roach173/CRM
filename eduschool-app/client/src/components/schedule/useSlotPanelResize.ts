import { useCallback, useRef, useState } from 'react';

// Drag-to-resize for SlotPanel's right edge. Pure UI/mouse-event mechanics —
// no schedule data involved, so it's a safe standalone extraction.
export function useSlotPanelResize(initialWidth = 950) {
  const [panelWidth, setPanelWidth] = useState(initialWidth);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartX = useRef(0);
  const dragStartW = useRef(initialWidth);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartX.current = e.clientX;
    dragStartW.current = panelWidth;
    setIsDragging(true);

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - dragStartX.current;
      const next = Math.min(Math.max(dragStartW.current + delta * 2, 450), window.innerWidth * 0.97);
      setPanelWidth(next);
    };
    const onUp = () => {
      setIsDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [panelWidth]);

  return { panelWidth, isDragging, onResizeStart };
}
