/**
 * TTS audio playback — write WAV to a temp file, spawn a platform player,
 * abort cleanly on signal. v6.0 ships file-based playback for simplicity;
 * stdin-streaming for sub-200ms TTFB is a v6.1 optimization.
 *
 * Both backends produce a complete WAV blob:
 *   - Local engine returns Float32Array PCM → encoded to WAV here
 *   - Deepgram REST returns WAV bytes directly (container=wav)
 *
 * Concurrency contract: each play() call owns its own temp file. Two
 * concurrent calls write to distinct UUID-named files and spawn distinct
 * player processes. The caller is responsible for serializing if it
 * doesn't want overlapping audio (the speak orchestrator does this).
 *
 * Security model:
 *   - Player invoked via `child_process.spawn(cmd, [args])` — argument
 *     array, no shell, no string interpolation. Cannot be hijacked by a
 *     malicious TMPDIR with shell metacharacters.
 *   - Windows uses an env-var indirection ($env:PI_SPEAK_PATH) so paths
 *     containing single quotes (e.g. C:\Users\O'Neil\...) cannot inject
 *     into the PowerShell command string.
 *   - Temp filenames are randomUUID — no user input in the name.
 *   - Files are written 0600 and asserted to live under os.tmpdir().
 *   - Cleanup uses a single-ownership token: the playback Promise's
 *     `finally` block is the ONLY code path that unlinks. Abort kills
 *     the player but leaves cleanup to that finally.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Audio source for playback. Either:
 *   - { wav: Uint8Array }                     — pre-encoded WAV bytes
 *   - { samples: Float32Array; sampleRate }   — raw float PCM, encoded here
 */
export type PlaybackSource =
	| { wav: Uint8Array }
	| { samples: Float32Array; sampleRate: number };

export interface PlayOpts {
	source: PlaybackSource;
	signal?: AbortSignal;
	/**
	 * Override the player command for testing. Production callers leave
	 * this unset so we pick by `process.platform`.
	 */
	playerOverride?: PlayerSpec;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Play `source` to the user's default audio output and resolve when
 * playback finishes. Aborts cleanly via `opts.signal`.
 *
 * Resolves with `void` on successful completion. Rejects with:
 *   - DOMException("AbortError") if signal fires
 *   - Error("No audio player found...") if platform player can't be spawned
 *   - Error("Audio player exited with code N") on non-zero exit
 */
export async function play(opts: PlayOpts): Promise<void> {
	const { source, signal } = opts;

	if (signal?.aborted) {
		throw makeAbortError();
	}

	const wav = "wav" in source
		? source.wav
		: encodeWav(source.samples, source.sampleRate);

	const tmpFile = createTempWavPath();
	let cleanupDone = false;
	const cleanup = () => {
		if (cleanupDone) return;
		cleanupDone = true;
		try { fs.unlinkSync(tmpFile); } catch { /* may already be gone */ }
	};

	// Single-ownership unlink: the `finally` below is the ONLY code path
	// that removes the temp file. Abort kills the player via Node's
	// native `signal` option on spawn(); the player exit triggers the
	// same finally. No double-delete possible.

	try {
		// Write the WAV with 0600 perms so other users on a multi-user box
		// cannot read TTS output (transcripts can be sensitive even though
		// they're agent-generated).
		fs.writeFileSync(tmpFile, wav, { mode: 0o600 });

		// Re-check abort after the sync write — if user hit Escape during
		// the write, no point spawning the player.
		if (signal?.aborted) throw makeAbortError();

		const player = opts.playerOverride ?? choosePlayer();
		const env = player.env ? { ...process.env, ...player.env(tmpFile) } : process.env;

		const proc: ChildProcess = spawn(player.cmd, player.args(tmpFile), {
			stdio: ["ignore", "ignore", "pipe"], // capture stderr for error messages
			env,
			// Node's native abort plumbing — when `signal` aborts, Node
			// kills the child process atomically. Single source of kills,
			// no race window between "abort fires" and "we look up proc to
			// kill" (which a hand-rolled addEventListener would have).
			...(signal ? { signal } : {}),
		});

		await new Promise<void>((resolve, reject) => {
			// Node can emit BOTH "error" (with AbortError) and "close" for
			// the same termination — the order is racy. `settled` ensures
			// exactly one settlement reaches the await.
			let settled = false;
			const settle = (action: () => void) => {
				if (settled) return;
				settled = true;
				action();
			};

			let stderr = "";
			const STDERR_CAP = 2048;
			proc.stderr?.on("data", (d: Buffer) => {
				// Cap BEFORE appending so a single multi-MB chunk can't
				// blow past the budget. Truncate the chunk to the
				// remaining headroom; once full, drop further chunks.
				if (stderr.length >= STDERR_CAP) return;
				const headroom = STDERR_CAP - stderr.length;
				const text = d.toString();
				stderr += text.length > headroom ? text.slice(0, headroom) : text;
			});
			proc.on("error", (err: NodeJS.ErrnoException) => {
				settle(() => {
					// Node fires "error" with AbortError when the native
					// signal aborts; also when spawn() itself fails (ENOENT
					// etc.). Distinguish by err.name.
					if (err.name === "AbortError" || signal?.aborted) {
						reject(makeAbortError());
					} else {
						reject(new Error(`Audio player ${player.cmd} failed to start: ${err.message}`));
					}
				});
			});
			proc.on("close", (code, sig) => {
				settle(() => {
					// Order matters: a clean exit (code === 0) ALWAYS wins,
					// even if the abort signal fired in the microtask gap
					// between the player finishing and the close handler
					// running. The reverse — surfacing AbortError on a
					// successfully-played audio — would be wrong UX.
					if (code === 0) {
						resolve();
					} else if (signal?.aborted) {
						reject(makeAbortError());
					} else if (sig) {
						reject(new Error(`Audio player ${player.cmd} terminated by ${sig}`));
					} else {
						const tail = stderr.trim().slice(-200);
						reject(new Error(
							`Audio player ${player.cmd} exited with code ${code}` +
							(tail ? ` (${tail})` : ""),
						));
					}
				});
			});
		});
	} finally {
		cleanup();
	}
}

// ─── Player selection ─────────────────────────────────────────────────────────

interface PlayerSpec {
	cmd: string;
	args: (path: string) => string[];
	/**
	 * Optional environment variables. The Windows player uses this to pass
	 * the path via $env:PI_SPEAK_PATH instead of substituting it into the
	 * PowerShell command string — defeats injection via paths containing `'`.
	 */
	env?: (path: string) => NodeJS.ProcessEnv;
}

/**
 * Choose a platform-appropriate player. Throws with an actionable message
 * if no player is recognized — the message guides the user to install
 * something compatible.
 *
 * Linux prefers paplay (PulseAudio / PipeWire compat) but falls back to
 * aplay (raw ALSA). The fallback is decided at spawn time, not here, so
 * we pick paplay first and let the caller observe spawn failure to retry
 * with aplay. See the inline comment on linuxPlayer below.
 */
function choosePlayer(): PlayerSpec {
	switch (process.platform) {
		case "darwin":
			return {
				cmd: "afplay",
				args: (p) => [p],
			};
		case "linux":
			return linuxPlayer();
		case "win32":
			// PowerShell SoundPlayer reads from $env:PI_SPEAK_PATH so the
			// path is never interpolated into the command string. Defends
			// against any path that contains single quotes or other
			// PowerShell metacharacters.
			return {
				cmd: "powershell",
				args: () => [
					"-NoProfile",
					"-Command",
					"$p = $env:PI_SPEAK_PATH; (New-Object Media.SoundPlayer $p).PlaySync()",
				],
				env: (p) => ({ PI_SPEAK_PATH: p }),
			};
		default:
			throw new Error(
				`No audio player configured for platform: ${process.platform}. ` +
				`Supported: darwin, linux, win32.`,
			);
	}
}

/**
 * Linux player selection. We default to paplay (PulseAudio / PipeWire
 * compat shim) because almost all modern desktop distros run pulse or
 * pipewire-pulse. If paplay isn't installed, callers will get
 * `spawn paplay ENOENT`; the caller (speak orchestrator) can detect that
 * and surface "install paplay or aplay" — we don't probe here because
 * `which paplay` would add an extra spawn per playback.
 *
 * Users who only have aplay can override via the (future) settings-panel
 * "audio player" option. v6.0 does not surface that knob; v6.1 adds it
 * if field reports show it's needed.
 */
function linuxPlayer(): PlayerSpec {
	return {
		cmd: "paplay",
		args: (p) => [p],
	};
}

// ─── Temp file ────────────────────────────────────────────────────────────────

function createTempWavPath(): string {
	const tmpdir = os.tmpdir();
	const file = path.join(tmpdir, `pi-speak-${randomUUID()}.wav`);
	// Defense in depth: assert the file lives under tmpdir, in case
	// path.join somehow ate a `..` (it shouldn't, but the assertion is
	// nearly free and pins down the invariant).
	const rel = path.relative(tmpdir, file);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`Refusing to write outside tmpdir: ${file}`);
	}
	return file;
}

// ─── WAV encoding ─────────────────────────────────────────────────────────────

/**
 * Encode Float32 PCM samples in [-1, 1] as a mono 16-bit signed-LE WAV.
 * Standard 44-byte RIFF header followed by sample data.
 *
 * No external deps so this works in the smoke test sandbox where
 * sherpa.writeWave isn't loaded. Float-to-int16 clamps to [-32768, 32767]
 * to handle out-of-range values from the engine without wrap-around
 * artifacts.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
		throw new Error(`Invalid sample rate: ${sampleRate}`);
	}
	const numSamples = samples.length;
	// WAV header chunk-size fields are uint32 — `36 + dataLen` must fit.
	// 4 GiB total is the spec maximum; we cap at ~2 GiB of PCM data
	// (1,073,741,800 bytes) which is roughly 6 hours at 24 kHz mono.
	// Anything longer is almost certainly a programmer error in chunking
	// upstream — surface it loudly rather than emitting a corrupt header.
	const MAX_DATA_BYTES = 0xFFFFFFFF - 36;
	if (numSamples > MAX_DATA_BYTES / 2) {
		throw new Error(
			`encodeWav: ${numSamples} samples exceeds WAV uint32 limit. ` +
			`Chunk the input upstream (e.g. via Intl.Segmenter sentence chunking).`,
		);
	}
	const byteRate = sampleRate * 2; // mono * 16-bit (channels * bytesPerSample)
	const dataLen = numSamples * 2;
	const buf = new ArrayBuffer(44 + dataLen);
	const view = new DataView(buf);

	// "RIFF" chunk descriptor
	writeAscii(view, 0, "RIFF");
	view.setUint32(4, 36 + dataLen, true); // chunk size = file size - 8
	writeAscii(view, 8, "WAVE");

	// "fmt " sub-chunk
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true);          // PCM fmt chunk size
	view.setUint16(20, 1, true);           // format = 1 (PCM)
	view.setUint16(22, 1, true);           // channels = 1 (mono)
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, 2, true);           // block align = channels * bytes-per-sample
	view.setUint16(34, 16, true);          // bits per sample

	// "data" sub-chunk
	writeAscii(view, 36, "data");
	view.setUint32(40, dataLen, true);

	// PCM samples — replace non-finite values with 0 (silence) instead of
	// letting Math.max/min coerce NaN to -1. A NaN sample slipping through
	// would otherwise produce a single-sample DC offset spike on output.
	// 0 is the correct silent-sample value for signed PCM.
	let offset = 44;
	for (let i = 0; i < numSamples; i++) {
		const raw = samples[i]!;
		const finite = Number.isFinite(raw) ? raw : 0;
		const s = Math.max(-1, Math.min(1, finite));
		const i16 = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
		view.setInt16(offset, i16, true);
		offset += 2;
	}

	return new Uint8Array(buf);
}

function writeAscii(view: DataView, offset: number, str: string): void {
	for (let i = 0; i < str.length; i++) {
		view.setUint8(offset + i, str.charCodeAt(i));
	}
}

// ─── Errors ───────────────────────────────────────────────────────────────────

function makeAbortError(): Error {
	if (typeof DOMException === "function") {
		return new DOMException("Audio playback aborted", "AbortError");
	}
	const e = new Error("Audio playback aborted");
	(e as any).name = "AbortError";
	return e;
}
