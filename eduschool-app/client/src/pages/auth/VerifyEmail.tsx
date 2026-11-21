import { useEffect, useState, useRef } from "react";
import { useNavigate, useSearchParams, Link } from "react-router";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import api from "../../lib/api";
import {
  AuthLayout,
  AuthCard,
  AuthButton,
} from "../../components/layout/AuthLayout";

export default function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const navigate = useNavigate();

  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("");
  const hasAttempted = useRef(false);

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("Токен подтверждения не найден");
      return;
    }

    if (hasAttempted.current) return;
    hasAttempted.current = true;

    api
      .get(`/auth/verify-email?token=${token}`)
      .then((res) => {
        if (res.data.success) {
          setStatus("success");
          setMessage("Ваш email успешно подтвержден!");
        } else {
          setStatus("error");
          setMessage(res.data.error || "Недействительный или истекший токен");
        }
      })
      .catch((err) => {
        setStatus("error");
        setMessage(err.response?.data?.error || "Произошла ошибка при подтверждении email");
      });
  }, [token]);

  return (
    <AuthLayout schoolName="Shamdan">
      <AuthCard>
        {status === "loading" && (
          <div className="flex flex-col items-center py-10 space-y-4">
            <div className="w-10 h-10 rounded-full border-2 border-emerald-500/30 border-t-emerald-600 animate-spin" />
            <h2 className="text-xl font-bold text-slate-800">Подтверждение email...</h2>
            <p className="text-slate-500 text-xs">Пожалуйста, подождите.</p>
          </div>
        )}

        {status === "success" && (
          <div className="text-center space-y-6">
            <div className="w-16 h-16 bg-emerald-50 border border-emerald-200 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
              <CheckCircle2 className="w-8 h-8 text-emerald-600" />
            </div>
            <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">Успешно!</h2>
            <p className="text-slate-500 text-sm leading-relaxed">{message}</p>
            <div className="pt-4">
              <AuthButton onClick={() => navigate("/login")}>Перейти ко входу</AuthButton>
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="text-center space-y-6">
            <div className="w-16 h-16 bg-rose-50 border border-rose-200 rounded-full flex items-center justify-center mx-auto mb-4">
              <ShieldAlert className="w-8 h-8 text-rose-600" />
            </div>
            <h2 className="text-2xl font-extrabold text-slate-800 tracking-tight">Ошибка</h2>
            <p className="text-rose-700 text-sm leading-relaxed">{message}</p>
            <div className="pt-4">
              <Link
                to="/login"
                className="w-full py-3.5 block bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-600 rounded-xl font-bold text-sm text-center transition duration-200 shadow-md active:scale-[0.98]"
              >
                Вернуться на страницу входа
              </Link>
            </div>
          </div>
        )}
      </AuthCard>
    </AuthLayout>
  );
}
