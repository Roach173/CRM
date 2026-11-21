import { createContext, useState, useEffect, ReactNode } from 'react';
import axios from 'axios';
import api, { setAccessToken, refreshAccessToken } from '../lib/api';
import { connectSocket, disconnectSocket } from '../lib/socket';
import { User, School, SubscriptionStatusInfo, SubscriptionAccessStatus } from '../types';

interface AuthContextType {
  user: User | null;
  school: School | null;
  isLoading: boolean;
  isPaywalled: boolean;
  subscriptionInfo: SubscriptionStatusInfo | null;
  login: (token: string, userData: User, schoolData: School) => void;
  logout: () => void;
  refreshSubscriptionStatus: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

const DAY_MS = 24 * 60 * 60 * 1000;

function computeLocalFallback(school: School | null): SubscriptionStatusInfo | null {
  if (!school) return null;
  const sub = school.subscription;
  // ponytail: subscription gating is disabled server-side (no real payment flow),
  // so the local fallback always reports ACTIVE — never flash a paywall/read-only
  // banner while the /subscription/status request is in flight or if it fails.
  const status = 'ACTIVE' as SubscriptionAccessStatus;
  const plan = (sub?.plan || 'TRIAL') as 'TRIAL' | 'STARTER' | 'OPTIMA' | 'NETWORK';

  const getDaysLeft = (dateStr: string | null | undefined): number => {
    if (!dateStr) return 0;
    const target = new Date(dateStr);
    const now = new Date();
    return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / DAY_MS));
  };

  const trialDaysLeft = status === 'TRIALING' ? getDaysLeft(sub?.trialEndsAt) : 0;
  const graceDaysLeft = status === 'GRACE_PERIOD' ? getDaysLeft(sub?.graceEndsAt) : 0;
  const paidDaysLeft = status === 'ACTIVE' ? getDaysLeft(sub?.paidUntil) : 0;

  return {
    plan,
    status,
    isTrial: plan === 'TRIAL' || status === 'TRIALING',
    isActive: status === 'ACTIVE',
    isGracePeriod: status === 'GRACE_PERIOD',
    isOverdue: status === 'OVERDUE',
    isBlocked: status === 'BLOCKED',
    trialDaysLeft,
    graceDaysLeft,
    paidDaysLeft,
    trialEndsAt: sub?.trialEndsAt ?? null,
    graceEndsAt: sub?.graceEndsAt ?? null,
    paidUntil: sub?.paidUntil ?? null,
    blockedReason: status === 'BLOCKED' ? 'SUBSCRIPTION_BLOCKED' : status === 'OVERDUE' ? 'PAYMENT_REQUIRED' : null,
  };
}

function mapBackendStatus(data: any, schoolPlan: string | null | undefined): SubscriptionStatusInfo {
  const status = data.status as SubscriptionAccessStatus;
  const plan = (schoolPlan || 'TRIAL') as 'TRIAL' | 'STARTER' | 'OPTIMA' | 'NETWORK';

  return {
    plan,
    status,
    isTrial: plan === 'TRIAL' || status === 'TRIALING',
    isActive: status === 'ACTIVE',
    isGracePeriod: status === 'GRACE_PERIOD',
    isOverdue: status === 'OVERDUE',
    isBlocked: status === 'BLOCKED',
    trialDaysLeft: status === 'TRIALING' ? (data.daysRemaining ?? 0) : 0,
    graceDaysLeft: status === 'GRACE_PERIOD' ? (data.daysRemaining ?? 0) : 0,
    paidDaysLeft: status === 'ACTIVE' ? (data.daysRemaining ?? 0) : 0,
    trialEndsAt: data.trialEndsAt,
    graceEndsAt: data.graceEndsAt,
    paidUntil: data.paidUntil || (status === 'ACTIVE' ? data.graceEndsAt : null),
    blockedReason: data.blockedReason,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [school, setSchool] = useState<School | null>(null);
  const [subscriptionInfo, setSubscriptionInfo] = useState<SubscriptionStatusInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshSubscriptionStatus = async () => {
    if (!user || user.role === 'SUPERADMIN' || !school) return;
    try {
      const subRes = await api.get('/subscription/status');
      if (subRes.data.success) {
        setSubscriptionInfo(mapBackendStatus(subRes.data.data, school.subscription?.plan));
      }
    } catch {
      // Keep existing info or fallback
      if (!subscriptionInfo) {
        setSubscriptionInfo(computeLocalFallback(school));
      }
    }
  };

  useEffect(() => {
    const initializeAuth = async () => {
      // The access token lives in memory only, so a fresh page load has none —
      // reconstruct it from the HttpOnly refresh cookie before doing anything else.
      const token = await refreshAccessToken();
      if (token) {
        try {
          const res = await api.get('/auth/me');
          if (res.data.success) {
            const userData = res.data.data.user as User;
            const schoolData = res.data.data.school as School;

            setUser(userData);
            setSchool(schoolData);

            if (schoolData?.slug) {
              localStorage.setItem('schoolSlug', schoolData.slug);
            }
            connectSocket(token);

            // Fetch backend subscription status as primary source of truth
            if (userData.role !== 'SUPERADMIN' && schoolData) {
              setSubscriptionInfo(computeLocalFallback(schoolData));
              try {
                const subRes = await api.get('/subscription/status');
                if (subRes.data.success) {
                  setSubscriptionInfo(mapBackendStatus(subRes.data.data, schoolData.subscription?.plan));
                }
              } catch (subError) {
                // Keep the fallback
              }
            }
          } else {
            setAccessToken(null);
          }
        } catch (error) {
          // Only clear the token on an explicit auth rejection from the server.
          // A network error (server down/restarting, ECONNREFUSED, timeout) has
          // no `response` — the token may still be valid, so keep it for retry.
          if (!(axios.isAxiosError(error) && !error.response)) {
            setAccessToken(null);
          }
        }
      }
      setIsLoading(false);
    };

    initializeAuth();
  }, []);

  const login = async (token: string, userData: User, schoolData: School) => {
    setAccessToken(token);
    if (schoolData?.slug) localStorage.setItem('schoolSlug', schoolData.slug);
    setUser(userData);
    setSchool(schoolData);
    connectSocket(token);

    if (userData.role !== 'SUPERADMIN' && schoolData) {
      setSubscriptionInfo(computeLocalFallback(schoolData));
      try {
        const subRes = await api.get('/subscription/status');
        if (subRes.data.success) {
          setSubscriptionInfo(mapBackendStatus(subRes.data.data, schoolData.subscription?.plan));
        }
      } catch (subError) {
        // Fallback already set
      }
    }
  };

  const logout = () => {
    disconnectSocket();
    // Fire-and-forget — revokes the HttpOnly refresh cookie on the server
    api.post('/auth/logout').catch(() => {});
    setAccessToken(null);
    localStorage.removeItem('schoolSlug');
    setUser(null);
    setSchool(null);
    setSubscriptionInfo(null);
  };

  // Paywalled strictly when blocked
  const isPaywalled = !isLoading && !!user && user.role !== 'SUPERADMIN' && !!subscriptionInfo?.isBlocked;

  return (
    <AuthContext.Provider
      value={{
        user,
        school,
        isLoading,
        isPaywalled,
        subscriptionInfo,
        login,
        logout,
        refreshSubscriptionStatus,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
