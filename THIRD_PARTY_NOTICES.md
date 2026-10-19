# External runtime and licensing

This repository contains the viewer extension and its Python adapter. It does not
bundle NVIDIA OVRTX, OVStage, OpenUSD, NumPy, Pillow, GPU drivers, or scene assets.
Users install those dependencies separately under their respective terms.

NVIDIA OVRTX and OVStage are proprietary runtime dependencies. Their public APIs
are used by the adapter; using a public API does not make the SDK open source or
grant redistribution rights to the SDK binaries. See the
[OVRTX documentation and license links](https://nvidia-omniverse.github.io/ovrtx/)
and the notices in the runtime packages you install.

Other externally installed packages include
[OpenUSD](https://github.com/PixarAnimationStudios/OpenUSD),
[NumPy](https://numpy.org/doc/stable/license.html), and
[Pillow](https://pillow.readthedocs.io/en/stable/about.html#license).

The extension manifest retains `UNLICENSED`. No open-source license or corporate
publication approval is granted by this repository. A source/package scan can
identify bundled files and suspicious strings; it cannot determine employment
ownership, contractual restrictions, or permission to publish.
