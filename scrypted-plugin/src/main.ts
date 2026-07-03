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
            }
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
            this.bumpStreamGeneration('Pi WebSocket connected');
            this.console.log(`Pi WebSocket connected: ${url}`);
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
            this.bumpStreamGeneration('Pi WebSocket closed');

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
        this.console.log('Unlocking via Pi WebSocket');

        try {
            const response = await this.sendPiWsCommand({
                type: 'unlock',
            }, 'unlock');

            this.console.log(`Unlock OK via WebSocket: ${JSON.stringify(response)}`);
            return;
        } catch (e) {
            this.console.warn(`Unlock via WebSocket failed, falling back to HTTP: ${e}`);
        }

        const url = `${this.getPiBaseUrl()}/unlock`;
        this.console.log(`Unlocking via Pi HTTP fallback: ${url}`);

        const response = await fetch(url, {
            method: 'POST',
        });

        if (!response.ok) {
            throw new Error(`Unlock failed: ${response.status} ${response.statusText}`);
        }

        const body = await response.text();
        this.console.log(`Unlock OK via HTTP: ${body}`);
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