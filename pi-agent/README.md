# Golmar Pi Agent

Runs on the Raspberry Pi connected to the Golmar intercom and USB audio adapter.

## Endpoints

- `GET /health`
- `POST /unlock`
- `POST /speaker/raw`
- `GET /mic/ulaw`
- `GET /mic/raw-live`

## Working microphone stream

The Scrypted plugin currently uses:

```text
GET /mic/ulaw
