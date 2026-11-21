import { AuthProvider } from './context/AuthContext';
import { AppRouter } from './router';
import { Toaster, ToastBar, toast as hotToast } from 'react-hot-toast';
import { useAuth } from './hooks/useAuth';
import { useIsMobile } from './hooks/useIsMobile';
import { PaywallScreen } from './components/ui/PaywallScreen';
import { AccessRestrictedScreen } from './components/ui/AccessRestrictedScreen';
import { useState, useRef } from 'react';
import type { Toast } from 'react-hot-toast';

function isBypassedPath(pathname: string): boolean {
  const path = pathname.replace(/\/$/, '') || '/';
  
  if (
    path === '/' ||
    path === '/terms' ||
    path === '/privacy' ||
    path === '/register' ||
    path === '/invite' ||
    path === '/verify-email' ||
    path === '/forgot-password' ||
    path === '/reset-password'
  ) {
    return true;
  }
  
  if (path === '/login' || /^\/[^/]+\/login$/.test(path)) {
    return true;
  }
  
  if (/^\/[^/]+\/onboarding$/.test(path)) {
    return true;
  }
  
  if (path.startsWith('/superadmin')) {
    return true;
  }
  
  if (path.startsWith('/auth/2fa')) {
    return true;
  }
  
  return false;
}

function AppContent() {
  const { user, subscriptionInfo, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="w-8 h-8 rounded-full border-4 border-[#008060] border-t-transparent animate-spin" />
      </div>
    );
  }

  const isBlocked = !!subscriptionInfo?.isBlocked;
  const isBypassed = isBypassedPath(window.location.pathname);

  if (isBlocked && !isBypassed && user && user.role !== 'SUPERADMIN') {
    if (user.role === 'OWNER') {
      return <PaywallScreen />;
    } else {
      return <AccessRestrictedScreen />;
    }
  }

  return <AppRouter />;
}

// Swipeable toast wrapper component — handles per-toast vertical swipe-to-dismiss on mobile.
// Swipe DOWN to dismiss (natural gesture for bottom-anchored toast, mimics flicking it off screen).
// Drag feedback: toast follows finger while swiping. Snaps back if threshold not met.
function SwipeableToastBar({ t, isMobile }: { t: Toast; isMobile: boolean }) {
  const [dragOffset, setDragOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const touchStartYRef = useRef<number | null>(null);

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isMobile) return;
    touchStartYRef.current = e.touches[0].clientY;
    setIsDragging(true);
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!isMobile || touchStartYRef.current === null) return;
    const currentY = e.touches[0].clientY;
    const offset = currentY - touchStartYRef.current;
    // Only allow downward swipe (positive offset)
    if (offset > 0) {
      setDragOffset(offset);
    }
  };

  const handleTouchEnd = () => {
    if (!isMobile) {
      setDragOffset(0);
      setIsDragging(false);
      touchStartYRef.current = null;
      return;
    }

    const SWIPE_THRESHOLD = 60; // pixels downward to dismiss

    if (dragOffset > SWIPE_THRESHOLD) {
      hotToast.dismiss(t.id);
    } else {
      setDragOffset(0);
    }
    setIsDragging(false);
    touchStartYRef.current = null;
  };

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      style={{
        transform: dragOffset > 0 ? `translateY(${dragOffset}px)` : undefined,
        transition: isDragging ? 'none' : 'transform 200ms ease-out',
        touchAction: 'none',
      }}
    >
      <ToastBar toast={t} />
    </div>
  );
}

// Wrapper component to handle responsive toast positioning
function ToasterWrapper() {
  const isMobile = useIsMobile();

  // On mobile: bottom-center with offset above nav bar (~80px)
  // On desktop: top-right as before
  const position = isMobile ? ('bottom-center' as const) : ('top-right' as const);
  const containerStyle = isMobile
    ? { bottom: 80 }
    : { top: 72 };

  return (
    <Toaster
      position={position}
      containerStyle={containerStyle}
      gutter={8}
      toastOptions={{
        duration: 4000,
        style: { fontFamily: 'inherit', fontSize: '14px', maxWidth: '380px' },
        success: { iconTheme: { primary: '#008060', secondary: 'white' } },
        error: { iconTheme: { primary: '#D72C0D', secondary: 'white' } },
      }}
    >
      {(t) => (
        <SwipeableToastBar t={t} isMobile={isMobile} />
      )}
    </Toaster>
  );
}

function App() {
  return (
    <AuthProvider>
      <ToasterWrapper />
      <AppContent />
    </AuthProvider>
  );
}

export default App;
