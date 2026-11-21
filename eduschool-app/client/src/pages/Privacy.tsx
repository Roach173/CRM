export default function Privacy() {
  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-serif text-textPrimary mb-2">Политика конфиденциальности</h1>
        <p className="text-sm text-textSecondary mb-10">Последнее обновление: май 2026</p>

        <div className="prose prose-sm text-textPrimary space-y-8">
          <section>
            <h2 className="text-lg font-semibold mb-2">1. Какие данные мы собираем</h2>
            <p className="text-textSecondary leading-relaxed">
              Мы собираем данные, которые вы предоставляете при регистрации: имя, фамилию, адрес электронной почты, номер телефона. В процессе использования платформы — данные об учебном процессе (расписание, посещаемость, оценки).
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">2. Как мы используем данные</h2>
            <p className="text-textSecondary leading-relaxed">
              Данные используются исключительно для функционирования платформы: идентификация пользователей, хранение учебных записей, отправка уведомлений. Мы не продаём и не передаём ваши данные третьим лицам без вашего согласия.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">3. Хранение данных</h2>
            <p className="text-textSecondary leading-relaxed">
              Данные хранятся на защищённых серверах. Мы принимаем технические и организационные меры для защиты данных от несанкционированного доступа.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">4. Ваши права</h2>
            <p className="text-textSecondary leading-relaxed">
              Вы вправе запросить копию своих данных, потребовать их исправления или удаления. Для этого обратитесь в поддержку через Telegram.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">5. Cookies</h2>
            <p className="text-textSecondary leading-relaxed">
              Мы используем localStorage для хранения токена авторизации. Сторонние cookie не используются.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">6. Контакты</h2>
            <p className="text-textSecondary leading-relaxed">
              По вопросам конфиденциальности: <a href="https://t.me/eduschool_support" className="text-primary hover:underline">@eduschool_support</a>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
