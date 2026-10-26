# FS Voice

MVP Алиса → HTTPS handler → private Google Sheets.

## Local tests

Node.js 20+: `npm install && npm test`.

## Environment

`SPREADSHEET_ID`, `ALLOWED_ALICE_USER_IDS` (comma-separated). Google Application Default Credentials / service account. Never commit credentials. Share the private spreadsheet with the service-account email as Viewer.

`TARGETS_JSON_URL` optional, defaults to public FS data.json. Exact goals from Settings (`Цель калорий`, `Цель белка`, `Цель жиров`, `Цель углеводов`) take precedence; min/max are not treated as exact goals.

## Run locally

`RUN_HTTP_SERVER=1 npm start`, POST Alice Dialogs JSON to `/alice`.

## Deployment status

Not deployed. Yandex Cloud Function HTTP event compatibility, webhook request authentication, private skill access and response deadlines must be validated before production. Do not treat `ALLOWED_ALICE_USER_IDS` alone as cryptographic webhook authentication. The prototype should not be made public before those checks.
