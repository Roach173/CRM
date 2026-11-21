import { useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router";
import { Eye, EyeOff, CheckCircle2, ShieldAlert } from "lucide-react";
import api from "../../lib/api";
import {
  AuthLayout,
  AuthCard,
  AuthInput,
  AuthButton,
  AuthAlert,
} from "../../components/layout/AuthLayout";
import { MIN_PASSWORD_LENGTH } from "../../lib/passwordPolicy";

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [status, setStatus] = useState<"loading" | "valid" | "error">("loading");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [isSuccess, setIsSuccess] = useState(false);

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("Токен сброса пароля не найден");
      return;
    }

    api
      .get(`/auth/reset-password/validate?token=${token}`)
      .then((res) => {
        if (res.data.success && res.data.valid) {
          setStatus("valid");
          setEmail(res.data.email);
        } else {
          setStatus("error");
          setError("Недействительный или истекший токен");
        }
      })
      .catch((err) => {
        setStatus("error");
        setError(err.response?.data?.error || "Произошла ошибка при проверке токена");
      });
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError("Пароли не совпадают");
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const res = await api.post("/auth/reset-password", {
        token,
        newPassword: password,
      });

      if (res.data.success) {
        setIsSuccess(true);
      }
    } catch (err: any) {
      setError(err.response?.data?.error || "Произошла ошибка при сбросе пароля");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout schoolName="Shamdan">
      <AuthCard>
        {status === "loading" && (
          <div className="flex flex-col items-center py-10 space-y-4">
            <div className="w-10 h-10 rounded-full border-2 border-emerald-500/30 border-t-emerald-600 animate-spin" />
            <h2 className="text-xl font-bold text-slate-800">Проверка ссылки...</h2>
            <p className="text-slate-500 text-xs">Пожалуйста, подождите.</p>
          </div>
        )}

        {status === "error" && (
          <div className="text-center space-y-6">
            <div className="w-16 h-16 bg-rose-50 border border-rose-200 rounded-full flex items-center justify-center mx-auto mb-4">
              <ShieldAlert className="w-8 h-8 text-rose-600" />
            </div>
            <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">Ошибка</h2>
            <p className="text-rose-700 text-sm leading-relaxed">{error}</p>
            <div className="pt-4">
              <Link
                to="/forgot-password"
                className="w-full py-3.5 block bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-xl font-bold text-sm text-center transition duration-200 shadow-md active:scale-[0.98]"
              >
                Запросить новую ссылку
              </Link>
            </div>
          </div>
        )}

        {status === "valid" &&
          (isSuccess ? (
            <div className="text-center space-y-6">
              <div className="w-16 h-16 bg-emerald-50 border border-emerald-200 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
                <CheckCircle2 className="w-8 h-8 text-emerald-600" />
              </div>
              <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">
                Пароль изменен!
              </h2>
              <p className="text-slate-500 text-sm leading-relaxed">
                Ваш пароль был успешно изменен. Теперь вы можете войти в свой аккаунт.
              </p>
              <div className="pt-4">
                <Link
                  to="/login"
                  className="w-full py-3.5 block bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-xl font-bold text-sm text-center transition duration-200 shadow-md active:scale-[0.98]"
                >
                  Перейти ко входу
                </Link>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-6 text-center">
                <h1 className="text-2xl font-extrabold text-slate-800 mb-1.5 tracking-tight">
                  Новый пароль
                </h1>
                <p className="text-slate-500 text-[13px] leading-relaxed">
                  Установите новый пароль для аккаунта <br />
                  <span className="font-semibold text-emerald-600">{email}</span>
                </p>
              </div>

              {error && <AuthAlert message={error} type="error" />}

              <form onSubmit={handleSubmit} className="space-y-5">
                <div className="relative group">
                  <AuthInput
                    id="password"
                    label="Новый пароль"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    type={showPassword ? "text" : "password"}
                    minLength={MIN_PASSWORD_LENGTH}
                    className="pr-8"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-0 bottom-2 text-emerald-600/50 hover:text-emerald-600 p-2 transition-colors z-20"
                  >
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>

                <div className="relative group">
                  <AuthInput
                    id="confirmPassword"
                    label="Подтвердите пароль"
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    type={showConfirmPassword ? "text" : "password"}
                    minLength={MIN_PASSWORD_LENGTH}
                    className="pr-8"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    className="absolute right-0 bottom-2 text-emerald-600/50 hover:text-emerald-600 p-2 transition-colors z-20"
                  >
                    {showConfirmPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>

                <div className="pt-2">
                  <AuthButton isLoading={isLoading}>Сохранить пароль</AuthButton>
                </div>
              </form>
            </>
          ))}
      </AuthCard>
    </AuthLayout>
  );
}
