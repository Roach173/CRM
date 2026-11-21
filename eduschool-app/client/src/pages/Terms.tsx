export default function Terms() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-serif text-textPrimary mb-2">Условия использования</h1>
        <p className="text-sm text-textSecondary mb-10">Последнее обновление: май 2026</p>

        <div className="prose prose-sm text-textPrimary space-y-8">
          <section>
            <h2 className="text-lg font-semibold mb-2">1. Общие положения</h2>
            <p className="text-textSecondary leading-relaxed">
              Настоящие Условия использования регулируют доступ и использование платформы Shamdan. Регистрируясь и используя сервис, вы принимаете эти условия в полном объёме.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">2. Описание сервиса</h2>
            <p className="text-textSecondary leading-relaxed">
              Shamdan — SaaS-платформа для управления языковыми школами: расписание, учёт посещаемости, управление студентами и преподавателями, финансовый учёт.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">3. Пробный период и оплата</h2>
            <p className="text-textSecondary leading-relaxed">
              Новые школы получают 30-дневный бесплатный пробный период. По истечении пробного периода для продолжения работы необходимо оформить подписку. Оплата производится вручную через Kaspi или банковский перевод.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">4. Ответственность сторон</h2>
            <p className="text-textSecondary leading-relaxed">
              Пользователь несёт ответственность за достоверность данных, введённых в систему. Shamdan не несёт ответственности за ущерб, возникший вследствие неправомерного использования платформы третьими лицами по вине пользователя.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">5. Конфиденциальность</h2>
            <p className="text-textSecondary leading-relaxed">
              Обработка персональных данных осуществляется в соответствии с нашей <a href="/privacy" className="text-primary hover:underline">Политикой конфиденциальности</a>.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">6. Изменение условий</h2>
            <p className="text-textSecondary leading-relaxed">
              Мы вправе изменять настоящие Условия. Об изменениях мы уведомим вас по электронной почте не менее чем за 14 дней до вступления изменений в силу.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">7. Контакты</h2>
            <p className="text-textSecondary leading-relaxed">
              Вопросы по условиям использования: <a href="https://t.me/eduschool_support" className="text-primary hover:underline">@eduschool_support</a>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
