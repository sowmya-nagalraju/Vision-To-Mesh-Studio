// Dependency-free GLB -> OBJ / STL converter (triangle meshes only).
// Applies node transforms so the exported geometry matches what the viewer shows.

type Mat4 = number[]; // column-major, like glTF

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}

function trs(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = q as [number, number, number, number];
  const [sx, sy, sz] = s as [number, number, number];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    t[0]!, t[1]!, t[2]!, 1,
  ];
}

const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

interface Gltf {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; mode?: number }[] }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }[];
  bufferViews?: { byteOffset?: number; byteLength: number; byteStride?: number }[];
}

export interface TriMesh {
  positions: number[]; // x,y,z flat, already transformed
  indices: number[]; // triangle list
}

function parseGlb(buf: Buffer): { json: Gltf; bin: Buffer } {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error("Not a valid GLB file.");
  let offset = 12;
  let json: Gltf | null = null;
  let bin: Buffer = Buffer.alloc(0);
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8")) as Gltf;
    else if (type === 0x004e4942) bin = data;
    offset += 8 + len;
  }
  if (!json) throw new Error("GLB has no JSON chunk.");
  return { json, bin };
}

function readAccessor(gltf: Gltf, bin: Buffer, index: number): number[] {
  const acc = gltf.accessors![index]!;
  const n = TYPE_COUNT[acc.type]!;
  const size = COMPONENT_SIZE[acc.componentType]!;
  const view = gltf.bufferViews![acc.bufferView!]!;
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = view.byteStride ?? n * size;
  const out: number[] = new Array(acc.count * n);
  for (let i = 0; i < acc.count; i++) {
    for (let j = 0; j < n; j++) {
      const p = base + i * stride + j * size;
      let v: number;
      switch (acc.componentType) {
        case 5126: v = bin.readFloatLE(p); break;
        case 5125: v = bin.readUInt32LE(p); break;
        case 5123: v = bin.readUInt16LE(p); break;
        case 5121: v = bin.readUInt8(p); break;
        case 5122: v = bin.readInt16LE(p); break;
        default: v = bin.readInt8(p);
      }
      out[i * n + j] = v;
    }
  }
  return out;
}

export function glbToTriMesh(glb: Buffer): TriMesh {
  const { json: gltf, bin } = parseGlb(glb);
  const positions: number[] = [];
  const indices: number[] = [];

  const visit = (nodeIndex: number, parent: Mat4): void => {
    const node = gltf.nodes?.[nodeIndex];
    if (!node) return;
    const local = node.matrix ?? trs(node.translation, node.rotation, node.scale);
    const world = mul(parent, local);
    if (node.mesh !== undefined) {
      for (const prim of gltf.meshes?.[node.mesh]?.primitives ?? []) {
        if (prim.mode !== undefined && prim.mode !== 4) continue; // triangles only
        const posIdx = prim.attributes.POSITION;
        if (posIdx === undefined) continue;
        const pos = readAccessor(gltf, bin, posIdx);
        const base = positions.length / 3;
        for (let i = 0; i < pos.length; i += 3) {
          const x = pos[i]!, y = pos[i + 1]!, z = pos[i + 2]!;
          positions.push(
            world[0]! * x + world[4]! * y + world[8]! * z + world[12]!,
            world[1]! * x + world[5]! * y + world[9]! * z + world[13]!,
            world[2]! * x + world[6]! * y + world[10]! * z + world[14]!,
          );
        }
        const idx = prim.indices !== undefined
          ? readAccessor(gltf, bin, prim.indices)
          : Array.from({ length: pos.length / 3 }, (_, i) => i);
        for (let i = 0; i + 2 < idx.length; i += 3) {
          indices.push(base + idx[i]!, base + idx[i + 1]!, base + idx[i + 2]!);
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };

  const scene = gltf.scenes?.[gltf.scene ?? 0];
  const roots = scene?.nodes ?? gltf.nodes?.map((_, i) => i) ?? [];
  for (const r of roots) visit(r, IDENTITY);
  if (indices.length === 0) throw new Error("The model contains no triangle geometry to export.");
  return { positions, indices };
}

export function toObj(mesh: TriMesh): Buffer {
  const lines: string[] = ["# Exported by Vision2Mesh"];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    lines.push(`v ${mesh.positions[i]} ${mesh.positions[i + 1]} ${mesh.positions[i + 2]}`);
  }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    lines.push(`f ${mesh.indices[i]! + 1} ${mesh.indices[i + 1]! + 1} ${mesh.indices[i + 2]! + 1}`);
  }
  return Buffer.from(lines.join("\n") + "\n", "utf8");
}

export function toStl(mesh: TriMesh): Buffer {
  const triCount = mesh.indices.length / 3;
  const out = Buffer.alloc(84 + triCount * 50);
  out.write("Vision2Mesh binary STL", 0, "ascii");
  out.writeUInt32LE(triCount, 80);
  const p = mesh.positions;
  let o = 84;
  for (let t = 0; t < triCount; t++) {
    const a = mesh.indices[t * 3]! * 3, b = mesh.indices[t * 3 + 1]! * 3, c = mesh.indices[t * 3 + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const v of [nx, ny, nz, p[a]!, p[a + 1]!, p[a + 2]!, p[b]!, p[b + 1]!, p[b + 2]!, p[c]!, p[c + 1]!, p[c + 2]!]) {
      out.writeFloatLE(v, o);
      o += 4;
    }
    out.writeUInt16LE(0, o);
    o += 2;
  }
  return out;
}

/** Minimal OBJ -> GLB converter (for Spaces that only return .obj). Keeps per-vertex colors if present. */
export function objToGlb(obj: Buffer): Buffer {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  let hasColor = true;
  for (const line of obj.toString("utf8").split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p[0] === "v") {
      pos.push(Number(p[1]), Number(p[2]), Number(p[3]));
      if (p.length >= 7) col.push(Number(p[4]), Number(p[5]), Number(p[6]));
      else hasColor = false;
    } else if (p[0] === "f" && p.length >= 4) {
      const ids = p.slice(1).map((t) => {
        const n = parseInt(t.split("/")[0]!, 10);
        return n < 0 ? pos.length / 3 + n : n - 1;
      });
      for (let i = 1; i + 1 < ids.length; i++) idx.push(ids[0]!, ids[i]!, ids[i + 1]!);
    }
  }
  if (idx.length === 0 || pos.length === 0) throw new Error("The model file contains no geometry.");
  const useColor = hasColor && col.length === pos.length;

  const posBuf = Buffer.alloc(pos.length * 4);
  pos.forEach((v, i) => posBuf.writeFloatLE(v, i * 4));
  const colBuf = Buffer.alloc(useColor ? col.length * 4 : 0);
  if (useColor) col.forEach((v, i) => colBuf.writeFloatLE(Math.min(1, Math.max(0, v)), i * 4));
  const idxBuf = Buffer.alloc(idx.length * 4);
  idx.forEach((v, i) => idxBuf.writeUInt32LE(v, i * 4));

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let j = 0; j < 3; j++) {
    min[j] = Math.min(min[j]!, pos[i + j]!);
    max[j] = Math.max(max[j]!, pos[i + j]!);
  }

  const bin = Buffer.concat([posBuf, colBuf, idxBuf]);
  const views: object[] = [{ buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 }];
  const accessors: object[] = [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min, max }];
  const attributes: Record<string, number> = { POSITION: 0 };
  if (useColor) {
    views.push({ buffer: 0, byteOffset: posBuf.length, byteLength: colBuf.length, target: 34962 });
    accessors.push({ bufferView: 1, componentType: 5126, count: col.length / 3, type: "VEC3" });
    attributes["COLOR_0"] = 1;
  }
  views.push({ buffer: 0, byteOffset: posBuf.length + colBuf.length, byteLength: idxBuf.length, target: 34963 });
  accessors.push({ bufferView: views.length - 1, componentType: 5125, count: idx.length, type: "SCALAR" });

  const json = {
    asset: { version: "2.0", generator: "Vision2Mesh" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    materials: [{ pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
    meshes: [{ primitives: [{ attributes, indices: accessors.length - 1, material: 0, mode: 4 }] }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  let j = Buffer.from(JSON.stringify(json), "utf8");
  while (j.length % 4) j = Buffer.concat([j, Buffer.from(" ")]);
  const binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(j.length, 0); c1.writeUInt32LE(0x4e4f534a, 4);
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(binPad.length, 0); c2.writeUInt32LE(0x004e4942, 4);
  const out = Buffer.concat([header, c1, j, c2, binPad]);
  out.writeUInt32LE(out.length, 8);
  return out;
}
