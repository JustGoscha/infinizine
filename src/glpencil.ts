// Pencil strokes on the GPU. A committed pencil stroke is thousands of rotated, scaled,
// translucent nib stamps; Canvas 2D draws them one by one on the CPU (≈200 ms for a long
// stroke on a laptop, far more on an iPad), which stalled panning whenever a page full of
// pencil scrolled into view. Here every stamp is one instance of a textured quad, drawn in
// a single call, then copied into an ordinary canvas for the tiles. The nib textures are
// the 2D renderer's own nib canvases, so committed strokes look like the live ones.
// Falls back (returns null) when WebGL 2 isn't there or the context is lost.

const VS = `#version 300 es
layout(location = 0) in vec2 corner;
layout(location = 1) in vec4 stamp;   // x, y, radius (raster px), rotation
layout(location = 2) in vec2 look;    // alpha, nib layer
uniform vec2 size;    // the block being drawn, raster px
uniform vec2 origin;  // its top-left in the raster
out vec2 uv;
flat out float layer;
out float alpha;
void main() {
  float c = cos(stamp.w), s = sin(stamp.w);
  vec2 p = stamp.xy + mat2(c, s, -s, c) * (corner * stamp.z) - origin;
  gl_Position = vec4(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, 0.0, 1.0);
  uv = corner * 0.5 + 0.5;
  layer = look.y;
  alpha = look.x;
}`;

const FS = `#version 300 es
precision mediump float;
precision mediump sampler2DArray;
uniform sampler2DArray nibs;
in vec2 uv;
flat in float layer;
in float alpha;
out vec4 color;
void main() { color = texture(nibs, vec3(uv, layer)) * alpha; }`;

const NIB = 64;
const BLOCK = 1024; // the GL canvas: strokes bigger than this are drawn block by block
/** floats per stamp: x, y, radius, rotation, alpha, layer */
export const STAMP_FLOATS = 6;

export class GLPencil {
  private canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private sizeLoc: WebGLUniformLocation;
  private originLoc: WebGLUniformLocation;
  private stamps: WebGLBuffer;
  private textures = new Map<string, WebGLTexture>(); // per colour: its 16 nibs (8 grain, 8 dense)
  private lost = false;

  static create(): GLPencil | null {
    try {
      return new GLPencil();
    } catch {
      return null;
    }
  }

  private constructor() {
    // small and lean: a fixed 4 MB drawing buffer, no depth/stencil (iOS counts all of it against the page)
    this.canvas.width = this.canvas.height = BLOCK;
    const gl = this.canvas.getContext('webgl2', {
      premultipliedAlpha: true, alpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('no webgl2');
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    const shader = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    this.prog = prog;
    this.sizeLoc = gl.getUniformLocation(prog, 'size')!;
    this.originLoc = gl.getUniformLocation(prog, 'origin')!;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.stamps = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stamps);
    const stride = STAMP_FLOATS * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog, 'nibs'), 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied source-over, like Canvas 2D
  }

  get ok(): boolean { return !this.lost && !this.gl.isContextLost(); }

  private nibTexture(color: string, nibs: HTMLCanvasElement[]): WebGLTexture {
    let tex = this.textures.get(color);
    if (tex) return tex;
    const gl = this.gl;
    tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA, NIB, NIB, nibs.length, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    nibs.forEach((n, i) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, NIB, NIB, 1, gl.RGBA, gl.UNSIGNED_BYTE, n));
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY); // nibs are mostly drawn far smaller than 64 px
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(color, tex);
    return tex;
  }

  /** Draw `count` stamps (STAMP_FLOATS each, in `target`'s pixels) and composite them over
   * `target`'s top-left w×h (≤ BLOCK) — source-over is associative, so this equals stamping
   * them into it one by one. False if the GPU path failed (nothing drawn). */
  stampInto(target: CanvasRenderingContext2D, w: number, h: number, color: string, nibs: HTMLCanvasElement[], data: Float32Array, count: number): boolean {
    if (!this.ok || w > BLOCK || h > BLOCK) return false;
    const { gl, canvas } = this;
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.nibTexture(color, nibs));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stamps);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * STAMP_FLOATS), gl.STREAM_DRAW);
    gl.viewport(0, BLOCK - h, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, BLOCK - h, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.sizeLoc, w, h);
    gl.uniform2f(this.originLoc, 0, 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.disable(gl.SCISSOR_TEST);
    if (gl.isContextLost()) return false;
    target.save();
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = 1;
    target.globalCompositeOperation = 'source-over';
    target.drawImage(canvas, 0, 0, w, h, 0, 0, w, h); // same task as the draw: the buffer is still there
    target.restore();
    return true;
  }

  /** Draw `count` stamps (STAMP_FLOATS each, in raster px) into a new w×h canvas.
   * `nibs`: the colour's 16 nib canvases (layer = index). Null if the GPU path failed. */
  render(w: number, h: number, color: string, nibs: HTMLCanvasElement[], data: Float32Array, count: number): HTMLCanvasElement | null {
    if (!this.ok) return null;
    const { gl, canvas } = this;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const g = out.getContext('2d');
    if (!g) return null;
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.nibTexture(color, nibs));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.stamps);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, count * STAMP_FLOATS), gl.STREAM_DRAW);
    gl.clearColor(0, 0, 0, 0);
    for (let by = 0; by < h; by += BLOCK) {
      for (let bx = 0; bx < w; bx += BLOCK) {
        const bw = Math.min(BLOCK, w - bx), bh = Math.min(BLOCK, h - by);
        // the block sits in the canvas's top-left corner (GL's y runs up)
        gl.viewport(0, BLOCK - bh, bw, bh);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, BLOCK - bh, bw, bh);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform2f(this.sizeLoc, bw, bh);
        gl.uniform2f(this.originLoc, bx, by);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
        gl.disable(gl.SCISSOR_TEST);
        if (gl.isContextLost()) return null;
        g.drawImage(canvas, 0, 0, bw, bh, bx, by, bw, bh); // same task as the draw: the buffer is still there
      }
    }
    return out;
  }
}
