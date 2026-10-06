# IronRDP

Upstream: https://github.com/Devolutions/IronRDP

Prototype source revision: `2c08bda7c5f9ad490e01f123b3be5521cf3c6e9d`.

IronRDP is available under MIT OR Apache-2.0. The original license texts
and copyright notices are retained in this directory. The plugin build includes
IronRDP Web components, WebAssembly, and a native bridge linked with IronRDP.

The generated package retains Rust and JavaScript dependency notices in
`third-party/dependencies/`, with versions and declared licenses in
`inventory.json`. This inventory also includes build dependencies; it is not
a claim that every listed package is linked into the runtime. Where published
archives omit license files, original texts from the exact source revision are
retained in `third-party/license-supplements/`; `sources.json` records their URLs.
The npm packages `is-reference` and `locate-character` publish their license
declarations in their README and package metadata, which are retained as supplied.
