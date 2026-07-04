import {
  BinarySensor,
  Camera,
  Device,
  DeviceCreator,
  DeviceCreatorSettings,
  DeviceProvider,
  FFmpegInput,
  Intercom,
  Lock,
  LockState,
  MediaObject,
  MediaStreamOptions,
  MotionSensor,
  PictureOptions,
  ResponseMediaStreamOptions,
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  ScryptedMimeTypes,
  Setting,
  Settings,
  SettingValue,
  VideoCamera,
} from '@scrypted/sdk';

import sdk from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings"
import fs from 'fs';
import path from 'path';
import { createServer, Server, ServerResponse } from 'http';

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

const { deviceManager, mediaManager } = sdk;

// use the dog.jpg from the fs directory that will be packaged with the plugin
const dogImage = fs.readFileSync('dog.jpg');

type PendingWsCommand = {
    expectedType: string;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: any;
};

class GolmarCameraDevice extends ScryptedDeviceBase implements Intercom, Camera, VideoCamera, MotionSensor, BinarySensor, Settings {
    settingsStorage = new StorageSettings(this, {
        piBaseUrl: {
            title: 'Pi Agent Base URL',
            description: 'Example: http://192.168.1.123:8765',
            defaultValue: 'http://192.168.1.123:8765',
        },
        piWsUrl: {
            title: 'Pi Agent WebSocket URL',
            description: 'Example: ws://10.0.1.41:8766',
            defaultValue: 'ws://10.0.1.41:8766',
        },

        videoMode: {
            title: 'Video Mode',
            description: 'live = live RTSP video. snapshot = still image video with live audio.',
            choices: ['live', 'snapshot'],
            defaultValue: 'live',
        },
        cameraRtspUrl: {
            title: 'Camera RTSP URL',
            description: 'RTSP source for live video and snapshots.',
            defaultValue: '',
        },
        videoCrop: {
            title: 'Video Crop',
            description: 'FFmpeg video filter for crop/snapshot. Example: crop=1280:720:1280:720',
            defaultValue: 'crop=1280:720:1280:720',
        },
        videoWidth: {
            title: 'Video Width',
            defaultValue: '1280',
        },
        videoHeight: {
            title: 'Video Height',
            defaultValue: '720',
        },
        videoFps: {
            title: 'Video FPS',
            defaultValue: '15',
        },
        snapshotVideoFps: {
            title: 'Snapshot Video FPS',
            description: 'FPS for still-image video mode. 1 to 5 is usually enough.',
            defaultValue: '2',
        },
        snapshotRefreshSeconds: {
            title: 'Snapshot Refresh Seconds',
            description: 'How often to refresh the still image while a snapshot video stream is active. Set 0 to disable.',
            defaultValue: '10',
        },
    });

    private piWs: any;
    private piWsConnected = false;
    private piHeartbeatTimer: any;
    private lastPiPong = 0;
    private reconnectTimer: any;
    private pendingCommands: PendingWsCommand[] = [];
    private lastDoorbellResetTimer: any;

    private intercomProcess?: ChildProcessWithoutNullStreams;

    private snapshotCachePath = path.join(
        process.env.SCRYPTED_PLUGIN_VOLUME || '/tmp',
        'golmar-snapshot.jpg'
    );
    private streamGeneration = 0;

    private startupSnapshotPromise?: Promise<void>;
    private snapshotReady = false;

    private snapshotRefreshTimer?: any;
    private snapshotRefreshRunning = false;
    private snapshotRefreshLeaseTimer?: any;

    constructor(public plugin: GolmarCameraPlugin, nativeId: string) {
        super(nativeId);

        // Start iets later zodat Scrypted/device init rustig klaar is.
        setTimeout(() => this.connectPiWebSocket(), 1000);

        // Maak één snapshot bij opstarten. Daarna hergebruiken.
        setTimeout(() => {
            this.startupSnapshotPromise = this.refreshSnapshot()
                .then(() => {
                    this.snapshotReady = true;
                    this.console.log(`Startup snapshot ready: ${this.snapshotCachePath}`);
                })
                .catch(e => {
                    this.console.warn(`Startup snapshot failed, using fallback later: ${e}`);

                    if (!fs.existsSync(this.snapshotCachePath)) {
                        fs.writeFileSync(this.snapshotCachePath, dogImage);
                    }

                    this.snapshotReady = false;
                });
        }, 2000);
    }

    private bumpStreamGeneration(reason: string) {
        this.streamGeneration++;
        this.console.log(`Stream generation bumped to ${this.streamGeneration}: ${reason}`);
    }

    async refreshSnapshot(): Promise<Buffer> {
        const cameraRtspUrl = (this.settingsStorage.values.cameraRtspUrl as string || '').trim();
        const videoCrop = (this.settingsStorage.values.videoCrop as string || 'crop=1280:720:1280:720').trim();

        if (!cameraRtspUrl) {
            fs.writeFileSync(this.snapshotCachePath, dogImage);
            return dogImage;
        }

        const ffmpegPath = await mediaManager.getFFmpegPath();

        const args = [
            '-hide_banner',
            '-loglevel', 'warning',

            '-rtsp_transport', 'tcp',
            '-probesize', '500000',
            '-analyzeduration', '1000000',
            '-i', cameraRtspUrl,

            '-map', '0:v:0',
            '-vf', videoCrop,

            '-frames:v', '1',
            '-q:v', '3',
            '-f', 'image2pipe',
            '-vcodec', 'mjpeg',
            'pipe:1',
        ];

        this.console.log(`Refreshing snapshot: ${ffmpegPath} ${args.join(' ')}`);

        const jpeg = await new Promise<Buffer>((resolve, reject) => {
            const child = spawn(ffmpegPath, args);

            const chunks: Buffer[] = [];
            const errors: Buffer[] = [];

            const timeout = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // ignore
                }
                reject(new Error('Snapshot ffmpeg timed out'));
            }, 10000);

            child.stdout.on('data', data => {
                chunks.push(Buffer.from(data));
            });

            child.stderr.on('data', data => {
                errors.push(Buffer.from(data));
            });

            child.on('error', error => {
                clearTimeout(timeout);
                reject(error);
            });

            child.on('exit', code => {
                clearTimeout(timeout);

                const stderr = Buffer.concat(errors).toString();
                const buffer = Buffer.concat(chunks);

                if (code !== 0) {
                    reject(new Error(`Snapshot ffmpeg exited with code ${code}: ${stderr}`));
                    return;
                }

                if (!buffer.length) {
                    reject(new Error(`Snapshot ffmpeg produced no output: ${stderr}`));
                    return;
                }

                resolve(buffer);
            });
        });

        const tmpPath = `${this.snapshotCachePath}.tmp`;
        fs.writeFileSync(tmpPath, jpeg);
        fs.renameSync(tmpPath, this.snapshotCachePath);
        return jpeg;
    }

    async takePicture(options?: PictureOptions): Promise<MediaObject> {
        try {
            // Gebruik de startup snapshot. Niet telkens opnieuw de camera wakker maken.
            if (this.startupSnapshotPromise) {
                try {
                    await this.startupSnapshotPromise;
                } catch {
                    // fallback hieronder
                }
            }

            if (fs.existsSync(this.snapshotCachePath)) {
                return mediaManager.createMediaObject(
                    fs.readFileSync(this.snapshotCachePath),
                    'image/jpeg'
                );
            }

            return mediaManager.createMediaObject(dogImage, 'image/jpeg');
        } catch (e) {
            this.console.warn(`Failed to read cached snapshot, using fallback: ${e}`);
            return mediaManager.createMediaObject(dogImage, 'image/jpeg');
        }
    }

    async getPictureOptions(): Promise<PictureOptions[]> {
        return [
            {
                id: 'default',
                name: 'Snapshot',
                width: 1280,
                height: 720,
            } as PictureOptions,
        ];
    }

    private getSnapshotRefreshSeconds(): number {
        const value = Number(this.settingsStorage.values.snapshotRefreshSeconds || '10');

        if (!Number.isFinite(value) || value <= 0) {
            return 0;
        }

        // Niet te agressief. RTSP snapshot pakken is relatief duur.
        return Math.max(2, Math.floor(value));
    }

    private async refreshSnapshotSafely(reason: string): Promise<void> {
        if (this.snapshotRefreshRunning) {
            this.console.log(`Snapshot refresh skipped, already running: ${reason}`);
            return;
        }

        this.snapshotRefreshRunning = true;

        try {
            this.console.log(`Snapshot refresh started: ${reason}`);
            await this.refreshSnapshot();
            this.snapshotReady = true;
            this.console.log(`Snapshot refresh ready: ${reason}`);
        } catch (e) {
            this.console.warn(`Snapshot refresh failed (${reason}): ${e}`);

            if (!fs.existsSync(this.snapshotCachePath)) {
                fs.writeFileSync(this.snapshotCachePath, dogImage);
            }
        } finally {
            this.snapshotRefreshRunning = false;
        }
    }

    private startSnapshotRefreshLoop(): void {
        const refreshSeconds = this.getSnapshotRefreshSeconds();

        if (refreshSeconds <= 0) {
            this.console.log('Snapshot periodic refresh disabled.');
            return;
        }

        if (!this.snapshotRefreshTimer) {
            this.console.log(`Starting snapshot refresh loop every ${refreshSeconds}s`);

            this.snapshotRefreshTimer = setInterval(() => {
                this.refreshSnapshotSafely('periodic stream refresh');
            }, refreshSeconds * 1000);
        }

        // Verleng de "lease" telkens wanneer een stream wordt gestart.
        // Omdat Scrypted geen simpele stream-ended callback geeft, stoppen we
        // de refresh-loop automatisch na een tijdje zonder nieuwe stream-start.
        if (this.snapshotRefreshLeaseTimer) {
            clearTimeout(this.snapshotRefreshLeaseTimer);
        }

        const leaseMs = Math.max(30000, refreshSeconds * 3000);

        this.snapshotRefreshLeaseTimer = setTimeout(() => {
            this.stopSnapshotRefreshLoop();
        }, leaseMs);
    }

    private stopSnapshotRefreshLoop(): void {
        if (this.snapshotRefreshTimer) {
            clearInterval(this.snapshotRefreshTimer);
            this.snapshotRefreshTimer = undefined;
        }

        if (this.snapshotRefreshLeaseTimer) {
            clearTimeout(this.snapshotRefreshLeaseTimer);
            this.snapshotRefreshLeaseTimer = undefined;
        }

        this.console.log('Stopped snapshot refresh loop');
    }

    async getVideoStream(options?: MediaStreamOptions): Promise<MediaObject> {
        this.console.log(`getVideoStream requested: ${JSON.stringify(options)}`);

        const videoMode = (this.settingsStorage.values.videoMode as string || 'live').trim();
        const cameraRtspUrl = (this.settingsStorage.values.cameraRtspUrl as string || '').trim();
        const videoCrop = (this.settingsStorage.values.videoCrop as string || 'crop=1280:720:1280:720').trim();

        const videoFps = String(Number(this.settingsStorage.values.videoFps || '15') || 15);
        const snapshotVideoFps = String(Number(this.settingsStorage.values.snapshotVideoFps || '2') || 2);

        const session = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const micUrl = `${this.getPiBaseUrl()}/mic/ulaw?session=${encodeURIComponent(session)}`;

        this.console.log(`Video mode: ${videoMode}`);
        this.console.log(`Using camera RTSP URL: ${cameraRtspUrl || '(not configured)'}`);
        this.console.log(`Using video crop: ${videoCrop}`);
        this.console.log(`Using mic URL: ${micUrl}`);

        const inputArguments: string[] = [];

        if (videoMode === 'snapshot') {
            
            
            if (!fs.existsSync(this.snapshotCachePath)) {
                this.console.warn('No cached snapshot available, using fallback dog image.');
                fs.writeFileSync(this.snapshotCachePath, dogImage);
            }

            this.startSnapshotRefreshLoop();

            this.console.log(`Using periodically refreshed snapshot still video: ${this.snapshotCachePath}`);

            inputArguments.push(
                '-re',
                '-loop', '1',
                '-framerate', snapshotVideoFps,
                '-i', this.snapshotCachePath,
            );
        }
        else if (cameraRtspUrl) {
            // Live camera mode.
            inputArguments.push(
                '-thread_queue_size', '8',
                '-rtsp_transport', 'tcp',
                '-probesize', '500000',
                '-analyzeduration', '1000000',
                '-i', cameraRtspUrl,
            );
        }
        else {
            // Fallback dummy video.
            const file = path.join(
                process.env.SCRYPTED_PLUGIN_VOLUME,
                'zip',
                'unzipped',
                'fs',
                'people.mp4'
            );

            this.console.log(`No camera configured, using fallback video: ${file}`);

            inputArguments.push(
                '-re',
                '-stream_loop', '-1',
                '-i', file,
            );
        }

        // Live Golmar/Pi audio.
        inputArguments.push(
            '-thread_queue_size', '8',
            '-fflags', 'nobuffer',
            '-flags', 'low_delay',
            //'-avioflags', 'direct',
            '-use_wallclock_as_timestamps', '1',
            '-probesize', '32',
            '-analyzeduration', '0',
            '-f', 'mulaw',
            '-ar', '8000',
            '-ac', '1',
            '-i', micUrl,

            '-map', '0:v:0',
            '-map', '1:a:0',
        );

        // In live camera mode, crop the live video.
        // In snapshot mode, the JPEG is already cropped by refreshSnapshot().
        if (videoMode !== 'snapshot' && cameraRtspUrl && videoCrop) {
            inputArguments.push(
                '-vf', videoCrop,
            );
        }

        const fpsNumberForOptions = videoMode === 'snapshot'
            ? Number(snapshotVideoFps) || 5
            : Number(videoFps) || 15;

        const ffmpegInput: FFmpegInput = {
            inputArguments,
        };

        if (videoMode === 'snapshot') {
            const fpsNumber = Number(snapshotVideoFps) || 2;

            ffmpegInput.h264EncoderArguments = [
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',

                '-profile:v', 'main',
                '-level:v', '3.1',
                '-pix_fmt', 'yuv420p',

                '-r', String(fpsNumber),
                '-g', String(fpsNumber),
                '-keyint_min', String(fpsNumber),
                '-sc_threshold', '0',
                '-bf', '0',

                //// Geen zerolatency/sliced threads; dat gaf HomeKit-gedoe.
                //'-x264-params', 'repeat-headers=1:aud=1:open-gop=0:sliced-threads=0',
                '-x264-params', 'repeat-headers=1:aud=1:open-gop=0:sliced-threads=0:sync-lookahead=0:rc-lookahead=0',

                // Stilstaand beeld heeft weinig bitrate nodig.
                '-b:v', '120k',
                '-maxrate', '120k',
                '-bufsize', '60k',

                '-muxdelay', '0',
                '-muxpreload', '0',
                '-flush_packets', '1',
            ];
        }
        else if (cameraRtspUrl) {
            const fpsNumber = Number(videoFps) || 15;

            ffmpegInput.h264EncoderArguments = [
                '-c:v', 'libx264',
                '-preset', 'veryfast',

                '-profile:v', 'main',
                '-level:v', '3.1',
                '-pix_fmt', 'yuv420p',

                '-r', String(fpsNumber),
                '-g', String(fpsNumber),
                '-keyint_min', String(fpsNumber),
                '-sc_threshold', '0',
                '-bf', '0',
                '-force_key_frames', 'expr:gte(t,n_forced*1)',

                '-x264-params', 'repeat-headers=1:aud=1:open-gop=0:sliced-threads=0',

                '-b:v', '280k',
                '-maxrate', '280k',
                '-bufsize', '560k',
            ];
        }

        return mediaManager.createMediaObject(
            Buffer.from(JSON.stringify(ffmpegInput)),
            ScryptedMimeTypes.FFmpegInput
        );
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        const videoMode = (this.settingsStorage.values.videoMode as string || 'live').trim();

        const width = Number(this.settingsStorage.values.videoWidth || '1280');
        const height = Number(this.settingsStorage.values.videoHeight || '720');
        const fps = videoMode === 'snapshot'
        ? Number(this.settingsStorage.values.snapshotVideoFps || '5') || 5
        : Number(this.settingsStorage.values.videoFps || '15') || 15;

        return [{
            id: 'stream',
            name: 'Golmar Stream',
            audio: {
                codec: 'pcm_mulaw',
            },
            video: {
                codec: 'h264',
                width,
                height,
                fps,
            }
        }];
    }

    async startIntercom(media: MediaObject): Promise<void> {
        this.console.log('Intercom start requested');

        if (this.intercomProcess && !this.intercomProcess.killed) {
            this.console.log('Intercom ffmpeg already running, not starting another one.');
            return;
        }

        const ffmpegInput: FFmpegInput = JSON.parse(
            (await mediaManager.convertMediaObjectToBuffer(
                media,
                ScryptedMimeTypes.FFmpegInput
            )).toString()
        );

        this.console.log(`Intercom ffmpeg input: ${JSON.stringify(ffmpegInput)}`);

        const ffmpegPath = await mediaManager.getFFmpegPath();
        const outputUrl = `${this.getPiBaseUrl()}/speaker/raw`;

        const inputArguments = [...ffmpegInput.inputArguments];

        // HomeKit geeft soms een lokale RTSP intercom stream zonder transport.
        // Voeg dan expliciet TCP toe vóór de bijbehorende -i.
        // Safari/WebRTC levert dit meestal al correct aan; dan wijzigen we niets.
        const rtspUrlIndex = inputArguments.findIndex(arg =>
            typeof arg === 'string' && arg.startsWith('rtsp://')
        );

        if (rtspUrlIndex >= 0) {
            const inputFlagIndex = inputArguments.lastIndexOf('-i', rtspUrlIndex);

            if (inputFlagIndex >= 0) {
                const lowLatencyInputArgs = [
                    '-fflags', 'nobuffer',
                    '-flags', 'low_delay',
                    '-probesize', '32',
                    '-analyzeduration', '0',
                    '-thread_queue_size', '8',
                ];

                if (!inputArguments.includes('-rtsp_transport')) {
                    lowLatencyInputArgs.push('-rtsp_transport', 'tcp');
                }

                inputArguments.splice(inputFlagIndex, 0, ...lowLatencyInputArgs);
            }
        }

        this.console.log(`Normalized intercom input args: ${JSON.stringify(inputArguments)}`);

        const args = [
        '-hide_banner',
        '-loglevel', 'warning',
        '-nostdin',

        ...inputArguments,

        '-vn',
        '-af', 'highpass=f=300,lowpass=f=3400,volume=8,alimiter=limit=0.85',
        '-acodec', 'pcm_s16le',
        '-ac', '1',
        '-ar', '48000',
        '-f', 's16le',
        '-method', 'POST',
        outputUrl,
        ];

        this.console.log(`Starting intercom ffmpeg: ${ffmpegPath} ${args.join(' ')}`);

        this.intercomProcess = spawn(ffmpegPath, args);

        this.intercomProcess.stdout.on('data', data => {
            this.console.log(`intercom stdout: ${data}`);
        });

        this.intercomProcess.stderr.on('data', data => {
            this.console.log(`intercom stderr: ${data}`);
        });

        this.intercomProcess.on('exit', (code, signal) => {
            this.console.log(`intercom ffmpeg exited code=${code} signal=${signal}`);
            this.intercomProcess = undefined;
        });

        this.intercomProcess.on('error', error => {
            this.console.error(`intercom ffmpeg error: ${error}`);
            this.intercomProcess = undefined;
        });
    }

    async stopIntercom(): Promise<void> {
        this.console.log('Intercom stop requested');

        const process = this.intercomProcess;
        if (!process) {
            return;
        }

        this.intercomProcess = undefined;

        try {
            process.kill('SIGTERM');
        } catch (e) {
            this.console.warn(`Failed to stop intercom ffmpeg: ${e}`);
            return;
        }

        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                try {
                    process.kill('SIGKILL');
                } catch {
                    // ignore
                }
                resolve();
            }, 1000);

            process.once('exit', () => {
                clearTimeout(timeout);
                resolve();
            });
        });
    }

    async getSettings(): Promise<Setting[]> {
        const settings = await this.settingsStorage.getSettings();

        settings.push(
            {
                key: 'triggerDoorbell',
                title: 'Trigger Doorbell',
                description: 'Simulate a Golmar doorbell press.',
                type: 'button',
            },
            {
                key: 'triggerMotion',
                title: 'Trigger Motion',
                description: 'Simulate motion for testing.',
                type: 'button',
            },
            {
                key: 'unlockDoor',
                title: 'Unlock Door',
                description: 'Call the Pi agent to activate the Golmar opener output.',
                type: 'button',
            },
            {
                key: 'testPiHealth',
                title: 'Test Pi Agent HTTP',
                description: 'Check whether the Scrypted plugin can reach the Pi agent over HTTP.',
                type: 'button',
            },
            {
                key: 'testPiWs',
                title: 'Test Pi Agent WebSocket',
                description: 'Send ping over WebSocket to the Pi agent.',
                type: 'button',
            },
            {
                key: 'reconnectPiWs',
                title: 'Reconnect Pi WebSocket',
                description: 'Reconnect to the Pi agent WebSocket.',
                type: 'button',
            },
            {
                key: 'testAudioRoundtripLatency',
                title: 'Test Audio Roundtrip Latency',
                description: 'Play a short tone to the Golmar speaker and measure when it returns via /mic/ulaw.',
                type: 'button',
            },
        );

        return settings;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        if (key === 'triggerDoorbell') {
            this.triggerBinaryState();
            return;
        }

        if (key === 'triggerMotion') {
            this.triggerMotion();
            return;
        }

        if (key === 'unlockDoor') {
            await this.unlockDoor();
            return;
        }

        if (key === 'testPiHealth') {
            await this.testPiHealth();
            return;
        }

        if (key === 'testPiWs') {
            await this.testPiWs();
            return;
        }

        if (key === 'reconnectPiWs') {
            this.reconnectPiWebSocket();
            return;
        }

        await this.settingsStorage.putSetting(key, value);

        if (key === 'piWsUrl') {
            this.reconnectPiWebSocket();
        }

        if (key === 'testAudioRoundtripLatency') {
            await this.testAudioRoundtripLatency();
            return;
        }

    }

    getPiBaseUrl(): string {
        return (this.settingsStorage.values.piBaseUrl as string || 'http://10.0.1.41:8765').replace(/\/$/, '');
    }

    getPiWsUrl(): string {
        return (this.settingsStorage.values.piWsUrl as string || 'ws://10.0.1.41:8766').replace(/\/$/, '');
    }

    async testPiHealth(): Promise<void> {
        const url = `${this.getPiBaseUrl()}/health`;
        this.console.log(`Testing Pi agent HTTP: ${url}`);

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Pi agent health failed: ${response.status} ${response.statusText}`);
        }

        const body = await response.text();
        this.console.log(`Pi agent health OK: ${body}`);
    }

    async testPiWs(): Promise<void> {
        this.console.log('Testing Pi agent WebSocket ping');

        const response = await this.sendPiWsCommand({
            type: 'ping',
        }, 'pong');

        this.console.log(`Pi WebSocket ping OK: ${JSON.stringify(response)}`);
    }

    connectPiWebSocket() {
        const url = this.getPiWsUrl();

        if (this.piWs && this.piWsConnected) {
            return;
        }

        const WebSocketImpl = (globalThis as any).WebSocket;

        if (!WebSocketImpl) {
            this.console.error('No global WebSocket implementation available in this Scrypted runtime.');
            return;
        }

        this.console.log(`Connecting to Pi WebSocket: ${url}`);

        try {
            this.piWs = new WebSocketImpl(url);
        } catch (e) {
            this.console.error(`Failed to create Pi WebSocket: ${e}`);
            this.schedulePiWsReconnect();
            return;
        }

        this.piWs.onopen = () => {
            this.piWsConnected = true;
            this.lastPiPong = Date.now();
            this.console.log(`Pi WebSocket connected: ${url}`);
            this.startPiHeartbeat();
        };

        this.piWs.onmessage = (event: any) => {
            this.handlePiWsMessage(event.data);
        };

        this.piWs.onerror = (event: any) => {
            this.console.error(`Pi WebSocket error: ${JSON.stringify(event)}`);
        };

        this.piWs.onclose = () => {
            this.console.warn('Pi WebSocket closed');
            this.piWsConnected = false;
            this.piWs = undefined;
            this.stopPiHeartbeat();
            this.rejectPendingWsCommands(new Error('Pi WebSocket closed'));
            this.schedulePiWsReconnect();
        };
    }

    reconnectPiWebSocket() {
        this.console.log('Reconnecting Pi WebSocket');

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }

        if (this.piWs) {
            try {
                this.piWs.close();
            } catch (e) {
                // ignore
            }

            this.piWs = undefined;
            this.piWsConnected = false;
        }

        this.rejectPendingWsCommands(new Error('Pi WebSocket reconnecting'));

        setTimeout(() => this.connectPiWebSocket(), 500);
    }

    schedulePiWsReconnect() {
        if (this.reconnectTimer) {
            return;
        }

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.connectPiWebSocket();
        }, 3000);
    }

    startPiHeartbeat() {
        this.stopPiHeartbeat();

        this.piHeartbeatTimer = setInterval(() => {
            if (!this.piWs || !this.piWsConnected) {
                return;
            }

            const ageMs = Date.now() - this.lastPiPong;

            if (ageMs > 45000) {
                this.console.warn(`Pi WebSocket heartbeat stale (${ageMs}ms), reconnecting`);
                this.reconnectPiWebSocket();
                return;
            }

            try {
                this.piWs.send(JSON.stringify({
                    type: 'ping',
                    time: Date.now(),
                }));
            } catch (e) {
                this.console.warn(`Pi WebSocket heartbeat send failed: ${e}`);
                this.reconnectPiWebSocket();
            }
        }, 15000);
    }

    stopPiHeartbeat() {
        if (this.piHeartbeatTimer) {
            clearInterval(this.piHeartbeatTimer);
            this.piHeartbeatTimer = undefined;
        }
    }

    handlePiWsMessage(raw: any) {
        const text = typeof raw === 'string' ? raw : raw?.toString?.() || '';

        this.console.log(`Pi WS RX: ${text}`);

        let event: any;

        try {
            event = JSON.parse(text);
        } catch (e) {
            this.console.warn(`Invalid Pi WS JSON: ${text}`);
            return;
        }

        this.resolvePendingWsCommand(event);

        if (event.type === 'hello') {
            this.console.log(`Pi agent hello: ${JSON.stringify(event)}`);
            return;
        }

        if (event.type === 'pong') {
            this.lastPiPong = Date.now();
            this.console.log(`Pi agent pong: ${JSON.stringify(event)}`);
            return;
        }

        if (event.type === 'doorbell') {
            this.handleDoorbellEvent(event);
            return;
        }

        if (event.type === 'bell') {
            // Compatibiliteit, mocht de Pi-agent later 'bell' sturen.
            this.handleDoorbellEvent(event);
            return;
        }
    }

    private ulawDecodeSample(u: number): number {
        u = ~u & 0xff;
        const sign = u & 0x80;
        const exponent = (u >> 4) & 0x07;
        const mantissa = u & 0x0f;
        let sample = ((mantissa << 3) + 0x84) << exponent;
        sample -= 0x84;
        return sign ? -sample : sample;
    }

    private makeChirpS16le48k(): { buffer: Buffer; reference8k: Float32Array; startMs: number } {
        const outRate = 48000;
        const refRate = 8000;

        const startMs = 200;
        const toneMs = 80;
        const totalMs = 700;

        const totalSamples = Math.floor(outRate * totalMs / 1000);
        const startSample = Math.floor(outRate * startMs / 1000);
        const toneSamples = Math.floor(outRate * toneMs / 1000);

        const pcm = Buffer.alloc(totalSamples * 2);

        for (let i = 0; i < toneSamples; i++) {
            const t = i / outRate;
            const p = i / toneSamples;

            const f0 = 1200;
            const f1 = 3200;
            const freq = f0 + (f1 - f0) * p;

            const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
            const sample = Math.sin(2 * Math.PI * freq * t) * window * 0.35;

            const s16 = Math.max(-32767, Math.min(32767, Math.round(sample * 32767)));
            pcm.writeInt16LE(s16, (startSample + i) * 2);
        }

        const refSamples = Math.floor(refRate * toneMs / 1000);
        const reference8k = new Float32Array(refSamples);

        for (let i = 0; i < refSamples; i++) {
            const t = i / refRate;
            const p = i / refSamples;

            const f0 = 1200;
            const f1 = 3200;
            const freq = f0 + (f1 - f0) * p;

            const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
            reference8k[i] = Math.sin(2 * Math.PI * freq * t) * window;
        }

        return { buffer: pcm, reference8k, startMs };
    }

    private findCorrelationPeak(signal: Float32Array, reference: Float32Array, minIndex = 0): number {
        let bestIndex = minIndex;
        let bestScore = -Infinity;

        for (let i = minIndex; i <= signal.length - reference.length; i++) {
            let score = 0;

            for (let j = 0; j < reference.length; j++) {
                score += signal[i + j] * reference[j];
            }

            const absScore = Math.abs(score);
            if (absScore > bestScore) {
                bestScore = absScore;
                bestIndex = i;
            }
        }

        return bestIndex;
    }

    async testAudioRoundtripLatency(): Promise<void> {
        const piBaseUrl = this.getPiBaseUrl();
        const session = `latency-${Date.now()}`;

        const micUrl = `${piBaseUrl}/mic/ulaw?session=${encodeURIComponent(session)}`;
        const speakerUrl = `${piBaseUrl}/speaker/raw`;

        const sampleRate = 8000;
        const recordMs = 5000;
        const { buffer: tonePcm48k, reference8k, startMs } = this.makeChirpS16le48k();

        this.console.log(`[latency] Starting roundtrip test`);
        this.console.log(`[latency] Mic URL: ${micUrl}`);
        this.console.log(`[latency] Speaker URL: ${speakerUrl}`);

        // Kleine pauze om restanten van vorige test minder kans te geven.
        await new Promise(resolve => setTimeout(resolve, 500));

        const controller = new AbortController();
        const chunks: Buffer[] = [];

        const micPromise = (async () => {
            const response = await fetch(micUrl, {
                method: 'GET',
                signal: controller.signal,
            });

            if (!response.ok || !response.body) {
                throw new Error(`mic fetch failed: ${response.status} ${response.statusText}`);
            }

            const reader = response.body.getReader();

            try {
                while (true) {
                    const result = await reader.read();

                    if (result.done) {
                        break;
                    }

                    if (result.value?.length) {
                        chunks.push(Buffer.from(result.value));
                    }
                }
            } catch {
                // Expected when aborted after record window.
            }
        })();

        // Geef /mic/ulaw even tijd om echt te streamen voordat de toon start.
        await new Promise(resolve => setTimeout(resolve, 200));

        const speakerStartedAt = Date.now();

        const speakerPromise = fetch(speakerUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
            },
            body: tonePcm48k,
        }).then(response => {
            if (!response.ok) {
                throw new Error(`speaker POST failed: ${response.status} ${response.statusText}`);
            }
            return response;
        }).catch(e => {
            this.console.warn(`[latency] speaker POST failed: ${e?.message || e}`);
        });

        this.console.log(`[latency] Speaker POST started at ${speakerStartedAt}`);

        // Niet wachten op speakerPromise: /speaker/raw returned pas nadat alle audio verwerkt is.
        await new Promise(resolve => setTimeout(resolve, recordMs));

        controller.abort();

        try {
            await micPromise;
        } catch {
            // Ignore abort.
        }

        try {
            await speakerPromise;
        } catch {
            // Already logged above.
        }

        const ulaw = Buffer.concat(chunks);

        this.console.log(`[latency] Captured ${ulaw.length} ulaw bytes`);

        if (ulaw.length < sampleRate) {
            this.console.warn(`[latency] Too little audio captured. Is /mic/ulaw streaming?`);
            return;
        }

        const signal = new Float32Array(ulaw.length);

        for (let i = 0; i < ulaw.length; i++) {
            signal[i] = this.ulawDecodeSample(ulaw[i]) / 32768;
        }

        // Zoek niet vóór de verwachte speelstart; dat voorkomt oude/valse pieken.
        const minSearchMs = startMs + 20;
        const minSearchIndex = Math.floor(sampleRate * minSearchMs / 1000);

        const peak = this.findCorrelationPeak(signal, reference8k, minSearchIndex);

        const detectedMs = peak / sampleRate * 1000;
        const latencyMs = detectedMs - startMs;

        this.console.log(`[latency] Detected tone at ${detectedMs.toFixed(1)} ms`);
        this.console.log(`[latency] Playback tone started at ${startMs.toFixed(1)} ms`);
        this.console.log(`[latency] Estimated audio roundtrip latency: ${latencyMs.toFixed(1)} ms`);

        if (latencyMs < 0) {
            this.console.warn(`[latency] Negative latency: likely false detection or old buffered audio.`);
        } else if (latencyMs > 1000) {
            this.console.warn(`[latency] High latency detected. This may be buffered audio or a delayed /mic/ulaw path.`);
        }
    }

    handleDoorbellEvent(event: any) {
        const pressed = !!event.pressed;

        this.console.log(`Golmar doorbell event: pressed=${pressed}, voltage=${event.voltage}`);

        if (pressed) {
            this.binaryState = true;

            if (this.lastDoorbellResetTimer) {
                clearTimeout(this.lastDoorbellResetTimer);
            }

            this.lastDoorbellResetTimer = setTimeout(() => {
                this.console.log('Golmar doorbell auto release');
                this.binaryState = false;
                this.lastDoorbellResetTimer = undefined;
            }, 3000);

            return;
        }

        if (this.lastDoorbellResetTimer) {
            clearTimeout(this.lastDoorbellResetTimer);
            this.lastDoorbellResetTimer = undefined;
        }

        this.binaryState = false;
    }

    async sendPiWsCommand(command: any, expectedType: string): Promise<any> {
        if (!this.piWs || !this.piWsConnected) {
            this.connectPiWebSocket();
        }

        if (!this.piWs || !this.piWsConnected) {
            throw new Error('Pi WebSocket is not connected');
        }

        const message = JSON.stringify(command);

        this.console.log(`Pi WS TX: ${message}`);

        return new Promise((resolve, reject) => {
            const pending: PendingWsCommand = {
                expectedType,
                resolve,
                reject,
                timeout: setTimeout(() => {
                    this.pendingCommands = this.pendingCommands.filter(p => p !== pending);
                    reject(new Error(`Pi WebSocket command timeout waiting for ${expectedType}`));
                }, 5000),
            };

            this.pendingCommands.push(pending);

            try {
                this.piWs.send(message);
            } catch (e) {
                this.pendingCommands = this.pendingCommands.filter(p => p !== pending);
                clearTimeout(pending.timeout);
                reject(e);
            }
        });
    }

    resolvePendingWsCommand(event: any) {
        const index = this.pendingCommands.findIndex(p => p.expectedType === event.type);

        if (index < 0) {
            return;
        }

        const [pending] = this.pendingCommands.splice(index, 1);
        clearTimeout(pending.timeout);

        if (event.ok === false) {
            pending.reject(new Error(event.error || `Pi command failed: ${event.type}`));
        } else {
            pending.resolve(event);
        }
    }

    rejectPendingWsCommands(error: Error) {
        for (const pending of this.pendingCommands) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }

        this.pendingCommands = [];
    }

    async unlockDoor(): Promise<void> {
        const url = `${this.getPiBaseUrl()}/unlock`;

        this.console.log(`Unlocking via Pi HTTP primary: ${url}`);

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 4000);

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    signal: controller.signal,
                });

                const body = await response.text();

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status} ${response.statusText}: ${body}`);
                }

                this.console.log(`Unlock OK via HTTP: ${body}`);
                return;
            } finally {
                clearTimeout(timeout);
            }
        } catch (e) {
            this.console.warn(`Unlock via HTTP failed, falling back to WebSocket: ${e}`);
        }

        const response = await this.sendPiWsCommand({
            type: 'unlock',
        }, 'unlock');

        this.console.log(`Unlock OK via WebSocket fallback: ${JSON.stringify(response)}`);
    }

    // most cameras have motion and doorbell press events, but dont notify when the event ends.
    // so set a timeout ourselves to reset the state.
    triggerBinaryState() {
        this.console.log('Golmar doorbell pressed');
        this.binaryState = true;

        setTimeout(() => {
            this.console.log('Golmar doorbell released');
            this.binaryState = false;
        }, 1000);
    }

    // most cameras have motion events, but dont notify when the event ends.
    // so set a timeout ourselves to reset the state.
    triggerMotion() {
        this.console.log('Golmar motion detected');
        this.motionDetected = true;

        setTimeout(() => {
            this.console.log('Golmar motion cleared');
            this.motionDetected = false;
        }, 1000);
    }
}

class GolmarLockDevice extends ScryptedDeviceBase implements Lock {
    constructor(public plugin: GolmarCameraPlugin, nativeId: string) {
        super(nativeId);

        // De Golmar opener is momentary; normaal is hij dus "locked".
        this.lockState = LockState.Locked;
    }

    async unlock(): Promise<void> {
        this.console.log('HomeKit requested unlock');

        const intercom = await this.plugin.getDevice('golmar-intercom') as GolmarCameraDevice;
        await intercom.unlockDoor();

        this.lockState = LockState.Unlocked;

        setTimeout(() => {
            this.lockState = LockState.Locked;
        }, 2000);
    }

    async lock(): Promise<void> {
        // De fysieke opener kan niet actief "locken"; hij stopt vanzelf.
        this.console.log('HomeKit requested lock; Golmar opener is momentary, setting state to locked.');
        this.lockState = LockState.Locked;
    }
}

class GolmarCameraPlugin extends ScryptedDeviceBase implements DeviceProvider, Settings, DeviceCreator {
    devices = new Map<string, ScryptedDeviceBase>();

    settingsStorage = new StorageSettings(this, {
        email: {
            title: 'Email',
            onPut: async () => this.cleararTrySyncDevices(),
        },
        password: {
            title: 'Password',
            type: 'password',
            onPut: async () => this.cleararTrySyncDevices(),
        },
        twoFactorCode: {
            title: 'Two Factor Code',
            description: 'Optional: If 2 factor is enabled on your account, enter the code sent to your email or phone number.',
            onPut: async (oldValue, newValue) => {
                await this.tryLogin(newValue);
                await this.syncDevices(0);
            },
            noStore: true,
        },
    });

    constructor() {
        super();
        this.syncDevices(0);
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [
            {
                key: 'name',
                title: 'Name',
            }
        ];
    }

    async createDevice(settings: DeviceCreatorSettings): Promise<string> {
        const nativeId = Math.random().toString();

        await deviceManager.onDeviceDiscovered({
            nativeId,
            type: ScryptedDeviceType.Doorbell,
            interfaces: [
                ScryptedInterface.Camera,
                ScryptedInterface.VideoCamera,
                ScryptedInterface.MotionSensor,
                ScryptedInterface.BinarySensor,
                ScryptedInterface.Intercom,
                ScryptedInterface.Settings,
            ],
            name: settings.name?.toString(),
        });

        return nativeId;
    }

    cleararTrySyncDevices() {
        this.syncDevices(0);
    }

    async tryLogin(twoFactorCode?: string) {
        // no-op
    }

    getSettings(): Promise<Setting[]> {
        return this.settingsStorage.getSettings();
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.settingsStorage.putSetting(key, value);
    }

    async syncDevices(duration: number) {
        await this.tryLogin();

        const intercomNativeId = 'golmar-intercom';
        const lockNativeId = 'golmar-lock';

        const intercomInterfaces = [
        ScryptedInterface.Camera,
        ScryptedInterface.VideoCamera,
        ScryptedInterface.MotionSensor,
        ScryptedInterface.BinarySensor,
        ScryptedInterface.Intercom,
        ScryptedInterface.Settings,
        ];

        const lockInterfaces = [
        ScryptedInterface.Lock,
        ];

        const devices: Device[] = [
        {
            info: {
            model: '4+n Analog Intercom',
            manufacturer: 'Golmar',
            },
            nativeId: intercomNativeId,
            name: 'Golmar Intercom',
            type: ScryptedDeviceType.Doorbell,
            interfaces: intercomInterfaces,
        },
        {
            info: {
            model: 'Door Opener',
            manufacturer: 'Golmar',
            },
            nativeId: lockNativeId,
            name: 'Golmar Door Lock',
            type: ScryptedDeviceType.Lock,
            interfaces: lockInterfaces,
        },
        ];

        await deviceManager.onDevicesChanged({
        devices,
        });

        this.console.log('discovered Golmar Intercom doorbell and lock devices');

    }

    async getDevice(nativeId: string) {
    if (!this.devices.has(nativeId)) {
        let device: ScryptedDeviceBase;

        if (nativeId === 'golmar-lock') {
        device = new GolmarLockDevice(this, nativeId);
        }
        else {
        device = new GolmarCameraDevice(this, nativeId);
        }

        this.devices.set(nativeId, device);
    }

    return this.devices.get(nativeId);
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        const device = this.devices.get(nativeId);

        if (device) {
            this.devices.delete(nativeId);
        }
    }
}

export default GolmarCameraPlugin;