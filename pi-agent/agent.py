#!/usr/bin/env python3

import asyncio
import json
import subprocess
import threading
import time

from flask import Flask, jsonify, request, Response

import websockets


PYTHON = "/home/pi/venvs/automationhat/bin/python"

HTTP_PORT = 8765
WS_PORT = 8766

doorbell_pressed = False
doorbell_voltage = 0.0

# Deze waarde werkte bij jou blijkbaar al.
# Eventueel later tunen als hij te gevoelig of juist niet gevoelig genoeg is.
doorbell_threshold = 0.25

clients = set()

app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        "name": "golmar-pi-agent",
        "http_port": HTTP_PORT,
        "ws_port": WS_PORT,
        "doorbell": doorbell_pressed,
        "voltage": doorbell_voltage,
        "threshold": doorbell_threshold,
    })


@app.post("/unlock")
def unlock_http():
    try:
        unlock_door()
        return jsonify({
            "ok": True,
            "action": "unlock",
        })
    except Exception as e:
        return jsonify({
            "ok": False,
            "action": "unlock",
            "error": str(e),
        }), 500


def unlock_door():
    """
    Open deur via Automation HAT output one.

    Let op:
    Dit gebruikt bewust de Python uit de automationhat-venv.
    Daarmee voorkom je importproblemen als dit hoofdscript buiten de venv draait.
    """
    print("Activating Automation HAT output one", flush=True)

    subprocess.run([
        PYTHON,
        "-c",
        (
            "import automationhat, time; "
            "automationhat.output.one.on(); "
            "time.sleep(1); "
            "automationhat.output.one.off()"
        )
    ], check=True)

    print("Automation HAT output one off", flush=True)



SPEAKER_DEVICE = "plughw:1,0"
SPEAKER_RATE = "48000"
SPEAKER_CHANNELS = "1"

MIC_DEVICE = "plughw:1,0"
MIC_INPUT_RATE = "44100"
MIC_INPUT_CHANNELS = "2"

MIC_OUTPUT_RATE = "48000"
MIC_OUTPUT_CHANNELS = "1"

@app.route("/speaker/raw", methods=["POST", "PUT"])
def speaker_raw():
    """
    Ontvang raw PCM audio en speel af via USB audio.

    Verwacht:
    - signed 16-bit little endian
    - mono
    - 8000 Hz
    """
    print("Speaker raw stream started", flush=True)

    process = subprocess.Popen([
        "aplay",
        "-D", SPEAKER_DEVICE,
        "-f", "S16_LE",
        "-r", SPEAKER_RATE,
        "-c", SPEAKER_CHANNELS,
    ], stdin=subprocess.PIPE)

    try:
        while True:
            chunk = request.stream.read(4096)
            if not chunk:
                break

            process.stdin.write(chunk)
            process.stdin.flush()

    except BrokenPipeError:
        print("Speaker raw stream broken pipe", flush=True)

    except Exception as e:
        print("Speaker raw stream error:", e, flush=True)

    finally:
        try:
            if process.stdin:
                process.stdin.close()
        except Exception:
            pass

        try:
            process.terminate()
        except Exception:
            pass

        print("Speaker raw stream ended", flush=True)

    return jsonify({
        "ok": True,
        "type": "speaker_raw",
    })

@app.get("/mic/raw")
def mic_raw():
    """
    Stream raw PCM audio vanaf USB audio input.

    Output:
    - signed 16-bit little endian
    - mono
    - 48000 Hz
    """
    print("Mic raw stream requested", flush=True)

    def generate():
        process = subprocess.Popen([
            "arecord",
            "-D", MIC_DEVICE,
            "-f", "S16_LE",
            "-r", MIC_RATE,
            "-c", MIC_CHANNELS,
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        print("arecord started for mic raw stream", flush=True)

        try:
            while True:
                chunk = process.stdout.read(4096)
                if not chunk:
                    break
                yield chunk

        except GeneratorExit:
            print("Mic raw client disconnected", flush=True)

        except Exception as e:
            print("Mic raw stream error:", e, flush=True)

        finally:
            try:
                process.terminate()
            except Exception:
                pass

            try:
                process.wait(timeout=1)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass

            print("arecord stopped for mic raw stream", flush=True)

    return Response(generate(), mimetype="application/octet-stream")

@app.get("/mic/aac")
def mic_aac():
    """
    Stream mic audio als AAC ADTS.

    Capture:
    - ALSA plughw:1,0
    - 44100 Hz stereo
    - rechterkanaal c1

    Output:
    - AAC LC
    - mono
    - 48000 Hz
    - ADTS container
    """
    print("Mic AAC stream requested", flush=True)

    def generate():
        process = subprocess.Popen([
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "warning",
            "-nostdin",

            "-f", "alsa",
            "-sample_fmt", "s16",
            "-ac", "2",
            "-ar", "44100",
            "-i", "plughw:1,0",

            "-vn",
            "-af", "pan=mono|c0=c1,highpass=f=300,lowpass=f=3400,volume=15,alimiter=limit=0.85",

            "-acodec", "aac",
            "-profile:a", "aac_low",
            "-b:a", "64k",
            "-ac", "1",
            "-ar", "48000",
            "-f", "adts",
            "pipe:1",
        ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

        print("ffmpeg started for mic AAC stream", flush=True)

        try:
            while True:
                chunk = process.stdout.read(1024)
                if not chunk:
                    break
                yield chunk

        except GeneratorExit:
            print("Mic AAC client disconnected", flush=True)

        except Exception as e:
            print("Mic AAC stream error:", e, flush=True)

        finally:
            try:
                process.terminate()
            except Exception:
                pass

            try:
                process.wait(timeout=1)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass

            print("ffmpeg stopped for mic AAC stream", flush=True)

    return Response(generate(), mimetype="audio/aac")

@app.get("/mic/ulaw")
def mic_ulaw():
    """
    Stream mic audio als G.711 μ-law / PCMU.

    Capture:
    - ALSA plughw:1,0
    - 44100 Hz
    - stereo, gelijk aan arecord -f cd

    Output:
    - μ-law
    - mono
    - 8000 Hz

    Dit is RTSP-vriendelijker dan live AAC/ADTS.
    """
    print("Mic μ-law stream requested", flush=True)

    def generate():
        process = subprocess.Popen([
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "warning",
            "-nostdin",

            "-fflags", "nobuffer",
            "-flags", "low_delay",
            "-probesize", "32",
            "-analyzeduration", "0",

            "-f", "alsa",
            "-sample_fmt", "s16",
            "-ac", "2",
            "-ar", "44100",
            "-thread_queue_size", "8",
            "-i", "plughw:1,0",

            "-vn",
            "-af", "pan=mono|c0=c1,highpass=f=300,lowpass=f=3400,volume=30,alimiter=limit=0.85",

            "-acodec", "pcm_mulaw",
            "-ac", "1",
            "-ar", "8000",
            "-f", "mulaw",
            "pipe:1",
        ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        print("ffmpeg started for mic μ-law stream", flush=True)

        try:
            while True:
                chunk = process.stdout.read(1024)
                if not chunk:
                    break
                yield chunk

        except GeneratorExit:
            print("Mic μ-law client disconnected", flush=True)

        except Exception as e:
            print("Mic μ-law stream error:", e, flush=True)

        finally:
            try:
                process.terminate()
            except Exception:
                pass

            try:
                process.wait(timeout=1)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass

            print("ffmpeg stopped for mic μ-law stream", flush=True)

    return Response(generate(), mimetype="audio/basic")

@app.get("/mic/alaw")
def mic_alaw():
    """
    Stream mic audio als G.711 A-law / PCMA.

    Output:
    - A-law
    - mono
    - 8000 Hz
    """
    print("Mic A-law stream requested", flush=True)

    def generate():
        process = subprocess.Popen([
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "warning",
            "-nostdin",

            "-f", "alsa",
            "-sample_fmt", "s16",
            "-ac", "2",
            "-ar", "44100",
            "-i", "plughw:1,0",

            "-vn",
            "-af", "pan=mono|c0=c1,highpass=f=300,lowpass=f=3400,volume=30,alimiter=limit=0.85",

            "-acodec", "pcm_alaw",
            "-ac", "1",
            "-ar", "8000",
            "-f", "alaw",
            "pipe:1",
        ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

        print("ffmpeg started for mic A-law stream", flush=True)

        try:
            while True:
                chunk = process.stdout.read(1024)
                if not chunk:
                    break
                yield chunk

        except GeneratorExit:
            print("Mic A-law client disconnected", flush=True)

        except Exception as e:
            print("Mic A-law stream error:", e, flush=True)

        finally:
            try:
                process.terminate()
            except Exception:
                pass

            try:
                process.wait(timeout=1)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass

            print("ffmpeg stopped for mic A-law stream", flush=True)

    return Response(generate(), mimetype="audio/basic")

@app.get("/mic/opus")
def mic_opus():
    """
    Stream mic audio als Opus.

    Capture:
    - ALSA plughw:1,0
    - 44100 Hz
    - stereo, zoals arecord -f cd

    Output:
    - Opus
    - mono
    - 48000 Hz
    - Ogg container
    """
    print("Mic Opus stream requested", flush=True)

    def generate():
        process = subprocess.Popen([
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "warning",
            "-nostdin",

            "-f", "alsa",
            "-sample_fmt", "s16",
            "-ac", "2",
            "-ar", "44100",
            "-i", "plughw:1,0",

            "-vn",

            "-af", "pan=mono|c0=c1,highpass=f=300,lowpass=f=3400,volume=30,alimiter=limit=0.85",

            "-acodec", "libopus",
            "-application", "voip",
            "-b:a", "24k",
            "-vbr", "off",
            "-frame_duration", "20",
            "-ac", "1",
            "-ar", "48000",
            "-f", "ogg",
            "pipe:1",
        ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

        print("ffmpeg started for mic Opus stream", flush=True)

        try:
            while True:
                chunk = process.stdout.read(4096)
                if not chunk:
                    break
                yield chunk

        except GeneratorExit:
            print("Mic Opus client disconnected", flush=True)

        except Exception as e:
            print("Mic Opus stream error:", e, flush=True)

        finally:
            try:
                process.terminate()
            except Exception:
                pass

            try:
                process.wait(timeout=1)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass

            print("ffmpeg stopped for mic Opus stream", flush=True)

    return Response(generate(), mimetype="audio/ogg")

@app.get("/mic/wav")
def mic_wav():
    """
    Stream mic audio als WAV.

    Capture:
    - Behringer/USB input via plughw:1,0
    - 44100 Hz stereo, zoals arecord -f cd
    - alleen rechterkanaal wordt gebruikt: pan=mono|c0=c1

    Output:
    - WAV
    - mono
    - 48000 Hz
    """
    print("Mic WAV stream requested", flush=True)

    def generate():
        process = subprocess.Popen([
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "warning",
            "-nostdin",

            "-f", "alsa",
            "-sample_fmt", "s16",
            "-ac", "2",
            "-ar", "44100",
            "-i", "plughw:1,0",

            "-vn",
            "-af", "pan=mono|c0=c1,highpass=f=300,lowpass=f=3400,volume=15,alimiter=limit=0.85",

            "-acodec", "pcm_s16le",
            "-ac", "1",
            "-ar", "48000",
            "-f", "wav",
            "pipe:1",
        ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

        print("ffmpeg started for mic WAV stream", flush=True)

        try:
            while True:
                chunk = process.stdout.read(4096)
                if not chunk:
                    break
                yield chunk

        except GeneratorExit:
            print("Mic WAV client disconnected", flush=True)

        except Exception as e:
            print("Mic WAV stream error:", e, flush=True)

        finally:
            try:
                process.terminate()
            except Exception:
                pass

            try:
                process.wait(timeout=1)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass

            print("ffmpeg stopped for mic WAV stream", flush=True)

    return Response(generate(), mimetype="audio/wav")

@app.get("/mic/raw-live")
def mic_raw_live():
    """
    Low-latency raw PCM mic stream.

    Capture:
    - plughw:1,0
    - 44100 Hz stereo
    - rechterkanaal c1

    Output:
    - raw signed 16-bit little endian
    - mono
    - 48000 Hz
    """
    print("Mic raw-live stream requested", flush=True)

    def generate():
        process = subprocess.Popen([
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "warning",
            "-nostdin",

            "-f", "alsa",
            "-sample_fmt", "s16",
            "-ac", "2",
            "-ar", "44100",
            "-i", "plughw:1,0",

            "-vn",
            "-af", "pan=mono|c0=c1,highpass=f=300,lowpass=f=3400,volume=15,alimiter=limit=0.85",

            "-acodec", "pcm_s16le",
            "-ac", "1",
            "-ar", "48000",
            "-f", "s16le",
            "pipe:1",
        ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

        print("ffmpeg started for mic raw-live stream", flush=True)

        try:
            while True:
                chunk = process.stdout.read(1024)
                if not chunk:
                    break
                yield chunk

        except GeneratorExit:
            print("Mic raw-live client disconnected", flush=True)

        except Exception as e:
            print("Mic raw-live stream error:", e, flush=True)

        finally:
            try:
                process.terminate()
            except Exception:
                pass

            try:
                process.wait(timeout=1)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass

            print("ffmpeg stopped for mic raw-live stream", flush=True)

    return Response(generate(), mimetype="application/octet-stream")

async def broadcast(event):
    """
    Stuur een event naar alle verbonden WebSocket-clients.
    """
    if not clients:
        return

    message = json.dumps(event)
    disconnected = []

    for websocket in list(clients):
        try:
            await websocket.send(message)
        except Exception as e:
            print("Broadcast failed:", e, flush=True)
            disconnected.append(websocket)

    for websocket in disconnected:
        clients.discard(websocket)


async def handle_ws(websocket):
    """
    WebSocket-handler voor Scrypted/HomeKit/testclients.
    """
    clients.add(websocket)
    print("WebSocket client connected", flush=True)

    try:
        await websocket.send(json.dumps({
            "type": "hello",
            "name": "golmar-pi-agent",
            "doorbell": doorbell_pressed,
            "voltage": doorbell_voltage,
            "threshold": doorbell_threshold,
            "time": time.time(),
        }))

        async for message in websocket:
            print("WS RX:", message, flush=True)

            try:
                command = json.loads(message)
            except json.JSONDecodeError:
                await websocket.send(json.dumps({
                    "type": "error",
                    "ok": False,
                    "message": "invalid json",
                }))
                continue

            command_type = command.get("type")

            if command_type == "unlock":
                print("WebSocket command received: unlock", flush=True)

                try:
                    unlock_door()
                    print("Unlock completed", flush=True)

                    await websocket.send(json.dumps({
                        "type": "unlock",
                        "ok": True,
                        "time": time.time(),
                    }))

                except Exception as e:
                    print("Unlock failed:", e, flush=True)

                    await websocket.send(json.dumps({
                        "type": "unlock",
                        "ok": False,
                        "error": str(e),
                        "time": time.time(),
                    }))

            elif command_type == "ping":
                await websocket.send(json.dumps({
                    "type": "pong",
                    "ok": True,
                    "time": time.time(),
                }))

            elif command_type == "status":
                await websocket.send(json.dumps({
                    "type": "status",
                    "ok": True,
                    "doorbell": doorbell_pressed,
                    "voltage": doorbell_voltage,
                    "threshold": doorbell_threshold,
                    "time": time.time(),
                }))

            else:
                await websocket.send(json.dumps({
                    "type": "error",
                    "ok": False,
                    "message": f"unknown command: {command_type}",
                }))

    except websockets.exceptions.ConnectionClosed:
        print("WebSocket client connection closed", flush=True)

    except Exception as e:
        print("WebSocket client error:", e, flush=True)

    finally:
        clients.discard(websocket)
        print("WebSocket client disconnected", flush=True)


def read_doorbell_loop(loop):
    """
    Lees de analoge belspanning op Automation HAT analog one.
    Stuurt alleen events bij statuswijziging:
    pressed false -> true
    pressed true -> false
    """
    global doorbell_pressed, doorbell_voltage

    import sys
    sys.path.insert(0, "/home/pi/venvs/automationhat/lib/python3.13/site-packages")

    import automationhat

    last_pressed = None

    print("Doorbell analog monitor started", flush=True)

    while True:
        try:
            samples = []

            for _ in range(20):
                samples.append(automationhat.analog.one.read())
                time.sleep(0.005)

            voltage = sum(samples) / len(samples)
            pressed = voltage > doorbell_threshold

            doorbell_voltage = voltage
            doorbell_pressed = pressed

            if pressed != last_pressed:
                last_pressed = pressed

                event = {
                    "type": "doorbell",
                    "pressed": pressed,
                    "voltage": voltage,
                    "threshold": doorbell_threshold,
                    "time": time.time(),
                }

                print(event, flush=True)
                asyncio.run_coroutine_threadsafe(broadcast(event), loop)

        except Exception as e:
            print("Doorbell monitor error:", e, flush=True)

        time.sleep(0.05)


def run_http():
    print(f"HTTP listening on {HTTP_PORT}", flush=True)
    app.run(host="0.0.0.0", port=HTTP_PORT)


async def main():
    loop = asyncio.get_running_loop()

    threading.Thread(target=run_http, daemon=True).start()
    threading.Thread(target=read_doorbell_loop, args=(loop,), daemon=True).start()

    print(f"WebSocket listening on {WS_PORT}", flush=True)

    async with websockets.serve(handle_ws, "0.0.0.0", WS_PORT):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
