const SOURCE_WIDTH = 160;
const SOURCE_HEIGHT = 144;

const DISPLAY_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
out vec2 vUv;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  // Emulator frame buffers begin at the top-left; WebGL frame buffers begin
  // at the bottom-left. Flip only the final presentation pass.
  vUv = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
}
`;

const NATIVE_VERTEX_SHADER = `#version 300 es
in vec2 aPosition;
out vec2 vUv;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  vUv = aPosition * 0.5 + 0.5;
}
`;

const PERSISTENCE_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uCurrentFrame;
uniform sampler2D uPreviousFrame;
uniform float uGhostStrength;
uniform bool uGhostEnabled;
uniform bool uResetHistory;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec3 current = texture(uCurrentFrame, vUv).rgb;
  vec3 previous = texture(uPreviousFrame, vUv).rgb;
  float currentLuma = dot(current, vec3(0.2126, 0.7152, 0.0722));
  float previousLuma = dot(previous, vec3(0.2126, 0.7152, 0.0722));
  // Reflective LCD crystals clear a little faster than they darken. Keeping
  // this pass at native resolution makes persistence independent of zoom.
  float directionResponse = currentLuma < previousLuma ? 1.0 : 0.72;
  float persistence = uGhostEnabled && !uResetHistory
    ? uGhostStrength * directionResponse
    : 0.0;
  fragColor = vec4(mix(current, previous, persistence), 1.0);
}
`;

const LCD_FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uFrame;
uniform vec2 uSourceSize;
uniform vec2 uOutputSize;
uniform int uDisplayModel;
uniform bool uLcdEnabled;
uniform float uDmgContrast;

in vec2 vUv;
out vec4 fragColor;

vec3 fetchNative(ivec2 coordinate) {
  ivec2 limit = ivec2(uSourceSize) - ivec2(1);
  return texelFetch(uFrame, clamp(coordinate, ivec2(0), limit), 0).rgb;
}

const float PI = 3.14159265358979323846;

// Exact box-filtered coverage of a periodic sin² aperture. Unlike smoothstep
// evaluated at a fragment center, this integrates the full area represented by
// the output pixel, so a boundary never becomes darker merely because it
// straddles two device pixels.
float sineSquaredIntegral(float position) {
  return position * 0.5 - sin(2.0 * PI * position) / (4.0 * PI);
}

float averageSineSquared(float center, float footprint) {
  float width = max(footprint, 0.00001);
  return (
    sineSquaredIntegral(center + width * 0.5)
    - sineSquaredIntegral(center - width * 0.5)
  ) / width;
}

// Integral of one rectangular band repeated every "period". This is the
// analytic equivalent of multisampling the GBC subpixel stripes.
float periodicBandIntegral(float position, float period, float start, float end) {
  float cycle = floor(position / period);
  float withinCycle = position - cycle * period;
  return cycle * (end - start) + clamp(withinCycle - start, 0.0, end - start);
}

float averagePeriodicBand(
  float center,
  float footprint,
  float period,
  float start,
  float end
) {
  float width = max(footprint, 0.00001);
  return (
    periodicBandIntegral(center + width * 0.5, period, start, end)
    - periodicBandIntegral(center - width * 0.5, period, start, end)
  ) / width;
}

vec3 renderDmg(vec3 signal, vec2 nativePosition, vec2 footprint) {
  // DMG-01 is a reflective dot matrix, not a modern square-pixel panel.
  // Two separable sin² transmission curves form a soft, rounded pixel dot.
  // Their box-filtered product has identical area at every fractional scale.
  vec2 dotAxis = vec2(
    averageSineSquared(nativePosition.x, footprint.x),
    averageSineSquared(nativePosition.y, footprint.y)
  );
  float aperture = 0.14 + 0.86 * dotAxis.x * dotAxis.y;
  vec3 substrate = vec3(0.650, 0.720, 0.455);
  vec3 gap = mix(substrate, signal, 0.16) * 0.95;
  vec3 dot = signal * 0.955;
  vec3 panelColor = mix(gap, dot, aperture);
  vec3 contrastPivot = vec3(0.650, 0.720, 0.455);
  return clamp(
    (panelColor - contrastPivot) * uDmgContrast + contrastPivot,
    0.0,
    1.0
  );
}

vec3 renderCgb(vec3 signal, vec2 nativePosition, vec2 footprint) {
  // The GBC panel has a much tighter fill factor and vertical RGB subpixels.
  // Each band and row opening is integrated analytically, preventing alternating
  // one/two-pixel stripes when the panel is resized to a fractional multiple.
  vec3 activeStripe = vec3(
    averagePeriodicBand(nativePosition.x, footprint.x, 1.0, 0.030, 0.320),
    averagePeriodicBand(nativePosition.x, footprint.x, 1.0, 0.345, 0.655),
    averagePeriodicBand(nativePosition.x, footprint.x, 1.0, 0.680, 0.970)
  );
  float rowCoverage = averagePeriodicBand(
    nativePosition.y,
    footprint.y,
    1.0,
    0.045,
    0.955
  );
  float columnCoverage = clamp(
    activeStripe.r + activeStripe.g + activeStripe.b,
    0.0,
    1.0
  );
  float aperture = columnCoverage * rowCoverage;
  vec3 subpixelMask = vec3(0.76) + activeStripe * 0.42;
  vec3 panelGap = signal * 0.62;
  return mix(panelGap, signal * subpixelMask, aperture);
}

void main() {
  vec2 nativePosition = clamp(
    vUv * uSourceSize,
    vec2(0.0),
    uSourceSize - vec2(0.0001)
  );
  ivec2 nativePixel = ivec2(floor(nativePosition));
  vec2 footprint = max(
    uSourceSize / max(uOutputSize, vec2(1.0)),
    vec2(0.00001)
  );

  vec3 center = fetchNative(nativePixel);
  if (!uLcdEnabled) {
    vec3 sharpColor = uDisplayModel == 0
      ? clamp(
          (center - vec3(0.650, 0.720, 0.455)) * uDmgContrast
            + vec3(0.650, 0.720, 0.455),
          0.0,
          1.0
        )
      : center;
    fragColor = vec4(sharpColor, 1.0);
    return;
  }

  vec3 horizontal = (
    fetchNative(nativePixel + ivec2(-1, 0))
    + fetchNative(nativePixel + ivec2(1, 0))
  ) * 0.5;
  vec3 vertical = (
    fetchNative(nativePixel + ivec2(0, -1))
    + fetchNative(nativePixel + ivec2(0, 1))
  ) * 0.5;
  float leakage = uDisplayModel == 0 ? 0.055 : 0.075;

  // Work in approximately linear light so leakage and subpixel masks do not
  // create the dark halos produced by sRGB-space averaging.
  vec3 linearCenter = pow(center, vec3(2.2));
  vec3 linearNeighbors = pow(mix(horizontal, vertical, 0.34), vec3(2.2));
  vec3 signal = pow(
    mix(linearCenter, linearNeighbors, leakage),
    vec3(1.0 / 2.2)
  );

  vec3 color = uDisplayModel == 0
    ? renderDmg(signal, nativePosition, footprint)
    : renderCgb(signal, nativePosition, footprint);
  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Unknown WebGL shader error";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Unknown WebGL link error";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function createTexture(gl, data = null) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    SOURCE_WIDTH,
    SOURCE_HEIGHT,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    data,
  );
  return texture;
}

function bindQuad(gl, buffer, location) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
}

export class LCDShaderRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.model = "dmg";
    this.lcdEnabled = true;
    this.ghostEnabled = true;
    this.ghostStrength = 0.42;
    this.dmgContrast = 1.12;
    this.resetHistory = true;
    this.hasFrame = false;
    this.historyIndex = 0;
    this.lastFrame = null;
    this.disposed = false;
    this.displaySyncFrame = null;
    this.displaySyncUntil = 0;

    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    this.gl = gl;
    if (!gl) {
      this.fallback = canvas.getContext("2d", { alpha: false });
      canvas.dataset.lcdRenderer = "2d-fallback";
      return;
    }

    this.persistenceProgram = createProgram(
      gl,
      NATIVE_VERTEX_SHADER,
      PERSISTENCE_FRAGMENT_SHADER,
    );
    this.displayProgram = createProgram(gl, DISPLAY_VERTEX_SHADER, LCD_FRAGMENT_SHADER);
    // Shader reflection is static. Resolve locations once instead of asking
    // the driver to look them up again for every emulated frame.
    this.persistenceLocations = {
      position: gl.getAttribLocation(this.persistenceProgram, "aPosition"),
      currentFrame: gl.getUniformLocation(this.persistenceProgram, "uCurrentFrame"),
      previousFrame: gl.getUniformLocation(this.persistenceProgram, "uPreviousFrame"),
      ghostStrength: gl.getUniformLocation(this.persistenceProgram, "uGhostStrength"),
      ghostEnabled: gl.getUniformLocation(this.persistenceProgram, "uGhostEnabled"),
      resetHistory: gl.getUniformLocation(this.persistenceProgram, "uResetHistory"),
    };
    this.displayLocations = {
      position: gl.getAttribLocation(this.displayProgram, "aPosition"),
      frame: gl.getUniformLocation(this.displayProgram, "uFrame"),
      sourceSize: gl.getUniformLocation(this.displayProgram, "uSourceSize"),
      outputSize: gl.getUniformLocation(this.displayProgram, "uOutputSize"),
      displayModel: gl.getUniformLocation(this.displayProgram, "uDisplayModel"),
      lcdEnabled: gl.getUniformLocation(this.displayProgram, "uLcdEnabled"),
      dmgContrast: gl.getUniformLocation(this.displayProgram, "uDmgContrast"),
    };
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    this.currentTexture = createTexture(gl);
    this.historyTextures = [createTexture(gl), createTexture(gl)];
    this.framebuffer = gl.createFramebuffer();
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    canvas.dataset.lcdRenderer = "webgl2";
    canvas.dataset.shaderPipeline =
      "native-persistence,dmg-analytic-dot-matrix,cgb-analytic-rgb-stripe";
    canvas.dataset.sourceResolution = `${SOURCE_WIDTH}x${SOURCE_HEIGHT}`;

    this.resizeObserver = typeof window.ResizeObserver === "undefined"
      ? null
      : new window.ResizeObserver(() => this.resizeAndRender());
    this.resizeObserver?.observe(canvas);
    this.resizeAndRender();
  }

  setOptions({ model, lcdEnabled, ghostEnabled, ghostStrength, dmgContrast = 1.12 }) {
    const persistenceChanged = this.ghostEnabled !== ghostEnabled;
    this.model = model;
    this.lcdEnabled = lcdEnabled;
    this.ghostEnabled = ghostEnabled;
    this.ghostStrength = Math.max(0, Math.min(0.92, ghostStrength));
    this.dmgContrast = Math.max(0.7, Math.min(1.6, dmgContrast));
    if (persistenceChanged) this.resetHistory = true;
    this.canvas.dataset.displayModel = model;
    this.canvas.dataset.lcdMode = lcdEnabled ? "lcd" : "sharp";
    this.canvas.dataset.ghosting = ghostEnabled ? "on" : "off";
    this.render();
  }

  resetPersistence() {
    this.resetHistory = true;
  }

  uploadFrame(frame, { resetHistory = false } = {}) {
    if (this.disposed || !frame) return;
    this.lastFrame = frame;
    if (!this.gl) {
      this.presentFallback(frame);
      return;
    }
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.currentTexture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      SOURCE_WIDTH,
      SOURCE_HEIGHT,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      frame,
    );
    this.hasFrame = true;
    if (resetHistory) this.resetHistory = true;
    this.updatePersistence();
    this.render();
  }

  updatePersistence() {
    const gl = this.gl;
    if (!gl || !this.hasFrame) return;
    const nextIndex = 1 - this.historyIndex;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.historyTextures[nextIndex],
      0,
    );
    gl.viewport(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);
    gl.useProgram(this.persistenceProgram);
    bindQuad(gl, this.quad, this.persistenceLocations.position);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.currentTexture);
    gl.uniform1i(this.persistenceLocations.currentFrame, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.historyTextures[this.historyIndex]);
    gl.uniform1i(this.persistenceLocations.previousFrame, 1);
    gl.uniform1f(
      this.persistenceLocations.ghostStrength,
      this.ghostStrength,
    );
    gl.uniform1i(
      this.persistenceLocations.ghostEnabled,
      this.ghostEnabled ? 1 : 0,
    );
    gl.uniform1i(
      this.persistenceLocations.resetHistory,
      this.resetHistory ? 1 : 0,
    );
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.historyIndex = nextIndex;
    this.resetHistory = false;
  }

  resizeToDisplayBounds() {
    if (this.disposed) return;
    const bounds = this.canvas.getBoundingClientRect();
    const density = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(bounds.width * density));
    const height = Math.max(1, Math.round(bounds.height * density));
    const changed = this.canvas.width !== width || this.canvas.height !== height;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.canvas.dataset.outputResolution = `${width}x${height}`;
    if (changed) this.render();
  }

  resizeAndRender() {
    if (this.disposed) return;
    this.resizeToDisplayBounds();
    this.render();

    // CSS transforms do not notify ResizeObserver. The shell deliberately
    // animates scale and position when the options drawer or manual zoom
    // changes, so keep the WebGL drawing buffer locked to its *displayed*
    // device-pixel bounds for the complete 180/220 ms UI transition. Without
    // this short sync window, the final canvas can retain the old raster size
    // and the LCD grid is resampled into alternating thick/thin rows.
    this.displaySyncUntil = Math.max(
      this.displaySyncUntil,
      window.performance.now() + 300,
    );
    if (this.displaySyncFrame !== null) return;

    const syncDisplaySize = (time) => {
      this.displaySyncFrame = null;
      if (this.disposed) return;
      this.resizeToDisplayBounds();
      if (time < this.displaySyncUntil) {
        this.displaySyncFrame = window.requestAnimationFrame(syncDisplaySize);
      }
    };
    this.displaySyncFrame = window.requestAnimationFrame(syncDisplaySize);
  }

  render() {
    const gl = this.gl;
    if (!gl || !this.hasFrame || this.disposed) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.displayProgram);
    bindQuad(gl, this.quad, this.displayLocations.position);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.historyTextures[this.historyIndex]);
    gl.uniform1i(this.displayLocations.frame, 0);
    gl.uniform2f(
      this.displayLocations.sourceSize,
      SOURCE_WIDTH,
      SOURCE_HEIGHT,
    );
    gl.uniform2f(
      this.displayLocations.outputSize,
      this.canvas.width,
      this.canvas.height,
    );
    gl.uniform1i(
      this.displayLocations.displayModel,
      this.model === "cgb" ? 1 : 0,
    );
    gl.uniform1i(
      this.displayLocations.lcdEnabled,
      this.lcdEnabled ? 1 : 0,
    );
    gl.uniform1f(
      this.displayLocations.dmgContrast,
      this.dmgContrast,
    );
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  presentFallback(frame) {
    if (!this.fallback) return;
    if (this.canvas.width !== SOURCE_WIDTH) this.canvas.width = SOURCE_WIDTH;
    if (this.canvas.height !== SOURCE_HEIGHT) this.canvas.height = SOURCE_HEIGHT;
    this.fallback.putImageData(
      new ImageData(
        frame instanceof Uint8ClampedArray ? frame : new Uint8ClampedArray(frame),
        SOURCE_WIDTH,
        SOURCE_HEIGHT,
      ),
      0,
      0,
    );
  }

  dispose() {
    this.disposed = true;
    this.resizeObserver?.disconnect();
    if (this.displaySyncFrame !== null) {
      window.cancelAnimationFrame(this.displaySyncFrame);
      this.displaySyncFrame = null;
    }
    if (!this.gl) return;
    const gl = this.gl;
    gl.deleteTexture(this.currentTexture);
    for (const texture of this.historyTextures) gl.deleteTexture(texture);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteBuffer(this.quad);
    gl.deleteProgram(this.persistenceProgram);
    gl.deleteProgram(this.displayProgram);
  }
}
