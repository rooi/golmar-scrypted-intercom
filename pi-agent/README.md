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

## Install Automation HAT support

The `agent.py` uses the Pimoroni Automation HAT / Automation HAT Mini to control the relay.

Install the Pimoroni Automation HAT Python library on the Raspberry Pi:

```bash
curl -sS https://get.pimoroni.com/automationhat | bash
```

This is the official Pimoroni installer for the Automation HAT, pHAT and HAT Mini Python library. It installs the required Python library and enables the required Raspberry Pi interfaces. See Pimoroni’s getting started guide for reference.

After installation, reboot the Pi:
```
sudo reboot
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
If this works, the Automation HAT is installed correctly.
If you get an import error such as:
```
ModuleNotFoundError: No module named 'automationhat'
```
then the library is not available to the Python interpreter you are using. In that case, either run the Pimoroni installer again, or install the library inside the project virtual environment as described below.


Then I would continue with this:

## Python virtual environment for `agent.py`

The `agent.py` runs separately from Scrypted/Homebridge and uses its own Python virtual environment. This keeps the Python dependencies for the intercom agent isolated from the system Python installation and from other projects on the Pi.

### 1. Go to the project directory

```bash
cd ~/dev/golmar-scrypted-intercom
```

Adjust this path if the repository is located somewhere else.

2. Create the virtual environment
```
python3 -m venv .venv
```
3. Activate the virtual environment
```
source .venv/bin/activate
```
Your shell prompt should now show (.venv).
4. Upgrade pip
```
python -m pip install --upgrade pip
```
5. Install the Python dependencies
If the project contains a requirements.txt file:
```
pip install -r requirements.txt
```
A minimal requirements.txt could look like this:
```
websockets
automationhat
```
Use automationhat here as well if agent.py imports the Automation HAT library directly. This makes the venv self-contained and avoids depending on the system-wide Python installation.
6. Test the Automation HAT from inside the venv
With the venv still active:
```
python - <<'PY'
import automationhat
automationhat.relay.one.on()
print("Relay ON from venv")
automationhat.relay.one.off()
print("Relay OFF from venv")
PY
```
If this works, agent.py should also be able to control the relay from the virtual environment.
7. Start agent.py
```
python agent.py
```
Inside the virtual environment, use python instead of python3. The python command now points to the interpreter inside .venv.
8. Leave the virtual environment
```
deactivate
```

For the `systemd` part, I would make sure it uses the venv directly:

## Run `agent.py` as a systemd service

Create a service file:

```bash
sudo nano /etc/systemd/system/golmar-agent.service
```

Example service:
```
[Unit]
Description=Golmar Intercom Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/dev/golmar-scrypted-intercom
ExecStart=/home/pi/dev/golmar-scrypted-intercom/.venv/bin/python /home/pi/dev/golmar-scrypted-intercom/agent.py
Restart=always
RestartSec=3

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
