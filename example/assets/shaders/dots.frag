#version 460 core
#include <flutter/runtime_effect.glsl>

uniform vec2 uSize;   // surface size (width, height)
uniform float uSeed;   // time seed
uniform vec4 uColor;  // base color (rgb) and alpha multiplier

out vec4 fragColor;

// compute fractal pattern for angle t
float f_(float t) {
    float ff = fract(t / 8.0) * 4.0 - 2.0;
    return abs(smoothstep(0.0, 0.5, fract(ff) - 0.25) + floor(ff)) - 1.0;
}

// compute distance accumulation field at point p
float dist_field(vec2 p) {
    float d = 0.0;
    float t = -uSeed;
    for(float i = 0.0; i < 7.0; i += 1.0) {
        float a = 3.14159265 / 20.0 * i * 2.0 + t * 2.0;
        d += 1.0 / length(p + vec2(f_(a), 0.0));
    }
    return d;
}

void main() {
    // normalize to [-1,1] based on resolution
    vec2 uv = (gl_FragCoord.xy / uSize) * 2.0 - 1.0;

    // apply fixed aspect ratio 3:1 (width:height)
    uv.x *= 3.0;

    // zoom in pattern by scaling UV down
    float zoom = 0.4;
    uv *= zoom;

    // evaluate distance field and offset
    float d = dist_field(uv) / 3.0 - 10.0;

    // clamp intensity to [0,1]
    float intensity = clamp(d, 0.0, 1.0);

    // set color and alpha for transparent background
    fragColor = vec4(uColor.rgb * intensity, intensity * uColor.a);
}
