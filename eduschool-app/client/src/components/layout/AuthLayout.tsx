import React, { useState, useEffect } from "react";
import { Link } from "react-router";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { ParticlesFieldBackground } from "../ParticlesFieldBackground";
import { Logo } from "../Logo";
import { resolveUploadUrl } from "../../lib/api";

interface AuthLayoutProps {
  children: React.ReactNode;
  schoolName?: string;
  slug?: string;
  logoUrl?: string | null;
  description?: string | null;
  heroImageUrl?: string | null;
  /** Fallback content for the left panel's middle gap, used only when there's no school hero image/description. */
  leftPanelExtra?: React.ReactNode;
}

export function AuthLayout({
  children,
  schoolName,
  slug,
  logoUrl,
  description,
  heroImageUrl,
  leftPanelExtra,
}: AuthLayoutProps) {
  const resolvedLogo = resolveUploadUrl(logoUrl);
  const resolvedHeroImage = resolveUploadUrl(heroImageUrl);
  const [isMobile, setIsMobile] = useState(false);

  // Auth pages are light-only (no dark: variants anywhere here). The `dark`
  // class can be left on <html> from a dashboard visit earlier in the SPA
  // session — strip it while mounted so global `.dark .bg-white` etc. rules
  // don't repaint this page, then restore it on unmount.
  useEffect(() => {
    const root = document.documentElement;
    const hadDark = root.classList.contains("dark");
    if (hadDark) root.classList.remove("dark");
    return () => {
      if (hadDark) root.classList.add("dark");
    };
  }, []);

  // Check if viewport is mobile/tablet to adapt particles density
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 1024);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <div
      className="fixed inset-0 h-dvh max-h-dvh text-slate-800 font-sans overflow-hidden flex flex-col justify-between"
      style={{
        background:
          "radial-gradient(circle at 15% 15%, rgba(52, 211, 153, 0.05), transparent 45%), radial-gradient(circle at 85% 85%, rgba(45, 212, 191, 0.05), transparent 45%), linear-gradient(135deg, #f8fafc 0%, #f1f5f9 50%, #e2e8f0 100%)",
      }}
    >
      {/* 1. Global Interactive Light Particle Field Backdrop */}
      <ParticlesFieldBackground
        particleCount={isMobile ? 20 : 60}
        particleSize={1.15}
        speed={0.18}
        opacity={0.08}
        glowStrength={0.05}
        theme="light"
        variant="section-soft"
        className="opacity-75"
      />

      <div className="w-full h-full min-h-0 flex-grow lg:grid lg:grid-cols-12 relative z-10">
        {/* 2. Left Column: Brand Showcase in Light Mode */}
        <div className="hidden lg:flex lg:col-span-5 flex-col justify-between p-8 xl:p-12 2xl:p-14 border-r border-slate-200/50 bg-gradient-to-br from-emerald-50/15 to-teal-50/10 relative overflow-hidden min-h-0">
          {/* Subtle warm corner glows */}
          <div className="absolute -top-32 -left-32 w-96 h-96 bg-emerald-500/5 rounded-full blur-[120px] pointer-events-none" />
          <div className="absolute -bottom-32 -right-32 w-96 h-96 bg-teal-500/5 rounded-full blur-[120px] pointer-events-none" />

          {/* Top Logo */}
          <div className="relative z-10">
            <Link to={slug ? `/${slug}` : "/"} className="flex items-center gap-2.5 group">
              {resolvedLogo ? (
                <img
                  src={resolvedLogo}
                  alt=""
                  className="h-9 w-9 rounded-lg object-cover border border-slate-200/60 shadow-sm group-hover:scale-105 transition"
                />
              ) : (
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-white border border-slate-200/60 shadow-sm ring-1 ring-emerald-500/5 group-hover:scale-105 transition">
                  <Logo size={20} />
                </span>
              )}
              <span className="text-xl font-bold tracking-tight text-slate-800">
                {schoolName || "Shamdan"}
              </span>
            </Link>
          </div>

          {/* School photo & description, or a fallback for the general (non-tenant) login */}
          {resolvedHeroImage || description ? (
            <div className="relative z-10 my-auto space-y-6 max-w-md">
              {resolvedHeroImage && (
                <div className="rounded-2xl overflow-hidden shadow-xl border border-slate-200/60 aspect-[4/3]">
                  <img src={resolvedHeroImage} alt="" className="w-full h-full object-cover" />
                </div>
              )}
              {description && (
                <p className="text-slate-600 text-base xl:text-lg leading-relaxed">
                  {description}
                </p>
              )}
            </div>
          ) : (
            leftPanelExtra && (
              <div className="relative z-10 my-auto flex justify-center">{leftPanelExtra}</div>
            )
          )}

          {/* Footer Trademark */}
          <div className="relative z-10 text-xs text-slate-400 font-medium">
            &copy; {new Date().getFullYear()} {schoolName || "Shamdan"}. Все права защищены.
          </div>
        </div>

        {/* 3. Right Column: Form Container (Centers children) */}
        <div className="col-span-12 lg:col-span-7 flex flex-col justify-center items-center px-4 py-4 sm:py-6 lg:py-8 relative min-h-0 overflow-hidden">
          {/* Subtle glow behind card */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-emerald-500/5 rounded-full blur-[100px] pointer-events-none" />

          {/* Mobile Top Brand (Visible only on mobile/tablet) */}
          <div className="lg:hidden mb-4 sm:mb-6 text-center animate-in fade-in slide-in-from-top-3 duration-300">
            <Link to={slug ? `/${slug}` : "/"} className="inline-flex items-center gap-2">
              {resolvedLogo ? (
                <img src={resolvedLogo} alt="" className="h-8 w-8 rounded-lg object-cover border border-slate-200/60 shadow-sm" />
              ) : (
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-white border border-slate-200/60 shadow-sm">
                  <Logo size={18} />
                </span>
              )}
              <span className="text-lg font-bold tracking-tight text-slate-800">
                {schoolName || "Shamdan"}
              </span>
            </Link>
          </div>

          <div className="w-full max-w-[460px] flex justify-center items-center min-h-0">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────
   Reusable Light Sub-Components
──────────────────────────────────────────────────────── */

// A. AuthCard Component
export function AuthCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`w-full bg-white/90 border border-slate-200/60 rounded-2xl shadow-[0_20px_50px_rgba(15,23,42,0.06)] p-5 sm:p-6 xl:p-8 relative overflow-hidden animate-in fade-in zoom-in-95 duration-300 ${className}`}
    >
      {/* Sleek top emerald border glow for premium finish */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-0.5 bg-gradient-to-r from-transparent via-emerald-500/25 to-transparent" />
      {children}
    </div>
  );
}

// B. AuthInput Component
interface AuthInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  icon?: React.ReactNode;
}

export const AuthInput = React.forwardRef<HTMLInputElement, AuthInputProps>(
  ({ label, icon, className = "", id, ...props }, ref) => {
    return (
      <div className="space-y-1.5 relative group w-full">
        <label
          className="block text-[10px] font-bold uppercase tracking-widest text-slate-500 group-focus-within:text-emerald-600 transition-colors"
          htmlFor={id}
        >
          {label}
        </label>
        <div className="relative">
          {icon && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-emerald-500 transition-colors">
              {icon}
            </div>
          )}
          <input
            id={id}
            ref={ref}
            className={`w-full ${
              icon ? "pl-7" : "px-0"
            } py-2 bg-transparent border-0 border-b-2 border-slate-200 focus:border-emerald-500 focus:ring-0 transition-colors text-slate-800 placeholder-slate-400/30 text-[14px] outline-none ${className}`}
            {...props}
          />
        </div>
      </div>
    );
  }
);
AuthInput.displayName = "AuthInput";

// C. AuthButton Component
export function AuthButton({
  children,
  isLoading,
  type = "submit",
  className = "",
  disabled,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean }) {
  return (
    <button
      type={type}
      disabled={disabled || isLoading}
      className={`w-full py-3 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-xl font-bold text-sm transition duration-200 active:scale-[0.98] flex justify-center items-center gap-2 shadow-[0_4px_15px_rgba(4,120,87,0.12)] hover:shadow-[0_4px_20px_rgba(4,120,87,0.18)] disabled:opacity-50 disabled:pointer-events-none ${className}`}
      {...props}
    >
      {isLoading ? (
        <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
      ) : (
        children
      )}
    </button>
  );
}

// D. AuthAlert Component
export function AuthAlert({
  message,
  type = "error",
  children,
}: {
  message: string;
  type?: "error" | "success";
  children?: React.ReactNode;
}) {
  if (!message) return null;
  const isError = type === "error";
  return (
    <div
      className={`mb-6 p-4 rounded-xl border animate-in slide-in-from-top-2 duration-200 flex gap-3 items-start ${
        isError
          ? "bg-rose-50/80 border-rose-100/70 text-rose-800 shadow-sm"
          : "bg-emerald-50/80 border-emerald-100/70 text-emerald-800 shadow-sm"
      }`}
    >
      {isError ? (
        <AlertCircle size={16} className="text-rose-500 shrink-0 mt-0.5" />
      ) : (
        <CheckCircle2 size={16} className="text-emerald-500 shrink-0 mt-0.5" />
      )}
      <div className="flex-1 text-xs font-semibold leading-relaxed">
        {message}
        {children}
      </div>
    </div>
  );
}

// E. AuthDivider Component
export function AuthDivider() {
  return (
    <div className="relative flex items-center gap-3 py-2 w-full">
      <div className="flex-1 h-px bg-slate-200" />
      <span className="text-[9px] text-slate-400 font-bold uppercase tracking-widest">или</span>
      <div className="flex-1 h-px bg-slate-200" />
    </div>
  );
}
