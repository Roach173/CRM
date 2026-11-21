import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import toast from 'react-hot-toast';

// Extend InternalAxiosRequestConfig to support our custom _retry flag.
type RetriableRequestConfig = InternalAxiosRequestConfig & {
  _retry?: boolean;
};

// In dev VITE_API_URL is empty → baseURL is '/api/v1' (served via Vite proxy).
// In prod (Vercel) VITE_API_URL is the API origin (Render) → 'https://api.../api/v1'.
// Mirrors the convention already used by lib/socket.ts.
const API_BASE = `${import.meta.env.VITE_API_URL || ''}/api/v1`;

// Uploaded files (logos, hero photos) are served from the API origin, not
// under /api/v1 — client and API are cross-origin in production, so a bare
// "/uploads/..." path from the DB would 404 there (works in dev only, via
// the Vite proxy, which makes the missing prefix easy to miss).
const API_ORIGIN = import.meta.env.VITE_API_URL || '';
export function resolveUploadUrl(path?: string | null): string | null {
  return path ? `${API_ORIGIN}${path}` : null;
}

const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
});

// Access token lives in memory only — never localStorage/sessionStorage. It's
// short-lived (15m) and any XSS that can read JS state can already do far worse,
// but there's no reason to also leave a long-lived credential sitting in a
// browser storage API that's trivially readable by any injected script.
let accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

api.interceptors.request.use(
  (config) => {
    if (accessToken) {
      config.headers.Authorization = `Bearer ${accessToken}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

let sessionExpiredHandled = false;
let isRefreshing = false;
let refreshPromise: Promise<string | null> | null = null;

// Safe helper to clear session and redirect.
const handleLogoutAndRedirect = () => {
  const savedSlug = localStorage.getItem('schoolSlug');
  setAccessToken(null);
  localStorage.removeItem('schoolSlug');

  if (savedSlug) {
    window.location.href = `/${savedSlug}/login`;
  } else {
    // Fallback: check if path contains a school slug like /:slug/admin
    const pathParts = window.location.pathname.split('/');
    if (pathParts.length > 1 && pathParts[1] && pathParts[1] !== 'login' && pathParts[1] !== 'register') {
      window.location.href = `/${pathParts[1]}/login`;
    } else {
      window.location.href = '/login';
    }
  }
};

// Helper to check if the requested URL is an auth-related endpoint.
const isAuthEndpoint = (url?: string): boolean => {
  if (!url) return false;
  // Strip query parameters and trailing slash
  const cleanUrl = url.split('?')[0].replace(/\/$/, '');
  
  const authEndpoints = [
    '/auth/login',
    '/auth/refresh',
    '/auth/logout',
    '/auth/forgot-password',
    '/auth/reset-password',
    '/auth/reset-password/validate',
    '/auth/verify-email',
    '/auth/google',
  ];
  
  return authEndpoints.some((endpoint) => cleanUrl.endsWith(endpoint));
};

// Performs the actual POST request to the refresh token endpoint. Exported so
// AuthContext can call it once on app boot to reconstruct the in-memory access
// token from the HttpOnly refresh cookie (there's nothing in localStorage to read anymore).
export const refreshAccessToken = async (): Promise<string | null> => {
  try {
    const response = await axios.post(`${API_BASE}/auth/refresh`, {}, { withCredentials: true });
    if (response.data?.success && response.data?.data?.token) {
      const newToken = response.data.data.token;
      setAccessToken(newToken);
      return newToken;
    }
    return null;
  } catch (error) {
    return null;
  }
};

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as RetriableRequestConfig;
    
    // Handle 402 Payment Required for subscription overdue states (Read-only mode)
    if (error.response?.status === 402) {
      toast.error('Функция недоступна. Пожалуйста, продлите подписку для разблокировки записи данных.');
      return Promise.reject(error);
    }

    // Check if error is 401 and request was valid and not already retried
    if (error.response?.status === 401 && originalRequest && !originalRequest._retry) {
      const url = originalRequest.url;
      const path = window.location.pathname;
      
      // Determine if we are on one of the public auth pages.
      const onAuthPage =
        path === '/login' ||
        path === '/' ||
        /^\/[^/]+\/login$/.test(path) ||
        path.startsWith('/register') ||
        path.startsWith('/forgot-password') ||
        path.startsWith('/reset-password');
      
      // Do not attempt automatic token refresh on auth pages or for auth endpoints.
      if (onAuthPage || isAuthEndpoint(url)) {
        return Promise.reject(error);
      }
      
      originalRequest._retry = true;
      
      if (!isRefreshing) {
        isRefreshing = true;
        refreshPromise = refreshAccessToken();
      }
      
      try {
        const token = await refreshPromise;
        
        if (token) {
          isRefreshing = false;
          refreshPromise = null;
          sessionExpiredHandled = false;

          // Update the original request's Authorization header
          originalRequest.headers.Authorization = `Bearer ${token}`;
          // Retry the original request using our configured instance
          return api(originalRequest);
        } else {
          isRefreshing = false;
          refreshPromise = null;
          
          if (!sessionExpiredHandled) {
            sessionExpiredHandled = true;
            handleLogoutAndRedirect();
            toast.error('Сессия истекла. Пожалуйста, войдите снова.');
          }
          return Promise.reject(error);
        }
      } catch (refreshError) {
        isRefreshing = false;
        refreshPromise = null;
        
        if (!sessionExpiredHandled) {
          sessionExpiredHandled = true;
          handleLogoutAndRedirect();
          toast.error('Сессия истекла. Пожалуйста, войдите снова.');
        }
        return Promise.reject(refreshError);
      }
    }
    
    return Promise.reject(error);
  }
);

export default api;
