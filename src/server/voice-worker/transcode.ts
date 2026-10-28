/** μ-law bias from ITU-T G.711. */
const MULAW_BIAS = 0x84;

/**
 * One μ-law byte to a 16-bit PCM sample (ITU-T G.711 decode). Twilio media
 * frames carry μ-law at 8 kHz; the speech service wants PCM at 16 kHz.
 */
export function mulawDecodeSample(byte: number): number {
  const uVal = ~byte & 0xff;
  let sample = ((uVal & 0x0f) << 3) + MULAW_BIAS;
  sample <<= (uVal & 0x70) >> 4;
  return (uVal & 0x80) !== 0 ? MULAW_BIAS - sample : sample - MULAW_BIAS;
}

/** A μ-law frame to signed 16-bit PCM samples at 8 kHz. */
export function mulawToPcm16(frames: Uint8Array): Int16Array {
  const samples = new Int16Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    samples[i] = mulawDecodeSample(frames[i] ?? 0);
  }
  return samples;
}

/**
 * 8 kHz to 16 kHz by sample doubling (zero-order hold): stateless across
 * frames, and plenty for transcription.
 */
export function upsample8kTo16k(samples: Int16Array): Int16Array {
  const upsampled = new Int16Array(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] ?? 0;
    upsampled[i * 2] = sample;
    upsampled[i * 2 + 1] = sample;
  }
  return upsampled;
}

/** One Twilio media payload to little-endian PCM 16 kHz bytes. */
export function mulaw8kToPcm16k(frames: Uint8Array): Uint8Array {
  const samples = upsample8kTo16k(mulawToPcm16(frames));
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}
