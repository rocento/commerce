# Legacy local script paths

Canonical workstation commands now live in [local/platform](../../local/platform/README.md)
and [local/preview](../../local/preview/README.md). The old paths in this folder
are temporary symlinks for callers that have not yet migrated. Use the new paths
in commands, CI, and documentation.

Host helpers now belong to their services: [assistant migration](../../services/assistant/conversations-setup.py)
and [rengine connection setup](../../services/rengine/configure-rengine-connections.py).
This folder contains compatibility paths only. Retain them until historical and
installed callers have migrated; managed uploads package the service owners.
