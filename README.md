# BKT Messenger — protected accounts

Protected accounts in this build:
- `Brozi` — requires its special access code.
- `Vlad` — requires `VladBKT69102937!!!`.
- `vladmobile` — requires `VladBKT69102937!!!`.

Protection is checked on the server for login, registration, and profile rename. The access codes themselves are not stored in the project; only salted scrypt hashes are stored in `protected-access.json`.

For `Vlad` and `vladmobile`, the same special code is used as requested.

Run:
```bash
npm install
npm start
```
