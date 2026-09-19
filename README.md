# BKT Messenger — PostgreSQL / Render

Мессенджер теперь использует PostgreSQL вместо SQLite.

## Render

1. Создайте **PostgreSQL** в Render.
2. Создайте Web Service для этого проекта.
3. В Environment Variables добавьте:
   - `DATABASE_URL` — Internal Database URL из Render PostgreSQL.
   - `JWT_SECRET` — длинная случайная строка.
   - `VAPID_SUBJECT` — например `mailto:admin@example.com`.
   - `ADMIN_USER_ID` — ID администратора, если нужна выдача верификации.
   - `NODE_ENV=production`.
4. Build Command: `npm install`
5. Start Command: `npm start`

Таблицы PostgreSQL создаются автоматически при запуске. SQLite (`better-sqlite3`) больше не используется.

### Важно про файлы

PostgreSQL сохраняет аккаунты, профили, сообщения, группы, звонки и push-подписки между перезапусками Render. Загруженные аватары и медиа по-прежнему лежат в локальной файловой системе сервиса; на Render для их долговременного хранения нужен persistent disk или объектное хранилище (S3/R2 и т.п.).
