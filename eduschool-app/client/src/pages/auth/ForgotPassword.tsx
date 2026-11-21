import { useState } from "react";
import { Link } from "react-router";
import { Mail, CheckCircle2 } from "lucide-react";
import api from "../../lib/api";
import {
  AuthLayout,
  AuthCard,
  AuthInput,
  AuthButton,
  AuthAlert,
} from "../../components/layout/AuthLayout";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError("");

    try {
      await api.post("/auth/forgot-password", { email });
      // Always show success message for security (prevent email enumeration)
      setIsSuccess(true);
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
          <div className="text-center space-y-6">
            <div className="w-16 h-16 bg-emerald-50 border border-emerald-200 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
              <CheckCircle2 className="w-8 h-8 text-emerald-600" />
            </div>
            <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">Проверьте почту</h2>
            <p className="text-slate-500 text-sm leading-relaxed">
              Если аккаунт с email <span className="font-semibold text-emerald-600">{email}</span>{" "}
              существует, мы отправили на него инструкции по сбросу пароля.
            </p>
            <div className="pt-4">
              <Link
                to="/login"
                className="w-full py-3.5 block bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-xl font-bold text-sm transition duration-200 text-center shadow-md active:scale-[0.98]"
              >
                Вернуться ко входу
              </Link>
            </div>
          </div>
        ) : (
          <>
            <div className="mb-6 text-center">
              <h1 className="text-2xl font-extrabold text-slate-800 mb-1.5 tracking-tight">
                Сброс пароля
              </h1>
              <p className="text-slate-500 text-[13px] leading-relaxed">
                Введите ваш email, и мы отправим вам ссылку для сброса пароля.
              </p>
            </div>

            {error && <AuthAlert message={error} type="error" />}

            <form onSubmit={handleSubmit} className="space-y-5">
              <AuthInput
                id="email"
                label="Email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                type="email"
                icon={<Mail size={14} />}
              />

              <div className="pt-2">
                <AuthButton isLoading={isLoading}>Отправить ссылку</AuthButton>
              </div>
            </form>

            <div className="mt-8 text-center border-t border-slate-200/60 pt-6">
              <p className="text-xs text-slate-500 transition">
                Вспомнили пароль?{" "}
                <Link
                  to="/login"
                  className="text-emerald-600 hover:text-emerald-500 font-bold ml-1 transition-colors"
                >
                  Войти.
                </Link>
              </p>
            </div>
          </>
        )}
      </AuthCard>
    </AuthLayout>
  );
}
