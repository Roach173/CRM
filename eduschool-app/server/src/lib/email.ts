import { Resend } from 'resend';
import { createLogger } from './logger';

const log = createLogger('email');
const resend = new Resend(process.env.RESEND_API_KEY || 're_dummy');
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

export const sendVerificationEmail = async (email: string, token: string) => {
  const verifyLink = `${CLIENT_URL}/verify-email?token=${token}`;
  if (process.env.NODE_ENV === 'development') {
    // Dev bypass: the full link (with live token) is intentional — the developer must click it.
    log.info({ email, verifyLink }, 'development mode: email sending bypassed (verification)');
    return { success: true, data: { id: 'dev_mock_id', verifyLink } };
  }

  try {
    const data = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: 'Подтвердите ваш email - Shamdan',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Добро пожаловать в Shamdan!</h2>
          <p>Пожалуйста, подтвердите ваш email адрес, перейдя по ссылке ниже:</p>
          <div style="margin: 30px 0;">
            <a href="${verifyLink}" style="background-color: #0f172a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Подтвердить Email</a>
          </div>
          <p>Ссылка действительна 24 часа.</p>
          <p style="color: #666; font-size: 14px;">Если вы не регистрировались на нашей платформе, просто проигнорируйте это письмо.</p>
        </div>
      `,
    });
    return { success: true, data };
  } catch (error) {
    log.error({ err: error, email }, 'failed to send verification email');
    return { success: false, error };
  }
};

export const sendWelcomeEmail = async (email: string, firstName: string, schoolName: string, slug: string) => {
  const loginLink = `${CLIENT_URL}/${slug}/login`;
  if (process.env.NODE_ENV === 'development') {
    log.info({ email, schoolName }, 'development mode: welcome email bypassed');
    return { success: true };
  }
  try {
    const data = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: `Добро пожаловать в Shamdan — ${schoolName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Привет, ${firstName}!</h2>
          <p>Ваша школа <strong>${schoolName}</strong> зарегистрирована. У вас 7 дней бесплатного пробного периода.</p>
          <div style="margin: 30px 0;">
            <a href="${loginLink}" style="background-color: #2D6A4F; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Войти в панель</a>
          </div>
          <p style="color: #666; font-size: 14px;">Если у вас есть вопросы — пишите в поддержку.</p>
        </div>
      `,
    });
    return { success: true, data };
  } catch (error) {
    log.error({ err: error, email }, 'failed to send welcome email');
    return { success: false, error };
  }
};

export const sendInvoiceEmail = async (
  email: string,
  invoiceData: { amount: number; dueDate: string; invoiceId: number; schoolName: string }
) => {
  if (process.env.NODE_ENV === 'development') {
    log.info({ email, invoiceId: invoiceData.invoiceId }, 'development mode: invoice email bypassed');
    return { success: true };
  }
  try {
    const data = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: `Счёт #${invoiceData.invoiceId} — ${invoiceData.schoolName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Новый счёт на оплату</h2>
          <p>Школа <strong>${invoiceData.schoolName}</strong> выставила счёт на сумму <strong>${invoiceData.amount} сом</strong>.</p>
          <p>Срок оплаты: ${invoiceData.dueDate}</p>
          <p style="color: #666; font-size: 14px;">Свяжитесь со школой для уточнения деталей оплаты.</p>
        </div>
      `,
    });
    return { success: true, data };
  } catch (error) {
    log.error({ err: error, email }, 'failed to send invoice email');
    return { success: false, error };
  }
};

export const sendPasswordResetEmail = async (email: string, token: string) => {
  const resetLink = `${CLIENT_URL}/reset-password?token=${token}`;
  if (process.env.NODE_ENV === 'development') {
    // Dev bypass: the full link (with live token) is intentional — the developer must click it.
    log.info({ email, resetLink }, 'development mode: email sending bypassed (password reset)');
    return { success: true, data: { id: 'dev_mock_id', resetLink } };
  }

  try {
    const data = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: 'Сброс пароля - Shamdan',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Сброс пароля</h2>
          <p>Вы запросили сброс пароля для вашего аккаунта. Пожалуйста, перейдите по ссылке ниже, чтобы установить новый пароль:</p>
          <div style="margin: 30px 0;">
            <a href="${resetLink}" style="background-color: #0f172a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Сбросить пароль</a>
          </div>
          <p>Ссылка действительна 1 час.</p>
          <p style="color: #666; font-size: 14px;">Если вы не запрашивали сброс пароля, проигнорируйте это письмо.</p>
        </div>
      `,
    });
    return { success: true, data };
  } catch (error) {
    log.error({ err: error, email }, 'failed to send password reset email');
    return { success: false, error };
  }
};

export const sendStaffInviteEmail = async (
  email: string,
  inviteLink: string,
  schoolName: string,
  role: string,
  expiresInDays = 7
) => {
  const roleLabels: Record<string, string> = {
    ADMIN: 'Администратор',
    TEACHER: 'Преподаватель',
  };
  const roleLabel = roleLabels[role] || role;

  if (process.env.NODE_ENV === 'development') {
    // Dev bypass: the full link (with live token) is intentional — the developer must click it.
    log.info({ email, schoolName, role: roleLabel, inviteLink }, 'development mode: staff invite email bypassed');
    return { success: true, data: { id: 'dev_mock_invite_id', inviteLink } };
  }

  try {
    const data = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: `Приглашение в школу ${schoolName} — Shamdan`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
          <h2 style="color: #0f172a; margin-bottom: 16px;">Вас пригласили в Shamdan!</h2>
          <p style="color: #334155; font-size: 16px; line-height: 1.5; margin-bottom: 24px;">
            Администрация школы <strong>${schoolName}</strong> приглашает вас присоединиться к платформе в роли <strong>${roleLabel}</strong>.
          </p>
          <div style="margin: 30px 0; text-align: left;">
            <a href="${inviteLink}" style="background-color: #2D6A4F; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 14px; display: inline-block; box-shadow: 0 4px 6px -1px rgba(45, 106, 79, 0.1), 0 2px 4px -1px rgba(45, 106, 79, 0.06);">
              Принять приглашение
            </a>
          </div>
          <p style="color: #64748b; font-size: 13px; line-height: 1.5; margin-top: 32px; border-top: 1px solid #e2e8f0; padding-top: 16px;">
            Ссылка действительна в течение <strong>${expiresInDays} дней</strong>.
          </p>
          <p style="color: #94a3b8; font-size: 12px; line-height: 1.5;">
            Если вы получили это письмо по ошибке или не ожидали его, просто проигнорируйте его.
          </p>
        </div>
      `,
    });
    return { success: true, data };
  } catch (error) {
    log.error({ err: error, email }, 'failed to send staff invite email');
    return { success: false, error };
  }
};
