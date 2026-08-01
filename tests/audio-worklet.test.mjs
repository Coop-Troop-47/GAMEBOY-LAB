import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadProcessor() {
  const source = readFileSync(
    new URL("../app/Emulator.jsx", import.meta.url),
    "utf8",
  );
  const match = source.match(/const AUDIO_WORKLET_SOURCE = `([\s\S]*?)`;\n/);
  assert.ok(match, "embedded AudioWorklet source is present");
  let Processor = null;
  class MockAudioWorkletProcessor {
    constructor() {
      this.port = {
        messages: [],
        onmessage: null,
        postMessage: (message) => this.port.messages.push(message),
      };
    }
  }
  vm.runInNewContext(match[1], {
    AudioWorkletProcessor: MockAudioWorkletProcessor,
    Float32Array,
    Math,
    registerProcessor: (name, constructor) => {
      assert.equal(name, "gbc-lab-audio");
      Processor = constructor;
    },
  });
  assert.ok(Processor);
  return new Processor();
}

function makeStereo(frames, phase = 0) {
  const samples = new Float32Array(frames * 2);
  for (let index = 0; index < frames; index += 1) {
    const value = Math.sin((index + phase) * Math.PI / 16) * 0.5;
    samples[index * 2] = value;
    samples[index * 2 + 1] = -value;
  }
  return samples;
}

test("host filter uses the measured DMG and GBC capacitor curves", () => {
  const source = readFileSync(
    new URL("../app/Emulator.jsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /model === "cgb" \? 0\.998943 : 0\.999958/);
  assert.match(source, /audioHighPassCoefficient\([\s\S]*modelRef\.current/);
});

test("audio worklet starts cleanly and corrects queue drift without deleting samples", () => {
  const processor = loadProcessor();
  processor.port.onmessage({
    data: {
      type: "settings",
      target: 256,
      maximum: 1024,
      gain: 1,
      filter: false,
      filterCoefficient: 0.99634,
    },
  });
  const initial = makeStereo(512);
  processor.port.onmessage({
    data: { type: "samples", buffer: initial.buffer },
  });

  const left = new Float32Array(128);
  const right = new Float32Array(128);
  assert.equal(processor.process([], [[left, right]]), true);
  assert.equal(processor.started, true);
  assert.equal(processor.underruns, 0);
  assert.ok(left.some((sample) => sample !== 0));
  assert.ok(right.some((sample) => sample !== 0));
  assert.ok(processor.playbackRate >= 0.9975 && processor.playbackRate <= 1.0025);

  for (let callback = 0; callback < 12; callback += 1) {
    const refill = makeStereo(128, callback * 128);
    processor.port.onmessage({
      data: { type: "samples", buffer: refill.buffer },
    });
    processor.process([], [[left, right]]);
  }
  assert.equal(processor.underruns, 0);
  assert.equal(processor.overruns, 0);
});

test("audio worklet bounds excessive latency and resets every queue state", () => {
  const processor = loadProcessor();
  processor.port.onmessage({
    data: {
      type: "settings",
      target: 128,
      maximum: 640,
      gain: 0.7,
      filter: true,
      filterCoefficient: 0.99634,
    },
  });
  const excessive = makeStereo(1200);
  processor.port.onmessage({
    data: { type: "samples", buffer: excessive.buffer },
  });
  assert.equal(processor.buffered, 640);
  assert.equal(processor.overruns, 1);

  processor.port.onmessage({ data: { type: "reset" } });
  assert.equal(processor.buffered, 0);
  assert.equal(processor.started, false);
  assert.equal(processor.playbackPhase, 0);
  assert.equal(processor.playbackRate, 1);
  assert.equal(processor.tail, 0);
  assert.equal(processor.underruns, 0);
  assert.equal(processor.overruns, 0);
});

test("balanced worklet follows the exact Game Boy frame cadence without drift", () => {
  const processor = loadProcessor();
  const sampleRate = 48000;
  const hardwareRate = 4194304 / 70224;
  processor.port.onmessage({
    data: {
      type: "settings",
      target: 1280,
      maximum: 3328,
      gain: 1,
      filter: false,
      filterCoefficient: 0.99634,
    },
  });

  const left = new Float32Array(128);
  const right = new Float32Array(128);
  let frameSamplePhase = 0;
  let nextFrame = 1 / hardwareRate;
  let nextCallback = 128 / sampleRate;
  let queueTotal = 0;
  let queueSamples = 0;
  const duration = 30;
  while (Math.min(nextFrame, nextCallback) <= duration) {
    if (nextFrame <= nextCallback) {
      frameSamplePhase += sampleRate / hardwareRate;
      const frames = Math.floor(frameSamplePhase);
      frameSamplePhase -= frames;
      const samples = makeStereo(frames);
      processor.port.onmessage({
        data: { type: "samples", buffer: samples.buffer },
      });
      nextFrame += 1 / hardwareRate;
    } else {
      processor.process([], [[left, right]]);
      if (nextCallback > 2) {
        queueTotal += processor.buffered;
        queueSamples += 1;
      }
      nextCallback += 128 / sampleRate;
    }
  }

  assert.equal(processor.underruns, 0);
  assert.equal(processor.overruns, 0);
  const averageQueue = queueTotal / queueSamples;
  assert.ok(
    processor.buffered > 600 && processor.buffered < 1800,
    `unexpected final queue depth: ${processor.buffered}`,
  );
  assert.ok(
    averageQueue > 1000 && averageQueue < 1500,
    `unexpected average queue depth: ${averageQueue}`,
  );
  assert.ok(processor.playbackRate >= 0.9975 && processor.playbackRate <= 1.0025);
});
