# Runtime notices

Dependency metadata and the first security check are recorded in
[the 2026-10-08 review](review-2026-10-08.md) and its
[lockfile-bound inventory](dependency-inventory-2026-10-08.json).
The inventory is not a complete notices bundle or release clearance.
It is the pre-upgrade snapshot. See the
[candidate dependency update](dependency-update-2026-10-08.md) for the later
lockfile hash, versions and regression evidence.

The `node-v22.23.3` directory archives the complete upstream Node LICENSE,
including embedded third-party notices, and its official release checksums.
`provenance.json` identifies sources and observed SHA256 values. The build
checks these files and the Node binary before staging; it does not contact the
network during packaging. The downloaded EXE also had a valid Windows
Authenticode signature from OpenJS Foundation when checked on 2026-10-08.
The packer enforces hashes, not Authenticode. This is not validation of the
signed release manifest or a complete security suitability assessment.
The older `node-v22.17.1` archive is retained for historical provenance only.

The runtime also includes `node_modules/undici/LICENSE` from the locked installed
dependency. Its version is checked against the lockfile; the local package has
not yet been independently reconstructed from the registry tarball integrity.

The application still needs a complete inventory of frontend/Rust dependencies
and their notices, review of the Node release used for distribution, and Windows
installer verification. The manifest therefore remains `distributable: false`.
Do not interpret this archive as legal clearance or approval to release.
