# Explicit legacy import fixtures

These schema-10 files document the supported one-time conversion of an existing
installation. They are not startup configuration. Fresh installations use
`../server.example.json` and configure environments, backends, and targets in
Settings.

Stop Sedes and retain your original configuration and database backup. Import
once with explicit workspace grants (repeat `--workspace-roots` for more roots):

```sh
env -u NODE_ENV npm run configuration:import -- \
  --file /absolute/legacy-server.json \
  --workspace-roots /absolute/workspace-root \
  --state-directory /absolute/sedes-state
```

`--validate-only` validates without opening the database or starting providers.
A pre-schema-10 database also requires `--quiescent-cutover-confirmed`, confirming
the former server stopped with idle Pi owners and empty in-memory queues.
The command backs up an existing database before schema upgrades.

The import keeps definition identifiers and thread associations and never
deletes provider stores. If the previous default target is not enabled after
import, select a new default in Settings.

Replace the startup file with the schema-11 bootstrap example after successful
import. Repeating an identical import preserves database edits; a different
source or an existing Settings configuration conflicts rather than overwriting
it. Never run an old binary against the upgraded database.
