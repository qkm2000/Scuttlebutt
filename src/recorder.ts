export class MeetingRecorder {
	private mediaRecorder: MediaRecorder | null = null;
	private stream: MediaStream | null = null;
	private sources: MediaStream[] = [];
	private audioContext: AudioContext | null = null;
	private chunks: Blob[] = [];
	private mimeType = 'audio/webm';
	private starting = false;

	isRecording(): boolean {
		return this.mediaRecorder?.state === 'recording';
	}

	isPaused(): boolean {
		return this.mediaRecorder?.state === 'paused';
	}

	/** True while a recording exists and is either capturing or paused. */
	isActive(): boolean {
		const st = this.mediaRecorder?.state;
		return st === 'recording' || st === 'paused';
	}

	pause(): void {
		if (this.mediaRecorder?.state === 'recording') this.mediaRecorder.pause();
	}

	resume(): void {
		if (this.mediaRecorder?.state === 'paused') this.mediaRecorder.resume();
	}

	async start(opts: {
		inputDeviceId?: string;
		systemAudioDeviceId?: string;
		captureSystemAudio: boolean;
	}): Promise<{ systemAudio: boolean }> {
		// A re-entrant start (double-click, ribbon + command) is a no-op — otherwise the
		// second call orphans the first mic MediaStream, leaving the mic captured.
		if (this.starting || this.isRecording()) return { systemAudio: false };
		this.starting = true;
		try {
		// Microphone — the base track. Mic processing (echo cancellation, noise
		// suppression) is on; a system/loopback source below is captured raw so that
		// processing doesn't gate it.
		const micConstraints: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true };
		if (opts.inputDeviceId) micConstraints.deviceId = { exact: opts.inputDeviceId };
		const micStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: micConstraints });
		this.sources = [micStream];
		let systemAudio = false;

		// System audio as a second *input* device (e.g. a BlackHole/aggregate loopback
		// on macOS). This is the reliable way to capture system/meeting audio; it's
		// mixed with the mic into one track.
		if (opts.systemAudioDeviceId && opts.systemAudioDeviceId !== opts.inputDeviceId) {
			try {
				const sysStream = await navigator.mediaDevices.getUserMedia({
					video: false,
					audio: { deviceId: { exact: opts.systemAudioDeviceId } },
				});
				this.sources.push(sysStream);
				systemAudio = true;
			} catch {
				/* device unavailable — degrade to whatever else we have */
			}
		}

		// System audio via a screen-share prompt (works on some platforms, not reliably
		// on macOS). Kept as an alternative to the loopback-device route above.
		if (opts.captureSystemAudio) {
			try {
				const screen = await navigator.mediaDevices
					.getDisplayMedia({ video: true, audio: true })
					.catch(() => null);
				if (screen) {
					if (screen.getAudioTracks().length > 0) {
						this.sources.push(new MediaStream(screen.getAudioTracks()));
						systemAudio = true;
					}
					screen.getVideoTracks().forEach((t) => t.stop());
				}
			} catch {
				/* ignore — degrade gracefully */
			}
		}

		// A single source records directly; multiple sources are mixed into one track.
		this.stream = this.sources.length > 1 ? this.mix(this.sources) : micStream;

		const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
		this.mimeType = candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'audio/webm';

		this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: this.mimeType });
		this.chunks = [];
		this.mediaRecorder.ondataavailable = (e) => {
			if (e.data && e.data.size > 0) this.chunks.push(e.data);
		};
		this.mediaRecorder.start(1000);
		return { systemAudio };
		} catch (err) {
			// A failure after getUserMedia (e.g. the MediaRecorder ctor throwing) must not
			// leave mic/loopback tracks or the AudioContext open.
			this.cleanup();
			throw err;
		} finally {
			this.starting = false;
		}
	}

	/** Mix several audio streams down to a single MediaStream via the Web Audio graph. */
	private mix(streams: MediaStream[]): MediaStream {
		this.audioContext = new AudioContext();
		const dest = this.audioContext.createMediaStreamDestination();
		for (const s of streams) {
			for (const track of s.getAudioTracks()) {
				this.audioContext.createMediaStreamSource(new MediaStream([track])).connect(dest);
			}
		}
		return dest.stream;
	}

	stop(): Promise<Blob> {
		return new Promise((resolve) => {
			if (!this.mediaRecorder) {
				resolve(new Blob());
				return;
			}
			this.mediaRecorder.onstop = () => {
				const blob = new Blob(this.chunks, { type: this.mimeType });
				this.cleanup();
				resolve(blob);
			};
			this.mediaRecorder.stop();
		});
	}

	getMimeType(): string {
		return this.mimeType;
	}

	private cleanup() {
		// Stop every raw source (mic + any system/loopback + display) as well as the
		// final (possibly mixed) stream, so no device is left in use.
		for (const s of this.sources) {
			for (const track of s.getTracks()) track.stop();
		}
		this.sources = [];
		if (this.stream) {
			for (const track of this.stream.getTracks()) track.stop();
			this.stream = null;
		}
		if (this.audioContext) {
			this.audioContext.close().catch(() => {});
			this.audioContext = null;
		}
		this.mediaRecorder = null;
		this.chunks = [];
	}

	abort() {
		if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
			try {
				this.mediaRecorder.stop();
			} catch {
				/* ignore */
			}
		}
		this.cleanup();
	}
}
