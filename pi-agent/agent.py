#!/usr/bin/env python3

import asyncio
import json
import os
import subprocess
import threading
import time
import select

from flask import Flask, jsonify, request, Response

import websockets

import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

PYTHON = sys.executable

HTTP_PORT = 8765
WS_PORT = 8766

doorbell_pressed = False
doorbell_voltage = 0.0

last_doorbell_event = None
unlock_lock = threading.Lock()

PACKAGE_UNLOCK_COOLDOWN_SECONDS = 60
package_unlock_lock = threading.Lock()
last_package_unlock_time = 0.0

# Deze waarde werkte bij jou blijkbaar al.
# Eventueel later tunen als hij te gevoelig of juist niet gevoelig genoeg is.
doorbell_threshold = 0.25

clients = set()

app = Flask(__name__)


@app.get("/health")
def health():
    package_unlock_remaining_seconds = (
        max(
            0,
            int(PACKAGE_UNLOCK_COOLDOWN_SECONDS - (time.time() - last_package_unlock_time))
        )
        if last_package_unlock_time
        else 0
    )

    return jsonify({
        "ok": True,
        "name": "golmar-pi-agent",
        "http_port": HTTP_PORT,
        "ws_port": WS_PORT,
        "doorbell": doorbell_pressed,
        "voltage": doorbell_voltage,
        "threshold": doorbell_threshold,
        "ws_clients": len(clients),
        "last_doorbell_event": last_doorbell_event,
        "package_unlock": {
            "cooldown_seconds": PACKAGE_UNLOCK_COOLDOWN_SECONDS,
            "last_package_unlock_time": last_package_unlock_time or None,
            "remaining_seconds": package_unlock_remaining_seconds,
            "cooldown_active": package_unlock_remaining_seconds > 0,
        },
        "greeting": {
            "enabled": GREETING_SOUND_ENABLED,
            "file": GREETING_SOUND_FILE,
            "file_exists": os.path.isfile(GREETING_SOUND_FILE),
            "cooldown_seconds": GREETING_COOLDOWN_SECONDS,
            "last_greeting_time": last_greeting_time or None,
        },
        "away_followup": {
            "enabled": AWAY_FOLLOWUP_ENABLED,
            "file": AWAY_FOLLOWUP_FILE,
            "file_exists": os.path.isfile(AWAY_FOLLOWUP_FILE),
            "delay_seconds": AWAY_FOLLOWUP_DELAY_SECONDS,
        },
        "time": time.time(),
    })

@app.post("/unlock")
def unlock_http():
    try:
        print("HTTP unlock requested", flush=True)

        unlock_door()

        return jsonify({
            "ok": True,
            "action": "unlock",
            "reason": "manual",
            "time": time.time(),
        })

    except Exception as e:
        print("HTTP unlock failed:", repr(e), flush=True)

        return jsonify({
            "ok": False,
            "action": "unlock",
            "reason": "manual",
            "error": str(e),
            "time": time.time(),
        }), 500

@app.post("/package-unlock")
def package_unlock_http():
    global last_package_unlock_time

    with package_unlock_lock:
        now = time.time()
        elapsed = now - last_package_unlock_time
        remaining = max(0, int(PACKAGE_UNLOCK_COOLDOWN_SECONDS - elapsed))

        if elapsed < PACKAGE_UNLOCK_COOLDOWN_SECONDS:
            print(
                f"Package unlock ignored: cooldown active, remaining={remaining}s",
                flush=True,
            )

            return jsonify({
                "ok": False,
                "action": "package-unlock",
                "reason": "cooldown",
                "cooldown_seconds": PACKAGE_UNLOCK_COOLDOWN_SECONDS,
                "remaining_seconds": remaining,
                "time": now,
            }), 429

        try:
            print("Package unlock requested", flush=True)

            unlock_door()

            last_package_unlock_time = time.time()

            print("Package unlock completed", flush=True)

            return jsonify({
                "ok": True,
                "action": "package-unlock",
                "reason": "package",
                "cooldown_seconds": PACKAGE_UNLOCK_COOLDOWN_SECONDS,
                "time": last_package_unlock_time,
            })

        except Exception as e:
            print("Package unlock failed:", repr(e), flush=True)

            return jsonify({
                "ok": False,
                "action": "package-unlock",
                "reason": "error",
                "error": str(e),
                "time": time.time(),
            }), 500

def unlock_door():
    """
    Open deur via Automation HAT output one.

    Het unlock-geluid wordt daarna in een aparte daemon-thread gestart,
    zodat een ontbrekend/kapot audiobestand de unlock-call niet vertraagt
    of vast laat lopen.
    """
    cancel_away_followup("door unlocked")

    with unlock_lock:
        print("Activating Automation HAT output one", flush=True)
        subprocess.run([
            PYTHON,
            "-c",
            (
                "import automationhat, time; "
                "automationhat.output.one.on(); "
                "time.sleep(2); "
                "automationhat.output.one.off()"
            )
        ], check=True, timeout=3)
        print("Automation HAT output one off", flush=True)

    # Niet blokkeren op audio. Als het bestand ontbreekt, ffmpeg/aplay faalt,
    # of talkback actief is, wordt het geluid alleen gelogd/geskipt.
    threading.Thread(target=play_unlock_sound, daemon=True).start()


SPEAKER_DEVICE = "plughw:1,0"
SPEAKER_RATE = "48000"
SPEAKER_CHANNELS = "1"

MIC_DEVICE = "plughw:1,0"
MIC_INPUT_RATE = "44100"
MIC_INPUT_CHANNELS = "2"

MIC_OUTPUT_RATE = "48000"
MIC_OUTPUT_CHANNELS = "1"

AUDIO_RELAY_ENABLED = False
AUDIO_RELAY_SETTLE_SECONDS = 0.10

MIC_STARTUP_GRACE_SECONDS = 8.0
MIC_STALL_SECONDS = 3.0
MIC_SELECT_POLL_SECONDS = 0.5

# Audiobestand dat na een unlock afgespeeld wordt.
# Pas dit pad aan naar jouw bestand. ffmpeg mag wav/mp3/m4a/etc. lezen.
UNLOCK_SOUND_ENABLED = True
UNLOCK_SOUND_FILE = str(BASE_DIR / "audio" / "unlock.wav")
UNLOCK_SOUND_VOLUME = "5.0"
UNLOCK_SOUND_TIMEOUT_SECONDS = 8

# Audiobestand dat automatisch bij aanbellen afgespeeld wordt.
# Kort houden, zodat je snel zelf kunt overnemen.
GREETING_SOUND_ENABLED = True
GREETING_SOUND_FILE = str(BASE_DIR / "audio" / "greeting_home.wav")
GREETING_SOUND_VOLUME = "5.0"
GREETING_SOUND_TIMEOUT_SECONDS = 12

# Bericht wanneer ik away ben en niet tijdig reageer.
AWAY_FOLLOWUP_ENABLED = True
AWAY_FOLLOWUP_FILE = str(BASE_DIR / "audio" / "away_no_response.wav")
AWAY_FOLLOWUP_DELAY_SECONDS = 30
AWAY_FOLLOWUP_VOLUME = "5.0"
AWAY_FOLLOWUP_TIMEOUT_SECONDS = 12

away_followup_timer = None
away_followup_lock = threading.Lock()
away_followup_generation = 0
# Voorkomt meerdere greetings door bounce / lang indrukken / status-flaps.
GREETING_COOLDOWN_SECONDS = 20
last_greeting_time = 0.0

# Huidige greeting-processen, zodat talkback de greeting kan afbreken.
greeting_lock = threading.Lock()
greeting_ffmpeg = None
greeting_aplay = None

audio_relay_lock = threading.Lock()
audio_relay_users = 0

# Houd bij of HomeKit/Safari op dit moment audio naar de Golmar stuurt.
# Als talkback actief is, slaan we het unlock-geluid over om de stream niet te verstoren.
speaker_stream_lock = threading.Lock()
speaker_stream_active = False


def set_audio_relay(enabled: bool):
    """
    Schakel de NO relay voor audio-out.
    Draait bewust via de automationhat-venv, net als unlock_door().
    """
    if not AUDIO_RELAY_ENABLED:
        return

    state = "on" if enabled else "off"
    print(f"Audio relay {state}", flush=True)

    subprocess.run([
        PYTHON,
        "-c",
        (
            "import automationhat; "
            f"automationhat.relay.one.{state}()"
        )
    ], check=True)


def audio_relay_acquire():
    """
    Zet relay aan wanneer de eerste speaker-stream start.
    Reference-counted zodat overlappende streams elkaar niet afschakelen.
    """
    global audio_relay_users

    with audio_relay_lock:
        audio_relay_users += 1
        if audio_relay_users == 1:
            set_audio_relay(True)
            time.sleep(AUDIO_RELAY_SETTLE_SECONDS)


def audio_relay_release():
    """
    Zet relay uit wanneer de laatste speaker-stream stopt.
    """
    global audio_relay_users

    with audio_relay_lock:
        if audio_relay_users > 0:
            audio_relay_users -= 1

        if audio_relay_users == 0:
            try:
                set_audio_relay(False)
            except Exception as e:
                print("Audio relay off failed:", e, flush=True)

def stop_greeting_sound(reason="unknown"):
    """
    Stop de greeting direct, bijvoorbeeld wanneer HomeKit/Safari talkback start.
    Veilig: killt alleen de greeting-processen, niet de speaker_raw talkback-stream.
    """
    global greeting_ffmpeg, greeting_aplay

    with greeting_lock:
        stopped = False

        for proc_name, proc in (("aplay", greeting_aplay), ("ffmpeg", greeting_ffmpeg)):
            if proc and proc.poll() is None:
                try:
                    print(f"Stopping greeting {proc_name}: {reason}", flush=True)
                    proc.kill()
                    stopped = True
                except Exception as e:
                    print(f"Failed to stop greeting {proc_name}: {e}", flush=True)

        greeting_ffmpeg = None
        greeting_aplay = None

        if stopped:
            print(f"Greeting stopped: {reason}", flush=True)

def cancel_away_followup(reason="unknown"):
    """Annuleer het away-vervolgbericht, bijvoorbeeld zodra talkback of unlock start."""
    global away_followup_timer, away_followup_generation

    with away_followup_lock:
        away_followup_generation += 1

        if away_followup_timer:
            try:
                away_followup_timer.cancel()
                print(f"Away follow-up cancelled: {reason}", flush=True)
            except Exception as e:
                print(f"Away follow-up cancel failed: {e}", flush=True)

        away_followup_timer = None


def schedule_away_followup():
    """Plan een vervolgbericht als er na de away greeting geen reactie komt."""
    global away_followup_timer, away_followup_generation

    if not AWAY_FOLLOWUP_ENABLED:
        return

    if not AWAY_FOLLOWUP_FILE or not os.path.isfile(AWAY_FOLLOWUP_FILE):
        print(f"Away follow-up skipped: file not found: {AWAY_FOLLOWUP_FILE}", flush=True)
        return

    with away_followup_lock:
        away_followup_generation += 1
        generation = away_followup_generation

        if away_followup_timer:
            away_followup_timer.cancel()

        print(
            f"Away follow-up scheduled in {AWAY_FOLLOWUP_DELAY_SECONDS}s",
            flush=True,
        )

        away_followup_timer = threading.Timer(
            AWAY_FOLLOWUP_DELAY_SECONDS,
            play_away_followup_if_no_response,
            args=(generation,),
        )
        away_followup_timer.daemon = True
        away_followup_timer.start()


def play_away_followup_if_no_response(generation):
    """Speel het vervolgbericht alleen als er nog geen talkback/reactie is geweest."""
    global away_followup_timer

    with away_followup_lock:
        if generation != away_followup_generation:
            print("Away follow-up skipped: stale generation", flush=True)
            return
        away_followup_timer = None

    with speaker_stream_lock:
        if speaker_stream_active:
            print("Away follow-up skipped: speaker/talkback stream active", flush=True)
            return

    play_audio_file(
        AWAY_FOLLOWUP_FILE,
        AWAY_FOLLOWUP_VOLUME,
        AWAY_FOLLOWUP_TIMEOUT_SECONDS,
        "Away follow-up",
    )

def play_audio_file(file_path, volume, timeout_seconds, label):
    """Speel een audiobestand naar de Golmar speaker via ffmpeg -> aplay."""
    if not file_path or not os.path.isfile(file_path):
        print(f"{label} skipped: file not found: {file_path}", flush=True)
        return

    with speaker_stream_lock:
        if speaker_stream_active:
            print(f"{label} skipped: speaker/talkback stream active", flush=True)
            return

    ffmpeg = None
    aplay = None
    relay_acquired = False

    try:
        print(f"Playing {label}: {file_path}", flush=True)

        audio_relay_acquire()
        relay_acquired = True

        ffmpeg = subprocess.Popen([
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "warning",
            "-nostdin",
            "-i", file_path,
            "-vn",
            "-af", f"volume={volume}",
            "-acodec", "pcm_s16le",
            "-ac", SPEAKER_CHANNELS,
            "-ar", SPEAKER_RATE,
            "-f", "s16le",
            "pipe:1",
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        aplay = subprocess.Popen([
            "aplay",
            "-D", SPEAKER_DEVICE,
            "-f", "S16_LE",
            "-r", SPEAKER_RATE,
            "-c", SPEAKER_CHANNELS,
        ], stdin=ffmpeg.stdout, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        if ffmpeg.stdout:
            ffmpeg.stdout.close()

        _, aplay_err = aplay.communicate(timeout=timeout_seconds)

        try:
            ffmpeg_err = ffmpeg.stderr.read(4096) if ffmpeg.stderr else b""
        except Exception:
            ffmpeg_err = b""

        try:
            ffmpeg.wait(timeout=1)
        except subprocess.TimeoutExpired:
            ffmpeg.kill()

        if ffmpeg.returncode not in (0, None):
            print(f"{label} ffmpeg error:", ffmpeg_err.decode(errors="replace"), flush=True)

        if aplay.returncode != 0:
            print(f"{label} aplay error:", aplay_err.decode(errors="replace"), flush=True)

        print(f"{label} finished", flush=True)

    except subprocess.TimeoutExpired:
        print(f"{label} timeout; killing playback", flush=True)
        try:
            if aplay:
                aplay.kill()
        except Exception:
            pass
        try:
            if ffmpeg:
                ffmpeg.kill()
        except Exception:
            pass

    except Exception as e:
        print(f"{label} failed:", repr(e), flush=True)

    finally:
        if relay_acquired:
            try:
                audio_relay_release()
            except Exception as e:
                print(f"{label} relay release failed:", e, flush=True)

def play_greeting_sound():
    global last_greeting_time, greeting_ffmpeg, greeting_aplay

    if not GREETING_SOUND_ENABLED:
        return

    now = time.time()

    if now - last_greeting_time < GREETING_COOLDOWN_SECONDS:
        remaining = int(GREETING_COOLDOWN_SECONDS - (now - last_greeting_time))
        print(f"Greeting skipped: cooldown active, remaining={remaining}s", flush=True)
        return

    # Pas dit aan aan jouw eigen home/away-koppeling.
    # Voorbeeld:
    is_away = get_current_presence_mode() == "away"

    greeting_file = (
        str(BASE_DIR / "audio" / "greeting_away.wav")
        if is_away
        else str(BASE_DIR / "audio" / "greeting_home.wav")
    )

    if not greeting_file or not os.path.isfile(greeting_file):
        print(f"Greeting skipped: file not found: {greeting_file}", flush=True)
        return

    with speaker_stream_lock:
        if speaker_stream_active:
            print("Greeting skipped: speaker/talkback stream active", flush=True)
            return

    with greeting_lock:
        if greeting_aplay and greeting_aplay.poll() is None:
            print("Greeting skipped: previous greeting still playing", flush=True)
            return

        try:
            last_greeting_time = now

            play_audio_file(
                greeting_file,
                GREETING_SOUND_VOLUME,
                GREETING_SOUND_TIMEOUT_SECONDS,
                "Greeting",
            )

            if is_away:
                schedule_away_followup()

        except Exception as e:
            print("Greeting failed:", repr(e), flush=True)

def play_unlock_sound():
    """
    Speel een audiobestand af bij unlock zonder de unlock-call te blokkeren.

    Veiligheidskeuzes:
    - ontbrekend bestand: direct skippen
    - actieve talkback-stream: direct skippen
    - ffmpeg/aplay-fout: alleen loggen
    - hangende playback: timeout en kill
    """
    if not UNLOCK_SOUND_ENABLED:
        return

    if not UNLOCK_SOUND_FILE or not os.path.isfile(UNLOCK_SOUND_FILE):
        print(f"Unlock sound skipped: file not found: {UNLOCK_SOUND_FILE}", flush=True)
        return

    with speaker_stream_lock:
        if speaker_stream_active:
            print("Unlock sound skipped: speaker/talkback stream active", flush=True)
            return

    ffmpeg = None
    aplay = None
    relay_acquired = False

    try:
        print(f"Playing unlock sound: {UNLOCK_SOUND_FILE}", flush=True)

        audio_relay_acquire()
        relay_acquired = True

        ffmpeg = subprocess.Popen([
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "warning",
            "-nostdin",
            "-i", UNLOCK_SOUND_FILE,
            "-vn",
            "-af", f"volume={UNLOCK_SOUND_VOLUME}",
            "-acodec", "pcm_s16le",
            "-ac", SPEAKER_CHANNELS,
            "-ar", SPEAKER_RATE,
            "-f", "s16le",
            "pipe:1",
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        aplay = subprocess.Popen([
            "aplay",
            "-D", SPEAKER_DEVICE,
            "-f", "S16_LE",
            "-r", SPEAKER_RATE,
            "-c", SPEAKER_CHANNELS,
        ], stdin=ffmpeg.stdout, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        if ffmpeg.stdout:
            ffmpeg.stdout.close()

        _, aplay_err = aplay.communicate(timeout=UNLOCK_SOUND_TIMEOUT_SECONDS)

        try:
            ffmpeg_err = ffmpeg.stderr.read(4096) if ffmpeg.stderr else b""
        except Exception:
            ffmpeg_err = b""

        try:
            ffmpeg.wait(timeout=1)
        except subprocess.TimeoutExpired:
            ffmpeg.kill()

        if ffmpeg.returncode not in (0, None):
            print("Unlock sound ffmpeg error:", ffmpeg_err.decode(errors="replace"), flush=True)

        if aplay.returncode != 0:
            print("Unlock sound aplay error:", aplay_err.decode(errors="replace"), flush=True)

        print("Unlock sound finished", flush=True)

    except subprocess.TimeoutExpired:
        print("Unlock sound timeout; killing playback", flush=True)

        try:
            if aplay:
                aplay.kill()
        except Exception:
            pass

        try:
            if ffmpeg:
                ffmpeg.kill()
        except Exception:
            pass

    except Exception as e:
        print("Unlock sound failed:", repr(e), flush=True)

    finally:
        if relay_acquired:
            try:
                audio_relay_release()
            except Exception as e:
                print("Unlock sound relay release failed:", e, flush=True)

@app.route("/speaker/raw", methods=["POST", "PUT"])
def speaker_raw():
    global speaker_stream_active
    print("Speaker raw stream started", flush=True)

    with speaker_stream_lock:
        speaker_stream_active = True

    # Als jij via HomeKit/Safari begint te praten terwijl de greeting loopt,
    # breken we de greeting direct af zodat talkback voorrang heeft.
    stop_greeting_sound("speaker/talkback stream started")
    cancel_away_followup("speaker/talkback stream started")

    total_bytes = 0
    chunks = 0
    started = time.time()
    process = None

    try:
        # Relay eerst aanzetten, zodat de audio-uitgang gekoppeld is
        # voordat aplay begint te spelen.
        audio_relay_acquire()

        process = subprocess.Popen([
            "aplay",
            "-D", SPEAKER_DEVICE,
            "-f", "S16_LE",
            "-r", SPEAKER_RATE,
            "-c", SPEAKER_CHANNELS,
            "--buffer-time=80000",
            "--period-time=20000",
        ], stdin=subprocess.PIPE)

        while True:
            chunk = request.stream.read(4096)
            if not chunk:
                break

            total_bytes += len(chunk)
            chunks += 1

            if chunks % 50 == 0:
                elapsed = time.time() - started
                print(f"Speaker received {total_bytes} bytes in {elapsed:.1f}s", flush=True)

            process.stdin.write(chunk)
            process.stdin.flush()

    except BrokenPipeError:
        print("Speaker raw stream broken pipe", flush=True)

    except Exception as e:
        print("Speaker raw stream error:", e, flush=True)

    finally:
        if process:
            try:
                if process.stdin:
                    process.stdin.close()
            except Exception:
                pass

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

        # Relay altijd uit bij einde praten / afgebroken stream.
        audio_relay_release()

        with speaker_stream_lock:
            speaker_stream_active = False

        elapsed = time.time() - started
        print(f"Speaker raw stream ended: {total_bytes} bytes in {elapsed:.1f}s", flush=True)

    return jsonify({
        "ok": True,
        "type": "speaker_raw",
        "bytes": total_bytes,
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
            "-af", "pan=mono|c0=c1,highpass=f=300,lowpass=f=3400,volume=15" #,alimiter=limit=0.85",

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
    - stereo, rechterkanaal c1

    Output:
    - μ-law
    - mono
    - 8000 Hz

    Watchdog:
    - als ffmpeg leeft maar geen bytes meer levert, wordt ffmpeg gestopt
    - voorkomt de 99.9% CPU spin waarbij /mic/ulaw 200 OK geeft maar 0 bytes streamt
    """
    print("Mic μ-law stream requested", flush=True)

    def generate():
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel", "warning",
            "-nostdin",

            "-fflags", "nobuffer",
            "-flags", "low_delay",
            "-probesize", "32",
            "-analyzeduration", "0",

            "-f", "alsa",
            "-thread_queue_size", "8",
            "-sample_fmt", "s16",
            "-ac", "2",
            "-ar", "44100",
            "-i", "plughw:1,0",

            "-vn",
            "-af", "pan=mono|c0=c1,highpass=f=300,lowpass=f=3400,volume=30,alimiter=limit=0.85",

            "-acodec", "pcm_mulaw",
            "-ac", "1",
            "-ar", "8000",
            "-f", "mulaw",
            "pipe:1",
        ]

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )

        print(f"ffmpeg started for mic μ-law stream pid={process.pid}", flush=True)

        total_bytes = 0
        started = time.monotonic()
        last_bytes = started

        try:
            while True:
                if process.poll() is not None:
                    print(
                        f"mic μ-law ffmpeg exited code={process.returncode}, total_bytes={total_bytes}",
                        flush=True,
                    )
                    break
                    
                ready, _, _ = select.select(
                    [process.stdout],
                    [],
                    [],
                    MIC_SELECT_POLL_SECONDS,
                )
                
                if not ready:
                    now = time.monotonic()
                    elapsed = now - started
                    since_last = now - last_bytes
                
                    if total_bytes == 0:
                        # Eerste startup: ffmpeg/ALSA/USB-audio krijgt langer de tijd.
                        if elapsed > MIC_STARTUP_GRACE_SECONDS:
                            print(
                                f"mic μ-law ffmpeg startup timeout: no stdout for {elapsed:.1f}s, "
                                f"total_bytes={total_bytes}, killing pid={process.pid}",
                                flush=True,
                            )
                            break
                    else:
                        # Na de eerste bytes: dan is een echte stall verdacht.
                        if since_last > MIC_STALL_SECONDS:
                            print(
                                f"mic μ-law ffmpeg stalled after audio started: "
                                f"no stdout for {since_last:.1f}s, total_bytes={total_bytes}, "
                                f"killing pid={process.pid}",
                                flush=True,
                            )
                            break
                
                    continue

                # 160 bytes = 20 ms bij μ-law 8000 Hz.
                # Dit houden we bewust klein voor lage latency.
                chunk = process.stdout.read(160)

                if not chunk:
                    elapsed = time.monotonic() - started
                    print(
                        f"mic μ-law ffmpeg stdout ended after {elapsed:.1f}s, total_bytes={total_bytes}",
                        flush=True,
                    )
                    break

                total_bytes += len(chunk)
                last_bytes = time.monotonic()
                yield chunk

        except GeneratorExit:
            print(f"Mic μ-law client disconnected, total_bytes={total_bytes}", flush=True)

        except Exception as e:
            print("Mic μ-law stream error:", repr(e), flush=True)

        finally:
            try:
                process.terminate()
            except Exception:
                pass

            try:
                process.wait(timeout=1)
            except Exception:
                try:
                    print(f"mic μ-law ffmpeg did not terminate, killing pid={process.pid}", flush=True)
                    process.kill()
                except Exception:
                    pass

            try:
                if process.stderr:
                    err = process.stderr.read(4096)
                    if err:
                        print("mic μ-law ffmpeg stderr:", err.decode(errors="replace"), flush=True)
            except Exception:
                pass

            elapsed = time.monotonic() - started
            print(
                f"ffmpeg stopped for mic μ-law stream pid={process.pid}, "
                f"total_bytes={total_bytes}, elapsed={elapsed:.1f}s",
                flush=True,
            )

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
            "-af", "pan=mono|c0=c1,highpass=f=300,lowpass=f=3400,volume=30" #,alimiter=limit=0.85",

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

            "-af", "pan=mono|c0=c1,highpass=f=300,lowpass=f=3400,volume=30" #,alimiter=limit=0.85",

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
            "-af", "pan=mono|c0=c1,highpass=f=300,lowpass=f=3400,volume=15" #,alimiter=limit=0.85",

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
            "-af", "pan=mono|c0=c1,highpass=f=300,lowpass=f=3400,volume=15" #,alimiter=limit=0.85",

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

@app.get("/doorbell")
def doorbell_status():
    return jsonify({
        "ok": True,
        "doorbell": doorbell_pressed,
        "voltage": doorbell_voltage,
        "threshold": doorbell_threshold,
        "last_event": last_doorbell_event,
        "time": time.time(),
    })

async def broadcast(event):
    message = json.dumps(event)
    print(f"Broadcasting {event.get('type')} to {len(clients)} websocket clients", flush=True)

    if not clients:
        print("No WebSocket clients connected; event not delivered", flush=True)
        return

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
                    "ws_clients": len(clients),
                    "last_doorbell_event": last_doorbell_event,
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
    global doorbell_pressed, doorbell_voltage, last_doorbell_event

    import sys
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
                last_doorbell_event = event
                asyncio.run_coroutine_threadsafe(broadcast(event), loop)

                # Alleen bij daadwerkelijke beldruk starten, niet bij release.
                # In aparte thread, zodat de analoge monitor en websocket events blijven lopen.
                if pressed:
                    threading.Thread(target=play_greeting_sound, daemon=True).start()

        except Exception as e:
            print("Doorbell monitor error:", e, flush=True)

        time.sleep(0.05)

def run_http():
    print(f"HTTP listening on {HTTP_PORT}", flush=True)
    app.run(host="0.0.0.0", port=HTTP_PORT, threaded=True)


async def main():
    loop = asyncio.get_running_loop()

    threading.Thread(target=run_http, daemon=True).start()
    threading.Thread(target=read_doorbell_loop, args=(loop,), daemon=True).start()

    print(f"WebSocket listening on {WS_PORT}", flush=True)

    async with websockets.serve(handle_ws, "0.0.0.0", WS_PORT):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
