"""Camera validation and view transforms, independent of the GPU runtime."""
import math


LIMITS = {"yaw": (-180, 180, 30), "elevation": (-89.9, 89.9, 30),
          "zoom": (.3, 4, 1), "pan_x": (-2, 2, 0), "pan_y": (-2, 2, 0)}


def parse_camera(query, scene):
    values = {}
    for key, (low, high, default) in LIMITS.items():
        value = float(query.get(key, [default])[0])
        if not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f"{key} must be finite and between {low} and {high}")
        values[key] = value
    focus = query.get("focus", [""])[0]
    if focus and focus not in scene.get("focuses", {}):
        raise ValueError("Unknown geometry focus")
    values["focus"] = focus
    return values


def camera_matrix(scene, yaw=30, elevation=30, zoom=1, focus="", pan_x=0, pan_y=0):
    """Row-vector camera transform; pan is in units of the focused bound distance."""
    yaw, elevation = math.radians(yaw), math.radians(elevation)
    target = scene.get("focuses", {}).get(focus, scene)
    z = [math.sin(yaw) * math.cos(elevation), math.cos(yaw) * math.cos(elevation), math.sin(elevation)]
    up = [0, 0, 1]
    if scene.get("camera_up_axis") == "Y":
        z, up = ([v[0], v[2], -v[1]] for v in (z, up))
    x = [up[1]*z[2]-up[2]*z[1], up[2]*z[0]-up[0]*z[2], up[0]*z[1]-up[1]*z[0]]
    length = math.sqrt(sum(v*v for v in x))
    x = [v / length for v in x]
    y = [z[1]*x[2]-z[2]*x[1], z[2]*x[0]-z[0]*x[2], z[0]*x[1]-z[1]*x[0]]
    distance = target["distance"] / zoom
    eye = [target["center"][i] + distance*(z[i] + pan_x*x[i] + pan_y*y[i]) for i in range(3)]
    return [x + [0], y + [0], z + [0], eye + [1]]
