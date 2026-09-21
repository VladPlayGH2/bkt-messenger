# TURN для звонков БКТ Messenger

TURN нельзя надёжно разместить внутри обычного Render Web Service: ему нужны UDP-порты и диапазон relay-портов. Поэтому приложение на Render получает временные TURN credentials, а coturn работает на отдельном VPS с публичным IPv4.

## 1. VPS

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install coturn
```

Скопируйте `turnserver.conf.example` в `/etc/turnserver.conf` и замените:

- `CHANGE_ME_TO_THE_SAME_TURN_SECRET_AS_RENDER` на длинный случайный секрет;
- `turn.example.com` на ваш домен (или IP, если DNS не используется).

Откройте firewall:

- UDP/TCP 3478
- UDP 49152-65535

Запустите:

```bash
sudo systemctl enable coturn
sudo systemctl restart coturn
sudo systemctl status coturn
```

## 2. Render

В Web Service добавьте секретные переменные:

- `TURN_HOST=turn.example.com`
- `TURN_SECRET=<тот же секрет, что в coturn>`
- `TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349` (если настроите TLS)

После этого `/api/rtc-config` выдаёт каждому авторизованному пользователю credentials примерно на 6 часов. Секрет TURN не попадает в браузер.

## 3. TLS (рекомендуется)

Для `turns:` настройте сертификат Let's Encrypt в coturn и добавьте:

```conf
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
listening-port=3478
tls-listening-port=5349
```

Откройте TCP/UDP 5349 и оставьте `turns:turn.example.com:5349` в `TURN_URLS`.

### Важно

TURN повышает совместимость звонков, но абсолютную гарантию 100% дать нельзя: устройство, браузер, разрешения, VPN, firewall и качество сети всё равно могут мешать звонку.
