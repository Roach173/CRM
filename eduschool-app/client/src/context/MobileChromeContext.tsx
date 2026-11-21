import { createContext, useContext, useState, useMemo, type ReactNode } from 'react';

/**
 * Shares "hide the mobile chrome" intent between a page and the app shell.
 *
 * The schedule week view collapses its own top bar on scroll, but the fixed
 * bottom nav lives in Sidebar — a sibling of the page outlet. This context lets
 * the page drive the bottom nav's visibility without prop-drilling through the
 * layout. Defaults to visible; pages must reset it to false on unmount so the
 * nav never stays hidden after navigation.
 */
interface MobileChromeValue {
  navHidden: boolean;
  setNavHidden: (hidden: boolean) => void;
}

const MobileChromeContext = createContext<MobileChromeValue>({
  navHidden: false,
  setNavHidden: () => {},
});

export function MobileChromeProvider({ children }: { children: ReactNode }) {
  const [navHidden, setNavHidden] = useState(false);
  const value = useMemo(() => ({ navHidden, setNavHidden }), [navHidden]);
  return <MobileChromeContext.Provider value={value}>{children}</MobileChromeContext.Provider>;
}

export function useMobileChrome() {
  return useContext(MobileChromeContext);
}
