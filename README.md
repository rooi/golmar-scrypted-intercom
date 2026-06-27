# Golmar Scrypted Intercom

Experimental integration for a Golmar 4+n analog intercom using:

- a Raspberry Pi agent for doorbell, door unlock, speaker output and microphone input
- a Scrypted plugin exposing the intercom as a HomeKit/Scrypted doorbell camera with two-way audio

## Repository structure

```text
scrypted-plugin/  Scrypted plugin
pi-agent/         Raspberry Pi HTTP/WebSocket/audio agent
