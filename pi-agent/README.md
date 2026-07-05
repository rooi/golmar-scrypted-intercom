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
```

## Installation

```bash
cd ~
git clone https://github.com/rooi/golmar-scrypted-intercom.git
cd ~/golmar-scrypted-intercom/pi-agent

sudo apt update
sudo apt install -y python3-venv python3-pip ffmpeg alsa-utils gpiod libgpiod-dev

python3 -m venv .venv --system-site-packages
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

mkdir -p audio
# copy unlock.wav to ./audio/unlock.wav

sudo cp systemd/golmar-pi-agent.service.example /etc/systemd/system/golmar-pi-agent.service
sudo systemctl daemon-reload
sudo systemctl enable golmar-pi-agent
sudo systemctl restart golmar-pi-agent
```

After reboot, test whether the library can access the relay:
```
python3 - <<'PY'
import automationhat
automationhat.relay.one.on()
print("Relay ON")
PY
```
Turn the relay off again:
```
python3 - <<'PY'
import automationhat
automationhat.relay.one.off()
print("Relay OFF")
PY
```

## Run `agent.py` as a systemd service

Create a service file:

```bash
sudo nano /etc/systemd/system/golmar-agent.service
```

Example service:
```
[Unit]
Description=Golmar Pi Agent
After=network-online.target sound.target
Wants=network-online.target sound.target

[Service]
Type=simple
WorkingDirectory=/home/pi/golmar-scrypted-intercom/pi-agent
ExecStart=/home/pi/golmar-scrypted-intercom/pi-agent/.venv/bin/python /home/pi/golmar-scrypted-intercom/pi-agent/agent.py
Restart=always
RestartSec=3
User=pi
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```
Enable and start the service:
```
sudo systemctl daemon-reload
sudo systemctl enable golmar-agent.service
sudo systemctl start golmar-agent.service
```
Check the service status:
```
systemctl status golmar-agent.service
```
Follow the logs:
```
journalctl -u golmar-agent.service -f
```
## Optional:
USB audio as default:
```
sudo nano /etc/asound.conf
```
asound.conf
```
pcm.!default {
    type plug
    slave.pcm "hw:1,0"
}

ctl.!default {
    type hw
    card 1
}
```

service to set default volume
```
[Unit]
Description=Set Golmar USB audio volume
After=alsa-restore.service sound.target multi-user.target
Wants=sound.target

[Service]
Type=oneshot
ExecStartPre=/bin/sleep 30
ExecStart=/usr/bin/amixer -M -c 1 sset PCM 71%

[Install]
WantedBy=multi-user.target
```
