# PM2 Resource Dashboard

Express + React dashboard for host CPU/RAM, PM2 process CPU/RAM, and network bandwidth. No database is used; login credentials, thresholds, SMTP, and refresh timing are read from `.env`.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in development. The Vite dev server proxies `/api` requests to Express on `http://localhost:4000`.

For a production-style run:

```bash
npm run build
npm start
```

Open `http://localhost:4000`.

## Configure

Copy `.env.example` to `.env` and update:

- `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` for login.
- `APP_SECRET` to a long random value for signed auth cookies.
- `NETWORK_INTERFACE` to `*` for all interfaces or a specific interface name.
- `ALERT_CPU_THRESHOLD_PERCENT` and `ALERT_RAM_THRESHOLD_PERCENT` for PM2 process alerts.
- `ALERT_COOLDOWN_MINUTES` to avoid repeated emails for the same process.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, and `EMAIL_TO` for email delivery.
- `PM2_HOME` only if PM2 uses a non-default home directory.

The dashboard refresh interval is controlled by `DASHBOARD_REFRESH_SECONDS`, defaulting to 60 seconds. Alert checks are server-side and continue even when nobody is viewing the dashboard.
