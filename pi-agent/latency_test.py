import argparse
import numpy as np
import sounddevice as sd
from scipy.signal import chirp, correlate

parser = argparse.ArgumentParser()
parser.add_argument("--device", default=None)
parser.add_argument("--samplerate", type=int, default=48000)
parser.add_argument("--duration", type=float, default=4.0)
parser.add_argument("--tone-ms", type=float, default=80)
parser.add_argument("--volume", type=float, default=0.35)
args = parser.parse_args()

fs = args.samplerate
total = int(args.duration * fs)
tone_len = int(args.tone_ms / 1000 * fs)

# korte chirp, beter herkenbaar dan één piep
t = np.linspace(0, args.tone_ms / 1000, tone_len, endpoint=False)
tone = chirp(t, f0=1200, f1=3200, t1=args.tone_ms / 1000, method="linear")
tone *= np.hanning(tone_len)
tone *= args.volume

play = np.zeros(total, dtype=np.float32)
start = int(0.5 * fs)
play[start:start + tone_len] = tone.astype(np.float32)

print("Devices:")
print(sd.query_devices())
print()
print("Recording/playing...")

rec = sd.playrec(
    play,
    samplerate=fs,
    channels=1,
    dtype="float32",
    device=args.device,
    blocking=True,
)

rec = rec[:, 0]

# cross-correlatie zoekt toon in opname
corr = correlate(rec, tone, mode="valid")
peak = int(np.argmax(np.abs(corr)))
latency_samples = peak - start
latency_ms = latency_samples / fs * 1000

print(f"Detected peak at: {peak / fs:.3f} s")
print(f"Playback started at: {start / fs:.3f} s")
print(f"Round-trip latency: {latency_ms:.1f} ms")

if latency_ms < 0:
    print("Let op: negatieve waarde betekent waarschijnlijk verkeerde device/ruis/geen echo gevonden.")
