import { useState, useEffect } from "react";
import { useNavigate, useParams, Link } from "react-router";
import { useAuth } from "../hooks/useAuth";
import api from "../lib/api";
import { CredentialResponse, GoogleLogin, GoogleOAuthProvider } from "@react-oauth/google";
import { Eye, EyeOff, User, Mail, UsersRound, CalendarDays, WalletCards } from "lucide-react";
import {
  AuthLayout,
  AuthCard,
  AuthInput,
  AuthButton,
  AuthAlert,
  AuthDivider,
} from "../components/layout/AuthLayout";
import { MIN_PASSWORD_LENGTH } from "../lib/passwordPolicy";
import { LoginMascot } from "../components/LoginMascot";

const LOGIN_TITLE = "Shamdan (Шамдан) — Вход | CRM для языковых школ";
const LOGIN_DESCRIPTION = "Shamdan (Шамдан) — вход для учеников, учителей и администраторов языковых школ.";
const LOGIN_CANONICAL = "https://shamdan.kg/login";

// Short version of Landing.tsx's `modules` list — kept local (not imported from Landing)
// so the login page's initial bundle doesn't pull in the whole landing chunk.
const LOGIN_FEATURES = [
  { icon: UsersRound, title: "Ученики и лиды", text: "Единая база учеников, заявок и оплат." },
  { icon: CalendarDays, title: "Расписание", text: "Группы, кабинеты и преподаватели без хаоса." },
  { icon: WalletCards, title: "Оплаты", text: "Контроль оплат и задолженностей школы." },
];

// Unset in a Railway/prod build → skip Google sign-in entirely rather than loading
// the SDK with a fake client ID (which fails every attempt with a confusing 403).
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

// DEV-LOGIN-SHORTCUTS: DEV-ONLY autologin shortcuts — remove before production. Gated on import.meta.env.DEV.
// Bundled with the localhost login-limiter bypass in server/src/routes/auth.ts — delete both together.
// Find every piece: grep -r "DEV-LOGIN-SHORTCUTS"
const DEV_ACCOUNTS = [
  { role: "OWNER", email: "admin@test.com", password: "test1234" },
  { role: "ADMIN", email: "lowadmin@gmail.com", password: "test1234" },
  { role: "TEACHER", email: "teacher1@test.com", password: "test1234" },
  { role: "STUDENT", email: "student2@test.com", password: "test1234" },
  { role: "SUPERADMIN", email: "super@admin.com", password: "super123" },
];

function LoginContent() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { login } = useAuth();

  const [isLoginView, setIsLoginView] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [error, setError] = useState("");
  const [schoolName, setSchoolName] = useState("Загрузка...");
  const [schoolLogoUrl, setSchoolLogoUrl] = useState<string | null>(null);
  const [schoolDescription, setSchoolDescription] = useState<string | null>(null);
  const [schoolHeroImageUrl, setSchoolHeroImageUrl] = useState<string | null>(null);
  const [schoolContact, setSchoolContact] = useState({ phone: "", email: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [unverifiedEmail, setUnverifiedEmail] = useState("");
  const [resendSuccess, setResendSuccess] = useState("");
  const [devVerifyLink, setDevVerifyLink] = useState("");

  // Form states
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  // Fetch school info if slug exists
  useEffect(() => {
    if (slug) {
      api
        .get(`/schools/${slug}`)
        .then((res) => {
          if (res.data.success) {
            setSchoolName(res.data.data.name);
            setSchoolLogoUrl(res.data.data.logoUrl || null);
            setSchoolDescription(res.data.data.description || null);
            setSchoolHeroImageUrl(res.data.data.landingConfig?.heroImageUrl || null);
            setSchoolContact({
              phone: res.data.data.phone || "",
              email: res.data.data.email || "",
            });
          }
        })
        .catch(() => setSchoolName("Школа не найдена"));
    } else {
      setSchoolName("Shamdan");
    }
  }, [slug]);

  // Basic per-route SEO for the general /login (index.html's static tags are landing-oriented
  // by default; this page overrides them while mounted and restores them on unmount).
  useEffect(() => {
    if (slug) return;
    const descriptionMeta = document.querySelector('meta[name="description"]');
    const canonicalLink = document.querySelector('link[rel="canonical"]');

    const prevTitle = document.title;
    const prevDescription = descriptionMeta?.getAttribute("content") ?? null;
    const prevCanonical = canonicalLink?.getAttribute("href") ?? null;

    document.title = LOGIN_TITLE;
    descriptionMeta?.setAttribute("content", LOGIN_DESCRIPTION);
    canonicalLink?.setAttribute("href", LOGIN_CANONICAL);

    return () => {
      document.title = prevTitle;
      if (descriptionMeta && prevDescription !== null) descriptionMeta.setAttribute("content", prevDescription);
      if (canonicalLink && prevCanonical !== null) canonicalLink.setAttribute("href", prevCanonical);
    };
  }, [slug]);

  const handleGoogleSuccess = async (credentialResponse: CredentialResponse) => {
    if (!credentialResponse.credential) {
      setError("Google authorization failed. Please try again.");
      return;
    }

    setIsGoogleLoading(true);
    setError("");
    try {
      const context = slug ? "school-login" : "login";
      const res = await api.post("/auth/google", {
        credential: credentialResponse.credential,
        context,
        slug: slug || undefined,
      });
      if (res.data.success) {
        if (res.data.data.requires2fa) {
          navigate("/auth/2fa", { state: { tempToken: res.data.data.tempToken } });
          return;
        }

        login(res.data.data.token, res.data.data.user, res.data.data.school);
        const role = res.data.data.user.role;
        if (role === "SUPERADMIN") {
          navigate("/superadmin/dashboard");
        } else {
          const resolvedSlug = res.data.data.school?.slug || "";
          if (role === "OWNER" && !res.data.data.school?.onboardingCompleted) {
            navigate(`/${resolvedSlug}/onboarding`);
          } else {
            const roleStr = role.toLowerCase();
            navigate(`/${resolvedSlug}/${roleStr}/dashboard`);
          }
        }
      }
    } catch (err: any) {
      setError(err.response?.data?.error || "Ошибка при авторизации через Google.");
    } finally {
      setIsGoogleLoading(false);
    }
  };

  const handleGoogleError = () => {
    setError("Google authorization failed. Please try again.");
  };

  const performLogin = async (loginEmail: string, loginPassword: string) => {
    setIsLoading(true);
    setError("");
    setUnverifiedEmail("");
    setResendSuccess("");
    try {
      const res = await api.post("/auth/login", {
        email: loginEmail,
        password: loginPassword,
        slug: slug || undefined,
      });

      if (res.data.success) {
        if (res.data.data.requires2fa) {
          navigate("/auth/2fa", { state: { tempToken: res.data.data.tempToken } });
          return;
        }

        login(res.data.data.token, res.data.data.user, res.data.data.school);
        const role = res.data.data.user.role;
        if (role === "SUPERADMIN") {
          navigate("/superadmin/dashboard");
        } else {
          const resolvedSlug = res.data.data.school?.slug || "";
          if (role === "OWNER" && !res.data.data.school?.onboardingCompleted) {
            navigate(`/${resolvedSlug}/onboarding`);
          } else {
            const roleStr = role.toLowerCase();
            const landingPage = role === "TEACHER" ? "schedule" : "dashboard";
            navigate(`/${resolvedSlug}/${roleStr}/${landingPage}`);
          }
        }
      }
    } catch (err: any) {
      if (err.response?.data?.error === "EMAIL_NOT_VERIFIED") {
        setError("Ваш email не подтвержден. Пожалуйста, проверьте почту.");
        setUnverifiedEmail(loginEmail);
      } else {
        setError(err.response?.data?.error || "Произошла ошибка. Пожалуйста, попробуйте еще раз.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoginView) {
      await performLogin(email, password);
      return;
    }

    setIsLoading(true);
    setError("");
    setUnverifiedEmail("");
    setResendSuccess("");

    try {
      {
        // Registration Flow (Student only)
        if (!slug) {
          setError("Регистрация доступна только по ссылке школы.");
          setIsLoading(false);
          return;
        }

        const res = await api.post("/auth/register-student", {
          slug,
          firstName,
          lastName,
          email,
          password,
        });

        if (res.data.success) {
          setResendSuccess("Письмо с подтверждением отправлено на " + email);
          setIsLoginView(true);
          if (res.data.data?.devVerifyLink) {
            setDevVerifyLink(res.data.data.devVerifyLink);
          }
        }
      }
    } catch (err: any) {
      if (err.response?.data?.error === "EMAIL_NOT_VERIFIED") {
        setError("Ваш email не подтвержден. Пожалуйста, проверьте почту.");
        setUnverifiedEmail(email);
      } else {
        setError(err.response?.data?.error || "Произошла ошибка. Пожалуйста, попробуйте еще раз.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendVerification = async () => {
    setIsLoading(true);
    setError("");
    setResendSuccess("");
    try {
      const res = await api.post("/auth/resend-verification", { email: unverifiedEmail });
      if (res.data.success) {
        setResendSuccess("Письмо повторно отправлено.");
        if (res.data.data?.devVerifyLink) {
          setDevVerifyLink(res.data.data.devVerifyLink);
        }
      }
    } catch (err: any) {
      setError(err.response?.data?.error || "Ошибка при отправке письма.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout
      schoolName={schoolName}
      slug={slug}
      logoUrl={schoolLogoUrl}
      description={schoolDescription}
      heroImageUrl={schoolHeroImageUrl}
      leftPanelExtra={
        !slug && (
          <div className="w-full max-w-xs space-y-8">
            <div className="space-y-3">
              <LoginMascot passwordFocused={passwordFocused} emailFocused={emailFocused} hasError={!!error} />
              <div className="text-center">
                <p className="text-2xl font-serif font-bold text-slate-800 tracking-tight">Shamdan</p>
                <p className="text-xs font-bold text-emerald-600 mt-0.5">ERP для языковых школ</p>
              </div>
            </div>
            <div className="space-y-5">
              {LOGIN_FEATURES.map(({ icon: Icon, title, text }) => (
                <div key={title} className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                    <Icon className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-800">{title}</p>
                    <p className="text-xs text-slate-500 leading-relaxed">{text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      }
    >
      <AuthCard>
        {/* Toggle tabs for student signup (only visible when school slug exists) */}
        {slug && (
          <div className="flex bg-slate-100 border border-slate-200 rounded-xl p-1 mb-6">
            <button
              type="button"
              onClick={() => {
                setIsLoginView(true);
                setError("");
                setResendSuccess("");
              }}
              className={`flex-1 py-2 text-xs font-bold transition rounded-lg ${
                isLoginView
                  ? "text-emerald-700 bg-white shadow-sm border border-slate-200/50"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Вход
            </button>
            <button
              type="button"
              onClick={() => {
                setIsLoginView(false);
                setError("");
                setResendSuccess("");
              }}
              className={`flex-1 py-2 text-xs font-bold transition rounded-lg ${
                !isLoginView
                  ? "text-emerald-700 bg-white shadow-sm border border-slate-200/50"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Регистрация
            </button>
          </div>
        )}

        <div className="mb-6 text-center">
          <h1 className={`text-2xl font-extrabold text-slate-800 tracking-tight ${isLoginView ? "" : "mb-1.5"}`}>
            {isLoginView ? "С возвращением" : "Создать аккаунт"}
          </h1>
          {!isLoginView && (
            <p className="text-slate-500 text-[13px] leading-relaxed">
              Зарегистрируйтесь как студент школы.
            </p>
          )}
        </div>

        {error && (
          <AuthAlert message={error} type="error">
            {unverifiedEmail && isLoginView && (
              <button
                type="button"
                onClick={handleResendVerification}
                disabled={isLoading}
                className="mt-2 text-[10px] font-bold uppercase tracking-wider text-rose-600 hover:text-rose-700 underline block"
              >
                Отправить письмо повторно
              </button>
            )}
          </AuthAlert>
        )}

        {resendSuccess && (
          <AuthAlert message={resendSuccess} type="success">
            {devVerifyLink && (
              <a
                href={devVerifyLink}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 w-full block text-center py-2 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl font-bold text-xs transition hover:bg-emerald-100"
              >
                🛠️ [DEV] Подтвердить Email
              </a>
            )}
          </AuthAlert>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {!isLoginView && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <AuthInput
                id="firstName"
                label="Имя"
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="Иван"
                type="text"
                autoComplete="given-name"
                icon={<User size={14} />}
              />
              <AuthInput
                id="lastName"
                label="Фамилия"
                required
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Иванов"
                type="text"
                autoComplete="family-name"
              />
            </div>
          )}

          <AuthInput
            id="email"
            label={isLoginView ? "Email, телефон или никнейм" : "Email"}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onFocus={() => setEmailFocused(true)}
            onBlur={() => setEmailFocused(false)}
            placeholder={isLoginView ? "email, телефон или никнейм" : "your@email.com"}
            type={isLoginView ? "text" : "email"}
            autoComplete={isLoginView ? "username" : "email"}
            inputMode={isLoginView ? "text" : "email"}
            icon={<Mail size={14} />}
          />

          <div className="relative group">
            <AuthInput
              id="password"
              label="Пароль"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={() => setPasswordFocused(true)}
              onBlur={() => setPasswordFocused(false)}
              placeholder="••••••••"
              type={showPassword ? "text" : "password"}
              // Only enforce the 12-char minimum when creating a new password
              // (registration). Login must never block submission based on
              // length — accounts created before this policy could have a
              // shorter existing password, and login isn't the place to
              // reject those; the server still authenticates them normally.
              minLength={isLoginView ? undefined : MIN_PASSWORD_LENGTH}
              autoComplete={isLoginView ? "current-password" : "new-password"}
              className="pr-8"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-0 top-6 text-emerald-600/50 hover:text-emerald-600 p-2 transition-colors z-20"
            >
              {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
            {isLoginView && (
              <div className="flex justify-end mt-1.5">
                <Link
                  to="/forgot-password"
                  className="text-xs text-emerald-600 hover:text-emerald-500 font-medium transition-colors"
                >
                  Забыли пароль?
                </Link>
              </div>
            )}
          </div>

          <div className="pt-2">
            <AuthButton isLoading={isLoading || isGoogleLoading}>
              {isLoginView ? "Войти" : "Создать аккаунт"}
            </AuthButton>
          </div>

          {isLoginView && GOOGLE_CLIENT_ID && (
            <>
              <AuthDivider />

              <div className="flex justify-center">
                {isGoogleLoading || isLoading ? (
                  <div className="w-full py-2 bg-slate-50 border border-slate-200 rounded-xl flex justify-center items-center opacity-50">
                    <div className="w-5 h-5 rounded-full border-2 border-emerald-500/30 border-t-emerald-600 animate-spin" />
                  </div>
                ) : (
                  <div className="google-login-light-wrapper">
                    <GoogleLogin
                      onSuccess={handleGoogleSuccess}
                      onError={handleGoogleError}
                      useOneTap={false}
                      shape="rectangular"
                      size="large"
                      theme="outline"
                      text="signin_with"
                      width="380"
                    />
                  </div>
                )}
              </div>
            </>
          )}
        </form>

        {/* DEV-LOGIN-SHORTCUTS: DEV-ONLY autologin — remove before production (see auth.ts loginLimiter) */}
        {import.meta.env.DEV && isLoginView && (
          <div className="mt-6 border-t border-dashed border-amber-300 pt-4">
            <p className="text-[10px] font-bold uppercase tracking-wider text-amber-600 text-center mb-2">
              🛠️ DEV Autologin
            </p>
            <div className="grid grid-cols-2 gap-2">
              {DEV_ACCOUNTS.map((acc) => (
                <button
                  key={acc.role}
                  type="button"
                  disabled={isLoading || isGoogleLoading}
                  onClick={() => performLogin(acc.email, acc.password)}
                  className={`py-2 bg-amber-50 border border-amber-200 text-amber-700 rounded-xl font-bold text-xs transition hover:bg-amber-100 disabled:opacity-50 ${
                    acc.role === "SUPERADMIN" ? "col-span-2" : ""
                  }`}
                >
                  {acc.role}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Dynamic CTA Footer links — school-specific login only; the general login stays login-only, no registration CTA */}
        {slug && (
          <div className="mt-8 text-center border-t border-slate-200/60 pt-6">
            <div className="space-y-2">
              <Link
                to="/login"
                className="text-xs text-emerald-600/80 hover:text-emerald-700 font-bold block transition-colors"
              >
                Войти в другую школу (Обычный вход)
              </Link>
              <p className="text-[11px] text-slate-500 leading-normal">
                Нет доступа к школе? Пожалуйста, обратитесь к вашему администратору.
                {(schoolContact.phone || schoolContact.email) && (
                  <>
                    <br />
                    {[schoolContact.phone, schoolContact.email].filter(Boolean).join(" · ")}
                  </>
                )}
              </p>
            </div>
          </div>
        )}
      </AuthCard>
    </AuthLayout>
  );
}

export default function Login() {
  if (!GOOGLE_CLIENT_ID) return <LoginContent />;

  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <LoginContent />
    </GoogleOAuthProvider>
  );
}
