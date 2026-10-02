# Runtime notices

The `node-v22.17.1` directory archives the complete upstream Node LICENSE,
including embedded third-party notices, and its official release checksums.
`provenance.json` identifies sources and observed SHA256 values. The build
checks these files and the Node binary before staging; it does not contact the
network during packaging. This is an HTTPS checksum comparison, not validation
of the signed release manifest or a security suitability assessment.

The runtime also includes `node_modules/undici/LICENSE` from the locked installed
dependency. Its version is checked against the lockfile; the local package has
not yet been independently reconstructed from the registry tarball integrity.

The application still needs a complete inventory of frontend/Rust dependencies
and their notices, review of the Node release used for distribution, and Windows
installer verification. The manifest therefore remains `distributable: false`.
Do not interpret this archive as legal clearance or approval to release.
