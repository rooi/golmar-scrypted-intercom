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
    OnOff,
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

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

const { deviceManager, mediaManager } = sdk;

const GOLMAR_INTERCOM_NATIVE_ID = 'golmar-intercom';
const PACKAGE_MODE_NATIVE_ID = 'golmar-package-mode';

const PACKAGE_MODE_DURATION_MS = 8 * 60 * 60 * 1000;

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
            description: 'Example: ws://192.168.1.123:8766',
            defaultValue: 'ws://192.168.1.123:8766',
        },
        syntheticRtspUrl: {
            title: 'Synthetic Stream RTSP URL',
            description: 'RTSP Rebroadcast URL from the Scrypted Synthetic Stream device. Example: rtsp://127.0.0.1:xxxxx/...',
            defaultValue: '',
        },
        snapshotUrl: {
            title: 'Snapshot URL',
            description: 'Optional JPEG snapshot URL. Leave empty to use Pi Agent /snapshot.jpg.',
            defaultValue: '',
        },
    });

    private piWs: any;
    private piWsConnected = false;
    private reconnectTimer: any;
    private pendingCommands: PendingWsCommand[] = [];
    private lastDoorbellResetTimer: any;

    private intercomProcess?: ChildProcessWithoutNullStreams;

    private lastSnapshot?: Buffer;
    private lastSnapshotTime = 0;
    private readonly snapshotCacheMs = 15000;

    constructor(public plugin: GolmarCameraPlugin, nativeId: string) {
        super(nativeId);

        // Start iets later zodat Scrypted/device init rustig klaar is.
        setTimeout(() => this.connectPiWebSocket(), 1000);
    }

    async takePicture(options?: PictureOptions): Promise<MediaObject> {
        const now = Date.now();

        // Korte cache voorkomt dat Scrypted/HomeKit meerdere snapshots tegelijk opvraagt.
        if (this.lastSnapshot && now - this.lastSnapshotTime < this.snapshotCacheMs) {
            return mediaManager.createMediaObject(this.lastSnapshot, 'image/jpeg');
        }

        const snapshotUrl = this.getSnapshotUrl();

        this.console.log(`Fetching snapshot: ${snapshotUrl}`);

        try {
            const response = await fetch(snapshotUrl);

            if (!response.ok) {
                throw new Error(`Snapshot failed: ${response.status} ${response.statusText}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            if (!buffer.length) {
                throw new Error('Snapshot response was empty');
            }

            this.lastSnapshot = buffer;
            this.lastSnapshotTime = now;

            return mediaManager.createMediaObject(buffer, 'image/jpeg');
        } catch (e) {
            this.console.warn(`Snapshot fetch failed: ${e}`);

            // Fallback: toon de laatst succesvolle snapshot als die er is.
            if (this.lastSnapshot) {
                return mediaManager.createMediaObject(this.lastSnapshot, 'image/jpeg');
            }

            throw e;
        }
    }

    async getPictureOptions(): Promise<PictureOptions[]> {
        return [];
    }

    async getVideoStream(options?: MediaStreamOptions): Promise<MediaObject> {
        this.console.log(`getVideoStream requested: ${JSON.stringify(options)}`);

        const syntheticRtspUrl = this.getSyntheticRtspUrl();
        const micUrl = `${this.getPiBaseUrl()}/mic/ulaw`;

        if (!syntheticRtspUrl) {
            throw new Error('Synthetic Stream RTSP URL is not configured. Set it in the Golmar device settings.');
        }

        this.console.log(`Using synthetic RTSP video URL: ${syntheticRtspUrl}`);
        this.console.log(`Using mic URL: ${micUrl}`);

        const ffmpegInput: FFmpegInput = {
            inputArguments: [
                // Audio van de Golmar/Pi-agent.
                '-fflags', 'nobuffer',
                '-flags', 'low_delay',
                '-probesize', '32',
                '-analyzeduration', '0',
                '-f', 'mulaw',
                '-ar', '8000',
                '-ac', '1',
                '-i', micUrl,

                // Video uit de Scrypted Synthetic Stream.
                '-rtsp_transport', 'tcp',
                '-i', syntheticRtspUrl,

                // Gebruik audio van Pi-agent en video van synthetic stream.
                '-map', '1:v:0',
                '-map', '0:a:0',
            ],
        };

        return mediaManager.createMediaObject(
            Buffer.from(JSON.stringify(ffmpegInput)),
            ScryptedMimeTypes.FFmpegInput
        );
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        return [{
            id: 'stream',
            name: 'Golmar Stream',
            video: {
                codec: 'h264',
            },
            audio: {
                codec: 'pcm_mulaw',
            },
        }];
    }

    async startIntercom(media: MediaObject): Promise<void> {
        this.console.log('Intercom start requested');

        await this.stopIntercom();

        const ffmpegInput: FFmpegInput = JSON.parse(
            (await mediaManager.convertMediaObjectToBuffer(
                media,
                ScryptedMimeTypes.FFmpegInput
            )).toString()
        );

        this.console.log(`Intercom ffmpeg input: ${JSON.stringify(ffmpegInput)}`);

        const ffmpegPath = await mediaManager.getFFmpegPath();
        const outputUrl = `${this.getPiBaseUrl()}/speaker/raw`;

        let inputArguments: string[];

        // HomeKit/Safari geven meestal een lokale RTSP bron terug.
        // Forceer TCP, want zonder dit zie je:
        // method SETUP failed: 461 Unsupported Transport
        if ((ffmpegInput as any).url && (ffmpegInput as any).url.toString().startsWith('rtsp://')) {
            inputArguments = [
                '-rtsp_transport', 'tcp',
                '-acodec', 'libopus',
                '-i', (ffmpegInput as any).url.toString(),
            ];
        } else {
            inputArguments = ffmpegInput.inputArguments || [];

            // Als Scrypted al inputArguments geeft met een RTSP URL maar zonder tcp,
            // voeg tcp dan alsnog vóór de input toe.
            const hasRtspInput = inputArguments.some(arg => typeof arg === 'string' && arg.startsWith('rtsp://'));
            const hasRtspTransport = inputArguments.includes('-rtsp_transport');

            if (hasRtspInput && !hasRtspTransport) {
                inputArguments = [
                    '-rtsp_transport', 'tcp',
                    ...inputArguments,
                ];
            }
        }

        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-nostdin',

            ...inputArguments,

            '-vn',

            // Telefoonbandbreedte + limiter. Volume kun je later finetunen.
            '-af', 'highpass=f=300,lowpass=f=3400,volume=8,alimiter=limit=0.85',

            // Pi endpoint verwacht raw PCM.
            // Zonder -f s16le krijg je:
            // Unable to choose an output format for http://.../speaker/raw
            '-acodec', 'pcm_s16le',
            '-ac', '1',
            '-ar', '48000',
            '-f', 's16le',

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

        if (!this.intercomProcess) {
            return;
        }

        try {
            this.intercomProcess.kill('SIGTERM');
        } catch (e) {
            this.console.warn(`Failed to stop intercom ffmpeg: ${e}`);
        }

        this.intercomProcess = undefined;
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
                key: 'packageUnlockDoor',
                title: 'Package Unlock Door',
                description: 'Call the Pi agent /package-unlock endpoint.',
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

        if (key === 'packageUnlockDoor') {
           await this.packageUnlockDoor();
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

        if (key === 'snapshotUrl') {
            this.lastSnapshot = undefined;
            this.lastSnapshotTime = 0;
        }
    }

    getPiBaseUrl(): string {
        return (this.settingsStorage.values.piBaseUrl as string || 'http://192.168.1.123:8765').replace(/\/$/, '');
    }

    getPiWsUrl(): string {
        return (this.settingsStorage.values.piWsUrl as string || 'ws://192.168.1.123:8766').replace(/\/$/, '');
    }

    getSyntheticRtspUrl(): string {
        return (this.settingsStorage.values.syntheticRtspUrl as string || '').trim();
    }

    getSnapshotUrl(): string {
        const configuredSnapshotUrl = (this.settingsStorage.values.snapshotUrl as string || '').trim();

        if (configuredSnapshotUrl) {
            return configuredSnapshotUrl;
        }

        return `${this.getPiBaseUrl()}/snapshot.jpg`;
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

            // Pakketmodus wordt alleen op een echte "pressed=true" deurbel-event geëvalueerd.
            // Niet awaiten: deurbel-state en HomeKit responsiveness blijven snel.
            void this.plugin.handlePackageModeDoorbell(this).catch(e => {
            this.console.error(`Package mode doorbell handling failed: ${e}`);
            });

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

    // Most cameras have doorbell press events, but don't notify when the event ends.
    // So set a timeout ourselves to reset the state.
    triggerBinaryState() {
        this.console.log('Golmar doorbell pressed');
        this.binaryState = true;

        void this.plugin.handlePackageModeDoorbell(this).catch(e => {
            this.console.error(`Package mode simulated doorbell handling failed: ${e}`);
        });

        setTimeout(() => {
            this.console.log('Golmar doorbell released');
            this.binaryState = false;
        }, 1000);
    }

    async packageUnlockDoor(): Promise<void> {
        const url = `${this.getPiBaseUrl()}/package-unlock`;

        this.console.log(`Package unlock via Pi HTTP: ${url}`);

        const response = await fetch(url, {
            method: 'POST',
        });

        const body = await response.text();

        if (!response.ok) {
            throw new Error(`Package unlock failed: ${response.status} ${response.statusText}: ${body}`);
        }

        this.console.log(`Package unlock OK via HTTP: ${body}`);
    }

    // Most cameras have motion events, but don't notify when the event ends.
    // So set a timeout ourselves to reset the state.
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

        const intercom = await this.plugin.getDevice(GOLMAR_INTERCOM_NATIVE_ID) as GolmarCameraDevice;
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

class GolmarPackageModeSwitch extends ScryptedDeviceBase implements OnOff {
    constructor(public plugin: GolmarCameraPlugin, nativeId: string) {
        super(nativeId);
        this.refreshState();
    }

    refreshState() {
        this.on = this.plugin.isPackageModeEnabled();
    }

    async turnOn(): Promise<void> {
        await this.plugin.setPackageMode(true, 'homekit');
    }

    async turnOff(): Promise<void> {
        await this.plugin.setPackageMode(false, 'homekit');
    }
}

class GolmarCameraPlugin extends ScryptedDeviceBase implements DeviceProvider, Settings, DeviceCreator {
    devices = new Map<string, any>();

    private packageModeExpiryTimer: any;
    private packageUnlockInFlight = false;

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
        this.schedulePackageModeExpiryFromStorage();
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
                nativeId: GOLMAR_INTERCOM_NATIVE_ID,
                name: 'Golmar Intercom',
                type: ScryptedDeviceType.Doorbell,
                interfaces: intercomInterfaces,
            },
            {
                info: {
                    model: 'Door Opener',
                    manufacturer: 'Golmar',
                },
                nativeId: 'golmar-lock',
                name: 'Golmar Door Lock',
                type: ScryptedDeviceType.Lock,
                interfaces: lockInterfaces,
            },
            {
                info: {
                    model: 'Package Mode Switch',
                    manufacturer: 'Golmar',
                },
                nativeId: PACKAGE_MODE_NATIVE_ID,
                name: 'Pakketmodus',
                type: ScryptedDeviceType.Switch,
                interfaces: [
                    ScryptedInterface.OnOff,
                ],
            },
        ];

        await deviceManager.onDevicesChanged({
            devices,
        });

        this.console.log('discovered Golmar Intercom doorbell, lock device and Pakketmodus switch');
    }

    async getDevice(nativeId: string) {
        if (!this.devices.has(nativeId)) {
            let device: ScryptedDeviceBase;

            if (nativeId === GOLMAR_INTERCOM_NATIVE_ID) {
                device = new GolmarCameraDevice(this, nativeId);
            }
            else if (nativeId === 'golmar-lock') {
                device = new GolmarLockDevice(this, nativeId);
            }
            else if (nativeId === PACKAGE_MODE_NATIVE_ID) {
                device = new GolmarPackageModeSwitch(this, nativeId);
            }
            else {
                throw new Error(`Unknown nativeId: ${nativeId}`);
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

    getPackageModeExpiresAt(): number {
        return Number(this.storage.getItem('packageModeExpiresAt') || '0');
    }

    isPackageModeEnabled(): boolean {
        const enabled = this.storage.getItem('packageMode') === 'true';

        if (!enabled) {
            return false;
        }

        const expiresAt = this.getPackageModeExpiresAt();

        if (expiresAt > 0 && Date.now() >= expiresAt) {
            this.console.log('Package mode expired while checking state');
            void this.setPackageMode(false, 'expired');
            return false;
        }

        return true;
    }

    isPackageModeUsed(): boolean {
        return this.storage.getItem('packageModeUsed') === 'true';
    }

    getPackageModeSwitch(): GolmarPackageModeSwitch | undefined {
        const device = this.devices.get(PACKAGE_MODE_NATIVE_ID);

        if (device instanceof GolmarPackageModeSwitch) {
            return device;
        }

        return undefined;
    }

    updatePackageModeSwitchState() {
        const packageSwitch = this.getPackageModeSwitch();

        if (packageSwitch) {
            packageSwitch.on = this.isPackageModeEnabled();
        }
    }

    async setPackageMode(enabled: boolean, reason: string): Promise<void> {
        if (enabled) {
            const expiresAt = Date.now() + PACKAGE_MODE_DURATION_MS;

            this.storage.setItem('packageMode', 'true');
            this.storage.setItem('packageModeUsed', 'false');
            this.storage.setItem('packageModeExpiresAt', expiresAt.toString());

            this.console.log(
            `Package mode enabled by ${reason}, expiresAt=${new Date(expiresAt).toISOString()}`
            );

            this.schedulePackageModeExpiry(expiresAt);
        }
        else {
            this.storage.setItem('packageMode', 'false');
            this.storage.setItem('packageModeUsed', 'false');
            this.storage.setItem('packageModeExpiresAt', '0');

            if (this.packageModeExpiryTimer) {
            clearTimeout(this.packageModeExpiryTimer);
            this.packageModeExpiryTimer = undefined;
            }

            this.console.log(`Package mode disabled by ${reason}`);
        }

        this.updatePackageModeSwitchState();
    }

    schedulePackageModeExpiryFromStorage() {
        if (!this.isPackageModeEnabled()) {
            return;
        }

        const expiresAt = this.getPackageModeExpiresAt();

        if (expiresAt > 0) {
            this.schedulePackageModeExpiry(expiresAt);
        }
    }

    schedulePackageModeExpiry(expiresAt: number) {
        if (this.packageModeExpiryTimer) {
            clearTimeout(this.packageModeExpiryTimer);
            this.packageModeExpiryTimer = undefined;
        }

        const delay = Math.max(0, expiresAt - Date.now());

        this.packageModeExpiryTimer = setTimeout(() => {
            this.packageModeExpiryTimer = undefined;

            this.console.log('Package mode automatically expired after 8 hours');

            void this.setPackageMode(false, 'expiry-timer').catch(e => {
            this.console.error(`Failed to disable expired package mode: ${e}`);
            });
        }, delay);
    }

    async handlePackageModeDoorbell(camera: GolmarCameraDevice): Promise<void> {
        if (this.packageUnlockInFlight) {
            this.console.warn('Package mode ignored: package unlock already in flight');
            return;
        }

        if (!this.isPackageModeEnabled()) {
            return;
        }

        if (this.isPackageModeUsed()) {
            this.console.warn('Package mode ignored: already used');
            return;
        }

        this.packageUnlockInFlight = true;

        // Consumeer pakketmodus vóór de HTTP-call.
        // Dit voorkomt dubbele opens als er meerdere doorbell-events of timeouts zijn.
        this.storage.setItem('packageModeUsed', 'true');

        try {
            this.console.log('Package mode doorbell accepted: calling /package-unlock');

            await camera.packageUnlockDoor();

            this.console.log('Package mode unlock completed; disabling package mode');

            await this.setPackageMode(false, 'used');
        }
        catch (e) {
            this.console.error(`Package mode unlock failed or was rejected: ${e}`);

            // Veiligheidskeuze: ook bij fout package mode uitzetten.
            // Als de Pi wel opende maar de response faalde, voorkom je een tweede poging.
            await this.setPackageMode(false, 'package-unlock-error');
        }
        finally {
            this.packageUnlockInFlight = false;
        }
    }
}

export default GolmarCameraPlugin;