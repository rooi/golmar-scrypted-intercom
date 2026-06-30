
# Golmar Scrypted Intercom

Scrypted plugin and Raspberry Pi agent for integrating a Golmar 4+n intercom with HomeKit/Scrypted.

## Current working audio path

- Golmar microphone to Scrypted/Safari/HomeKit: G.711 μ-law via `/mic/ulaw`
- Safari/iPhone microphone to Golmar speaker: raw PCM S16LE 48 kHz mono via `/speaker/raw`
- Door unlock: WebSocket command with HTTP fallback
- Doorbell detection: Automation HAT analog input

AAC/ADTS was tested but is not used because Scrypted RTSP rebroadcasting fails with live AAC streams without global headers.

## Pi agent

Run:

```bash
python agent.py
```

Health check:
```
curl http://<pi-ip>:8765/health
```

Test mic stream:
```
curl http://<pi-ip>:8765/mic/ulaw --output /tmp/golmar.ulaw --max-time 5
ffmpeg -f mulaw -ar 8000 -ac 1 -i /tmp/golmar.ulaw /tmp/golmar.wav
```

# Scrypted settings
Set:
```
Pi Agent Base URL: http://<pi-ip>:8765
Pi Agent WebSocket URL: ws://<pi-ip>:8766
```
