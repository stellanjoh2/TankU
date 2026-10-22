"""Merge every animation in a .glb into one clip (Blender's exporter writes one per object action).

    python3 merge_glb_animations.py in.glb [out.glb] [name]
"""
import json
import struct
import sys


def merge(src, dst=None, name="Loop"):
    data = open(src, "rb").read()
    json_len = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20:20 + json_len])
    rest = data[20 + json_len:]

    channels, samplers = [], []
    for anim in gltf.get("animations", []):
        base = len(samplers)
        samplers += anim["samplers"]
        for ch in anim["channels"]:
            channels.append(dict(ch, sampler=ch["sampler"] + base))
    gltf["animations"] = [{"name": name, "channels": channels, "samplers": samplers}]

    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    body = struct.pack("<II", len(js), 0x4E4F534A) + js + rest
    out = struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body
    open(dst or src, "wb").write(out)
    return len(channels)


if __name__ == "__main__":
    a = sys.argv[1:]
    print("merged channels:", merge(a[0], a[1] if len(a) > 1 else None, a[2] if len(a) > 2 else "Loop"))
