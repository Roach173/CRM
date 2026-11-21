import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../hooks/useAuth";
import api from "../lib/api";
import { CredentialResponse, GoogleLogin, GoogleOAuthProvider } from "@react-oauth/google";
import { Eye, EyeOff, Home, Mail, CheckCircle2, ChevronRight, ArrowLeft } from "lucide-react";
import {
  AuthLayout,
  AuthCard,
  AuthInput,
  AuthButton,
  AuthAlert,
  AuthDivider,
} from "../components/layout/AuthLayout";
import { MIN_PASSWORD_LENGTH } from "../lib/passwordPolicy";

// Unset in a Railway/prod build → skip Google sign-in entirely rather than loading
// the SDK with a fake client ID (which fails every attempt with a confusing 403).
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

function RegisterSchoolContent() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2>(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [error, setError] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [devVerifyLink, setDevVerifyLink] = useState("");

  const [formData, setFormData] = useState({
    schoolName: "",
    email: "",
    password: "",
    confirmPassword: "",
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleNextStep = (e: React.MouseEvent) => {
    e.preventDefault();
    setError("");

    if (!formData.schoolName.trim()) {
      setError("Пожалуйста, введите название школы.");
      return;
    }

    if (!formData.email.trim()) {
      setError("Пожалуйста, введите email администратора.");
      return;
    }

    // Check basic email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(formData.email)) {
      setError("Пожалуйста, введите корректный email адрес.");
      return;
    }

    setStep(2);
  };

  const handleGoogleSuccess = async (credentialResponse: CredentialResponse) => {
    if (!credentialResponse.credential) {
      setError("Google authorization failed. Please try again.");
      return;
    }

    setIsGoogleLoading(true);
    setError("");
    try {
      const res = await api.post("/auth/google", {
        credential: credentialResponse.credential,
        context: "register-school",
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (step === 1) {
      // Safety transition trigger if submitted via Enter key on Step 1 inputs
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!formData.schoolName.trim() || !formData.email.trim() || !emailRegex.test(formData.email)) {
        setError("Пожалуйста, заполните корректно поля первого шага.");
        return;
      }
      setStep(2);
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      setError("Пароли не совпадают.");
      return;
    }

    if (!agreed) {
      setError("Вы должны принять условия Пользовательского соглашения.");
      return;
    }

    setIsLoading(true);

    try {
      const res = await api.post("/auth/register-school", {
        schoolName: formData.schoolName.trim(),
        email: formData.email,
        password: formData.password,
      });

      if (res.data.success) {
        setIsSuccess(true);
        if (res.data.data?.devVerifyLink) {
          setDevVerifyLink(res.data.data.devVerifyLink);
        }
      }
    } catch (err: any) {
      setError(err.response?.data?.error || "Произошла ошибка. Пожалуйста, попробуйте еще раз.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout schoolName="Shamdan">
      <AuthCard>
        {isSuccess ? (
          <div className="text-center space-y-6 animate-in fade-in duration-200">
            <div className="w-16 h-16 bg-emerald-50 border border-emerald-200 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
              <CheckCircle2 className="w-8 h-8 text-emerald-600" />
            </div>
            <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">Проверьте почту</h2>
            <p className="text-slate-500 text-sm leading-relaxed">
              Письмо с подтверждением отправлено на{" "}
              <span className="font-semibold text-emerald-600">{formData.email}</span>. Перейдите по
              ссылке в письме, чтобы завершить регистрацию школы.
            </p>
            <div className="pt-4 space-y-3">
              <AuthButton onClick={() => navigate("/login")}>Перейти ко входу</AuthButton>
              {devVerifyLink && (
                <a
                  href={devVerifyLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full block text-center py-4 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl font-bold text-sm transition hover:bg-emerald-100"
                >
                  🛠️ [DEV] Подтвердить Email
                </a>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="mb-6 text-center">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10px] font-bold uppercase tracking-wider rounded-full mb-3 shadow-sm">
                Шаг {step} из 2
              </div>
              <h1 className="text-2xl font-extrabold text-slate-800 mb-1.5 tracking-tight">
                {step === 1 ? "Регистрация школы" : "Создайте пароль"}
              </h1>
              <p className="text-slate-500 text-[13px] leading-relaxed">
                {step === 1
                  ? "Заполните основную информацию о вашей школе"
                  : "Задайте надежный пароль для вашей учетной записи"}
              </p>
            </div>

            {error && <AuthAlert message={error} type="error" />}

            <form onSubmit={handleSubmit} className="space-y-5">
              {step === 1 ? (
                // STEP 1 FIELDS
                <div className="space-y-5 animate-in fade-in duration-200">
                  <AuthInput
                    id="schoolName"
                    name="schoolName"
                    label="Название школы"
                    required
                    value={formData.schoolName}
                    onChange={handleChange}
                    placeholder="Например, Smile English"
                    type="text"
                    maxLength={80}
                    icon={<Home size={14} />}
                  />

                  <AuthInput
                    id="email"
                    name="email"
                    label="Email администратора"
                    required
                    value={formData.email}
                    onChange={handleChange}
                    placeholder="your@email.com"
                    type="email"
                    icon={<Mail size={14} />}
                  />

                  <div className="pt-2">
                    <AuthButton type="button" onClick={handleNextStep}>
                      Продолжить
                      <ChevronRight size={16} />
                    </AuthButton>
                  </div>

                  {GOOGLE_CLIENT_ID && (
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
                              text="signup_with"
                              width="380"
                            />
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                // STEP 2 FIELDS
                <div className="space-y-5 animate-in fade-in duration-200">
                  <div className="relative group">
                    <AuthInput
                      id="password"
                      name="password"
                      label="Пароль"
                      required
                      value={formData.password}
                      onChange={handleChange}
                      placeholder="••••••••"
                      type={showPassword ? "text" : "password"}
                      minLength={MIN_PASSWORD_LENGTH}
                      className="pr-8"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-0 top-6 text-emerald-600/50 hover:text-emerald-600 p-2 transition-colors z-20"
                    >
                      {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>

                  <div className="relative group">
                    <AuthInput
                      id="confirmPassword"
                      name="confirmPassword"
                      label="Подтверждение пароля"
                      required
                      value={formData.confirmPassword}
                      onChange={handleChange}
                      placeholder="••••••••"
                      type={showConfirmPassword ? "text" : "password"}
                      minLength={MIN_PASSWORD_LENGTH}
                      className="pr-8"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute right-0 top-6 text-emerald-600/50 hover:text-emerald-600 p-2 transition-colors z-20"
                    >
                      {showConfirmPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>

                  <div className="flex items-start gap-3 pt-1">
                    <input
                      id="agree"
                      type="checkbox"
                      checked={agreed}
                      onChange={(e) => setAgreed(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 accent-emerald-500 cursor-pointer shrink-0 bg-transparent"
                    />
                    <label
                      htmlFor="agree"
                      className="text-xs text-slate-500 leading-normal cursor-pointer"
                    >
                      Я принимаю условия{" "}
                      <a
                        href="/terms"
                        className="text-emerald-600 hover:text-emerald-500 font-semibold transition-colors"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Пользовательского соглашения
                      </a>{" "}
                      и даю согласие на{" "}
                      <a
                        href="/privacy"
                        className="text-emerald-600 hover:text-emerald-500 font-semibold transition-colors"
                        onClick={(e) => e.stopPropagation()}
                      >
                        обработку персональных данных
                      </a>
                    </label>
                  </div>

                  <div className="pt-2 space-y-3">
                    <AuthButton isLoading={isLoading}>Создать школу</AuthButton>
                    <button
                      type="button"
                      onClick={() => {
                        setStep(1);
                        setError("");
                      }}
                      className="w-full py-3.5 bg-transparent border border-slate-200 hover:border-slate-300 text-slate-600 hover:bg-slate-50 rounded-xl font-bold text-sm transition duration-200 flex justify-center items-center gap-1.5 active:scale-[0.98]"
                    >
                      <ArrowLeft size={16} />
                      Назад
                    </button>
                  </div>
                </div>
              )}
            </form>
          </>
        )}

        <div className="mt-8 text-center border-t border-slate-200/60 pt-6">
          <p className="text-xs text-slate-500 transition">
            Уже есть аккаунт?{" "}
            <Link
              to="/login"
              className="text-emerald-600 hover:text-emerald-500 font-bold ml-1 transition-colors"
            >
              Войти.
            </Link>
          </p>
        </div>
      </AuthCard>
    </AuthLayout>
  );
}

export default function RegisterSchool() {
  if (!GOOGLE_CLIENT_ID) return <RegisterSchoolContent />;

  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <RegisterSchoolContent />
    </GoogleOAuthProvider>
  );
}
