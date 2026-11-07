# vergecurrency.network

A public Verge mining dashboard for Scrypt, Groestl, Lyra2RE, X17, and Blake2s.
It displays algorithm hashrate and difficulty with a responsive retrowave
interface, connected neon charts, date controls, CSV export, and a public API.
The website has no accounts or admin login.

built by https://github.com/justinvforvendetta

## Requirements

- [Node.js](https://nodejs.org/en/download) 22.12 or newer and npm. Tested with
  Node 22.22.1; `.nvmrc` selects Node 24 for users of nvm.
- A synchronized [Verge daemon](https://github.com/vergecurrency/verge/releases)
  exposing its RPC interface locally, normally on `127.0.0.1:20102`.
- [InfluxDB OSS 1.x](https://docs.influxdata.com/influxdb/v1/introduction/install/)
  with the InfluxQL HTTP API, normally on `127.0.0.1:8086`, and a `verge`
  database. The application is not configured for the InfluxDB 2/3 APIs.
- Nginx and an HTTPS certificate for a public production deployment. Example
  systemd units are included for Linux servers.

There are no external npm runtime dependencies and no frontend build step.
The preview below works without a daemon or database. Live data requires both.

## Install and preview

```bash
git clone https://github.com/vergecurrency/vergecurrency.network.git
cd vergecurrency.network
npm ci --ignore-scripts
npm test
npm run preview:web
```

Open `http://127.0.0.1:3001` on the same computer. Preview mode is clearly
labelled and uses generated sample data. Stop it with Ctrl+C before starting
the live web server on the same port.

## Configure live data

Run the daemon and InfluxDB on the same host as the application. The collector
uses `getinfo` and `getallnetworkhashps`; no transaction index is required.

Reuse an existing `verge` database if one is already present. On a new local
InfluxDB installation without authentication enabled, create it with:

```bash
curl -fsS -X POST http://127.0.0.1:8086/query \
  --data-urlencode 'q=CREATE DATABASE "verge"'
```

If database authentication is enabled, create the database with an authenticated
administrative client instead. The collector needs READ and WRITE on `verge`
for checks and collection; the public web reader can use a separate READ-only
account. Existing database files and historical backups are not part of this
repository.

Create your private settings file as the account that will run the app:

```bash
umask 077
cp .env.example .env
chmod 600 .env
nano .env
```

For cookie authentication, set the actual absolute path to the running daemon's
cookie. The path below is a placeholder: replace it with the cookie in your
daemon's configured data directory.

```ini
VERGE_RPC_URL=http://127.0.0.1:20102
VERGE_RPC_COOKIE_FILE=/path/to/daemon/.cookie
INFLUX_URL=http://127.0.0.1:8086
WEB_HOST=127.0.0.1
WEB_PORT=3001
COLLECT_INTERVAL_MS=60000
RPC_TIMEOUT_MS=15000
INFLUX_TIMEOUT_MS=15000
```

Use absolute paths; `.env` values are not shell commands and do not expand `~`.
The application account must be able to read the cookie. Do not make it public.
Cookie contents are reread when the daemon rotates them.

If using RPC username/password authentication instead, set `VERGE_RPC_USER`
and `VERGE_RPC_PASSWORD` privately, or copy `credentials.example.json` to
`credentials.json` and fill in the accepted login. For `rpcauth`, clients use
the original password, not its stored salt/hash string.

Optional InfluxDB settings in `.env`:

| Variable | Purpose |
| --- | --- |
| `INFLUX_USERNAME`, `INFLUX_PASSWORD` | Collector database credentials; also the reader fallback. |
| `INFLUX_READ_USERNAME`, `INFLUX_READ_PASSWORD` | Dedicated READ-only web-reader credentials. |
| `VERGE_CREDENTIALS_FILE` | Alternate private RPC credential-file path. |

Never commit `.env`, `credentials.json`, cookie files, private keys, or database
backups. The included example files contain placeholders only.

## Run with real data

Check the connections without writing samples:

```bash
node --env-file=.env src/index.js --check
```

Run the collector in one terminal:

```bash
node --env-file=.env src/index.js
```

Run the website in another terminal:

```bash
npm run start:web
```

The collector writes algorithm samples every minute. The web server reads the
database and listens on `http://127.0.0.1:3001`. With Auto refresh enabled, an
open, visible dashboard refreshes every minute. Historical custom ranges stay
fixed unless you select a current period again.

`npm start` also starts the collector, but it expects its settings in the process
environment or `credentials.json`. Use the explicit `--env-file` commands above
when relying on `.env` for collector settings.

The collector and web reader are separate processes: starting only the website
does not collect new samples. A healthy `/api/health` response confirms the web
process, not data freshness. A delayed status means the latest recorded sample
is more than three minutes old.

## Run as services on Linux

The supplied units are templates using a placeholder service account `username`, an
example installation directory `/opt/vergecurrency.network`, and Node at
`/usr/bin/node`. These values are examples, not information about the public
site's deployment.

Choose or create an unprivileged service account and place the checkout in your
chosen installation directory. The account must be able to read the project,
its private `.env`, and the daemon cookie when used. Check `command -v node`,
then edit `User`, `Group`, `WorkingDirectory`, `EnvironmentFile`, and `ExecStart`
in both service templates to match your own installation before installing them.

Stop any foreground copies of the app, then install the units:

```bash
sudo install -m 644 deploy/verge-dashboard.service /etc/systemd/system/verge-dashboard.service
sudo install -m 644 deploy/verge-network-ui.service /etc/systemd/system/verge-network-ui.service
sudo systemctl daemon-reload
sudo systemctl enable --now verge-dashboard verge-network-ui
```

Both services load the private `.env`. After changing settings or uploading
source/assets, restart the corresponding service:

```bash
sudo systemctl restart verge-dashboard verge-network-ui
sudo journalctl -u verge-dashboard -n 30 --no-pager
sudo journalctl -u verge-network-ui -n 30 --no-pager
```

Successful collection logs `[general] Wrote points to database.` every minute.

## Put the website behind Nginx

Configure Nginx for your domain and HTTPS certificate. Inside the site's HTTPS
server block, use the location from
[`deploy/nginx-network-ui.conf.example`](deploy/nginx-network-ui.conf.example).
It forwards requests to `http://127.0.0.1:3001` and sets the real-client-IP header
used by the application rate limiter. Preserve existing certificate and HTTP
redirect settings. For a new host, finish your normal Nginx/HTTPS setup before
making the site public.

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -fsS http://127.0.0.1:3001/api/health
```

The public host should now show the dashboard. Hard-refresh the browser after
uploading frontend changes. The Node server preloads its public assets, so
restart `verge-network-ui` after replacing those files.

Keep Verge RPC, InfluxDB, and the Node server bound to loopback. Merge the
setting in `deploy/influxdb-loopback.conf.example` into the existing InfluxDB
configuration if needed. Only Nginx should expose the public website. Do not
point an Nginx `root` or `alias` at the project directory or any database/config
directory. The application serves an explicit allowlist of public assets.

## Rebuild missing history

The backfill command loads `.env` automatically and previews without writing:

```bash
npm run backfill -- --days 30 --dry-run
npm run backfill -- --days 30 --write
```

It reconstructs algorithm difficulty and estimated hashrate from historical
block headers and RPC estimates. Defaults are five-minute snapshots, with
`source=backfill` tags. Existing intervals are preserved separately for each
metric; rerun the same dates and interval to resume after an interruption.

The newest ten minutes and six blocks are excluded. Backfill uses blockchain
median time, so it cannot reproduce the original collector's exact observation
times. Keep the regular collector running for current samples. To catch a
recent gap fully, rerun after that gap has aged beyond the safety margin.

For one-minute snapshots or fixed UTC dates:

```bash
npm run backfill -- --days 30 --interval-minutes 1 --write
npm run backfill -- --from 2026-10-01T00:00:00Z --to 2026-11-01T00:00:00Z --write
npm run backfill -- --help
```

The maximum is 366 days and 100,000 intervals per run. Large runs may take tens
of minutes or longer; use your usual persistent terminal session. If a busy
daemon exceeds the per-request timeout, try:

```bash
RPC_TIMEOUT_MS=120000 npm run backfill -- --days 30 --dry-run
```

## Public API and chart data

- `/api` provides the public reference page, examples, and request builder.
- `GET /api/dashboard` returns hashrate and difficulty for all five algorithms.
- `GET /api/health` reports web-process availability.

No API key is needed. Dates use `from` and `to` ISO UTC values together; grouping
uses `bucket=auto|hour|day|month`. Hourly ranges support up to 31 days, daily up
to 744 days, and monthly/auto up to 20 years. Calendar-month averages are
weighted by sample counts. Chart timestamps are Unix milliseconds and missing
values remain `null`.

Hashrate fields are `scrypt`, `groestl`, `lyra2re`, `x17`, and `blake2s`.
Difficulty uses the same names except `blake` replaces `blake2s`. Only the
`hashpower` and `difficulty` measurements in `verge` are used.

The chart endpoint allows 12 requests per client IP per 10-second window,
limits concurrent distinct range loads to four per app process, validates
parameters, and caches identical responses for 30 seconds. The API has no
public write, raw-query, daemon RPC, or backfill endpoint. Nginx traffic limits
and upstream flood protection are separate deployment concerns.

## License

MIT. See [LICENSE](LICENSE) for the retained VergeCurrency copyright and license.
