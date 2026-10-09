let ctx: AudioContext | null = null;
let muted = true;
let townTimer: number | null = null;

export function isMuted() {
  return muted;
}

function context() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(freq: number, dur: number, type: OscillatorType, gain = 0.05, slide = 0) {
  if (muted) return;
  const audio = context();
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, audio.currentTime);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), audio.currentTime + dur);
  amp.gain.setValueAtTime(gain, audio.currentTime);
  amp.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
  osc.connect(amp).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + dur);
}

export function play(kind: "click" | "page" | "coin" | "deny" | "chest") {
  if (kind === "click") tone(520, 0.06, "square", 0.04);
  if (kind === "page") {
    tone(330, 0.08, "square", 0.04);
    tone(520, 0.1, "square", 0.03);
  }
  if (kind === "coin") {
    tone(880, 0.08, "square", 0.05);
    setTimeout(() => tone(1320, 0.12, "square", 0.04), 70);
  }
  if (kind === "deny") tone(140, 0.14, "sawtooth", 0.03, -60);
  if (kind === "chest") {
    tone(180, 0.05, "square", 0.04);
    tone(90, 0.16, "triangle", 0.05, 40);
  }
}

const MELODY = [523, 587, 659, 784, 659, 587, 523, 659, 698, 659, 587, 523, 494, 523, 587, 659];
const BASS = [196, 196, 247, 220, 196, 175, 220, 196];
const BEAT = 0.48;

function blip(audio: AudioContext, dest: AudioNode, freq: number, when: number, dur: number, type: OscillatorType, vel: number) {
  const osc = audio.createOscillator();
  const amp = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, when);
  amp.gain.setValueAtTime(0.0001, when);
  amp.gain.exponentialRampToValueAtTime(vel, when + 0.04);
  amp.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.connect(amp).connect(dest);
  osc.start(when);
  osc.stop(when + dur + 0.02);
}

function stopTown() {
  if (townTimer !== null) {
    window.clearInterval(townTimer);
    townTimer = null;
  }
}

function startTown() {
  const audio = context();
  stopTown();
  const master = audio.createGain();
  master.gain.value = 0.045;
  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1400;
  master.connect(filter).connect(audio.destination);
  let step = 0;
  const tick = () => {
    if (muted) return;
    const when = audio.currentTime + 0.05;
    blip(audio, master, MELODY[step % MELODY.length], when, BEAT * 0.85, "triangle", 0.22);
    if (step % 2 === 0) blip(audio, master, BASS[(step / 2) % BASS.length], when, BEAT * 1.5, "sine", 0.16);
    step += 1;
  };
  tick();
  townTimer = window.setInterval(tick, BEAT * 1000);
}

export function setMuted(next: boolean) {
  muted = next;
  if (!next) {
    context();
    startTown();
    play("coin");
  } else {
    stopTown();
  }
}

export function toggleMute() {
  setMuted(!muted);
  return muted;
}
