# Golmar Pi Agent

Runs on the Raspberry Pi connected to the Golmar intercom, Automation HAT and USB audio adapter.

The Pi agent provides HTTP and WebSocket endpoints used by the Scrypted Golmar plugin for:

- doorbell detection;
- door unlock;
- microphone audio from the Golmar intercom to Scrypted/HomeKit;
- speaker audio from Scrypted/HomeKit to the Golmar intercom;
- optional unlock sound playback.

## Endpoints

- `GET /health`
- `GET /doorbell`
- `POST /unlock`
- `GET /mic/ulaw`
- `GET /mic/raw-live`
- `POST /speaker/raw`
- WebSocket on port `8766`

The Scrypted plugin currently uses:

```text
GET  /mic/ulaw
POST /speaker/raw
POST /unlock
ws://<pi-ip-address>:8766
```

## Fresh Raspberry Pi / SD card setup

These steps are intended for a fresh Raspberry Pi OS installation, for example after replacing or rebuilding the SD card.

### 1. Prepare Raspberry Pi OS

Flash Raspberry Pi OS Lite or Raspberry Pi OS with Raspberry Pi Imager.

In Raspberry Pi Imager, configure:

- hostname, for example `Pi02-I`;
- SSH enabled;
- username, for example `pi`;
- Wi-Fi credentials, if not using Ethernet;
- locale and timezone.

After first boot, SSH into the Pi:

```bash
ssh pi@<pi-ip-address>
```

Update the system:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo reboot
```

Reconnect after reboot.

### 2. Raspberry Pi configuration

Open Raspberry Pi configuration:

```bash
sudo raspi-config
```

Recommended settings:

```text
Interface Options:
  SSH: Enabled
  SPI: Enabled
  I2C: Enabled

System Options:
  Audio: select the USB audio adapter if available

Localisation Options:
  Timezone: set your local timezone
```

Reboot after changing interface settings:

```bash
sudo reboot
```

### 3. Install system packages

Install the packages needed for audio, GPIO, Automation HAT and the Pi agent:

```bash
sudo apt update
sudo apt install -y \
  git \
  python3-venv \
  python3-pip \
  ffmpeg \
  alsa-utils \
  gpiod \
  libgpiod-dev \
  python3-libgpiod
```

Check that audio tools are available:

```bash
which ffmpeg
which arecord
which aplay
```

### 4. Clone the repository

```bash
cd ~
git clone https://github.com/rooi/golmar-scrypted-intercom.git
cd ~/golmar-scrypted-intercom/pi-agent
```

### 5. Create the Python virtual environment

Create the virtual environment with system site packages enabled. This helps with Raspberry Pi GPIO libraries that may be installed through apt:

```bash
python3 -m venv .venv --system-site-packages
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

Check the important Python imports:

```bash
python -c "import flask; print('flask ok')"
python -c "import websockets; print('websockets ok')"
python -c "import gpiod; print('gpiod ok')"
python -c "import automationhat; print('automationhat ok')"
```

## USB audio setup

List audio devices:

```bash
arecord -l
aplay -l
```

The USB audio adapter is usually card `1`, device `0`, but this may vary.

Test recording:

```bash
arecord -D plughw:1,0 -f S16_LE -r 8000 -c 1 -d 5 /tmp/test.wav
aplay /tmp/test.wav
```

Test playback through the USB adapter directly:

```bash
speaker-test -D plughw:1,0 -t wav -c 2
```

Set the playback level used for the Golmar audio adapter:

```bash
amixer -M -c 1 sset PCM 71%
```

Optional: open the mixer UI:

```bash
alsamixer -c 1
```

Use `F4` for capture controls and check that the capture input is not muted.

### Optional: set USB audio as default ALSA device

This is optional. The agent can also use explicit ALSA devices in code, but setting a default can make local testing easier.

Create or edit:

```bash
sudo nano /etc/asound.conf
```

Use card `1`, device `0` if that is your USB audio adapter:

```conf
pcm.!default {
    type plug
    slave.pcm "hw:1,0"
}

ctl.!default {
    type hw
    card 1
}
```

Test:

```bash
aplay /usr/share/sounds/alsa/Front_Center.wav
arecord -f S16_LE -r 8000 -c 1 -d 5 /tmp/test.wav
aplay /tmp/test.wav
```

### Optional: persist USB audio volume

Create a systemd service:

```bash
sudo nano /etc/systemd/system/golmar-audio-volume.service
```

Use:

```ini
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

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable golmar-audio-volume.service
sudo systemctl restart golmar-audio-volume.service
```

Check:

```bash
amixer -c 1
```

## Unlock sound

Create the audio directory:

```bash
mkdir -p ~/golmar-scrypted-intercom/pi-agent/audio
```

Copy `unlock.wav` to:

```text
/home/pi/golmar-scrypted-intercom/pi-agent/audio/unlock.wav
```

For example, from a Mac:

```bash
scp unlock.wav pi@<pi-ip-address>:/home/pi/golmar-scrypted-intercom/pi-agent/audio/unlock.wav
```

Check the file:

```bash
ls -l ~/golmar-scrypted-intercom/pi-agent/audio/unlock.wav
aplay ~/golmar-scrypted-intercom/pi-agent/audio/unlock.wav
```

## Install as a systemd service

Create the service file:

```bash
sudo nano /etc/systemd/system/golmar-pi-agent.service
```

Use:

```ini
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

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable golmar-pi-agent.service
sudo systemctl restart golmar-pi-agent.service
```

Check status:

```bash
sudo systemctl status golmar-pi-agent.service --no-pager
journalctl -u golmar-pi-agent.service -n 100 --no-pager
```

Follow the logs:

```bash
journalctl -u golmar-pi-agent.service -f
```

## Local tests on the Pi

### Health

```bash
curl -s http://localhost:8765/health
```

### Doorbell

```bash
curl -s http://localhost:8765/doorbell
```

Press the physical doorbell and watch the logs:

```bash
journalctl -u golmar-pi-agent.service -f
```

A working doorbell press should show something like:

```text
{'type': 'doorbell', 'pressed': True, 'voltage': ..., 'threshold': ...}
Broadcasting doorbell to ... websocket clients
```

### Unlock

Test unlock locally:

```bash
curl -s -X POST http://localhost:8765/unlock
```

A successful unlock should show something like:

```text
HTTP unlock requested
Activating Automation HAT output one
Automation HAT output one off
Unlock completed
Playing unlock sound: /home/pi/golmar-scrypted-intercom/pi-agent/audio/unlock.wav
Unlock sound finished
```

### Automation HAT output test

If the unlock endpoint works in software but the physical lock does not open, test the Automation HAT output directly.

```bash
cd ~/golmar-scrypted-intercom/pi-agent
source .venv/bin/activate
python
```

Then:

```python
import automationhat, time
automationhat.output.one.on()
time.sleep(5)
automationhat.output.one.off()
```

During those 5 seconds, check whether the output LED or relay switches and whether the lock reacts.

If your wiring is not on output one, test all outputs:

```python
import automationhat, time

for output in [automationhat.output.one, automationhat.output.two, automationhat.output.three]:
    output.on()
    time.sleep(3)
    output.off()
    time.sleep(1)
```

## Test from the Scrypted host

From the Scrypted host or another machine on the same network:

```bash
curl -s http://<pi-ip-address>:8765/health
curl -s http://<pi-ip-address>:8765/doorbell
curl -s -X POST http://<pi-ip-address>:8765/unlock
```

The Scrypted plugin should use:

```text
Pi HTTP URL: http://<pi-ip-address>:8765
Pi WebSocket URL: ws://<pi-ip-address>:8766
Mic μ-law URL: http://<pi-ip-address>:8765/mic/ulaw
Speaker raw URL: http://<pi-ip-address>:8765/speaker/raw
```

After starting the Scrypted plugin, the Pi logs should show:

```text
WebSocket client connected
```

Doorbell events are only delivered live to connected WebSocket clients. If the plugin was not connected when the doorbell was pressed, the event can be missed.

## Troubleshooting

### `ModuleNotFoundError: No module named 'flask'`

The Python virtual environment is missing dependencies:

```bash
cd ~/golmar-scrypted-intercom/pi-agent
source .venv/bin/activate
pip install -r requirements.txt
sudo systemctl restart golmar-pi-agent.service
```

### `ModuleNotFoundError: No module named 'gpiod'`

Install GPIO dependencies:

```bash
sudo apt update
sudo apt install -y gpiod libgpiod-dev python3-gpiod
cd ~/golmar-scrypted-intercom/pi-agent
source .venv/bin/activate
pip install gpiod
sudo systemctl restart golmar-pi-agent.service
```

If needed, recreate the virtual environment with system packages enabled:

```bash
cd ~/golmar-scrypted-intercom/pi-agent
rm -rf .venv
python3 -m venv .venv --system-site-packages
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

### `No such file or directory: /home/pi/venvs/automationhat/bin/python`

The code still contains an old hardcoded virtual environment path. The agent should not use `/home/pi/venvs/automationhat`.

Use the current Python executable instead:

```python
import sys
PYTHON = sys.executable
```

Or, preferably, avoid spawning a separate Python process for Automation HAT and import `automationhat` directly inside the agent.

### Unlock sound file not found

Check:

```bash
ls -l ~/golmar-scrypted-intercom/pi-agent/audio/unlock.wav
which aplay
```

Install `aplay` if needed:

```bash
sudo apt install -y alsa-utils
```

### Doorbell works on the Pi but not in Scrypted

Check the Pi logs:

```bash
journalctl -u golmar-pi-agent.service -f
```

If the log says:

```text
Broadcasting doorbell to 0 websocket clients
No WebSocket clients connected; event not delivered
```

then Scrypted was not connected to the Pi WebSocket when the doorbell was pressed. Restart the Scrypted plugin after the Pi agent is running.

### Unlock completes in software but the physical lock does not open

If the log shows:

```text
Activating Automation HAT output one
Automation HAT output one off
Unlock completed
```

then the Pi software path is working.

Check:

- whether the wire is connected to Automation HAT output one;
- whether the correct relay/output is used;
- whether the unlock pulse is long enough;
- whether the lock power supply is present during unlock;
- whether the relay COM/NO wiring is correct.

Manually test output one:

```bash
cd ~/golmar-scrypted-intercom/pi-agent
source .venv/bin/activate
python
```

Then:

```python
import automationhat, time
automationhat.output.one.on()
time.sleep(5)
automationhat.output.one.off()
```

### Audio stream opens but there is no sound

Check whether the Pi produces audio bytes:

```bash
curl --max-time 5 http://localhost:8765/mic/ulaw -o /tmp/golmar.ulaw
ffmpeg -f mulaw -ar 8000 -ac 1 -i /tmp/golmar.ulaw /tmp/golmar.wav
aplay /tmp/golmar.wav
```

If the WAV is silent, check ALSA input and capture levels:

```bash
arecord -l
amixer -c 1
alsamixer -c 1
```

Use `F4` in `alsamixer` to inspect capture controls.

## Notes

- Avoid hardcoded virtual environment paths such as `/home/pi/venvs/automationhat/bin/python` in `agent.py`.
- Prefer paths relative to `agent.py`, for example `Path(__file__).resolve().parent / "audio" / "unlock.wav"`.
- The service name used here is `golmar-pi-agent.service`.
- The USB audio adapter is assumed to be ALSA card `1`, device `0`; verify with `arecord -l` and `aplay -l`.
