# Documentation and cleanup policy

Current service guidance belongs in [commerce-docs](../../README.md). Shared setup, testing, deployment and recovery belong in `platform/`. Link to each subject's owner instead of copying its instructions. Keep asset provenance, licenses, contract notes and deployment entry points next to the files they describe.

## Documentation standard

- Use one descriptive level-one heading. Organize sections with level-two headings and do not skip heading levels.
- Begin with the document's purpose and scope. Keep setup steps, operational procedures, reference material and historical results distinguishable.
- Name guides with lowercase hyphenated filenames; use `README.md` for folder indexes. Link each maintained guide from its owning index.
- Use relative Markdown links with descriptive labels. Avoid workstation-specific paths for repository files; label remote host paths and temporary evidence paths explicitly.
- Put commands in fenced blocks with a language such as `sh`, `python`, `sql`, `json` or `text`. State the working directory and prerequisites. Distinguish inspection commands from changes to data or deployments.
- Use placeholders for credentials and installation-specific values. Document where configuration comes from rather than copying private settings.
- Use ISO dates (`YYYY-MM-DD`) for recorded checks and release evidence. Describe what was verified and its limits; a local test result is not production acceptance.
- End files with one newline. Avoid trailing whitespace except intentional Markdown hard breaks. Preserve code examples and legal/license text.
- Update generated documentation through its owning generator. Do not hand-edit generated inventories or contracts.

Keep current service guides in their owning section. Put dated implementation and release reports in the owner's `history/`, with a historical notice and links to current operational procedures. [AI release history](../../ai-service/history/README.md) and [mobile documentation](../../mobile/README.md) provide the corresponding entry points. Preserve unique results and recovery context when removing superseded instructions.

## Plans and document ownership

Use `plans/README.md` to index each owner's active plans. A plan begins with its purpose, responsible team, status and ISO review date, then describes remaining work, acceptance criteria and links to evidence. Use `proposed`, `active`, `blocked`, `complete` or `superseded` for plan status; record an actual blocking condition when using `blocked`. A study is a proposal until adopted.

Track implementation, local verification, deployment and production acceptance separately. Completing source changes does not complete the other stages. Reconcile the current checklist when a milestone closes; move its detailed narrative to dated history and link to that record. Keep reusable release gates in operational runbooks instead of repeating an unchecked copy in every completed plan.

Current guides explain present behavior and procedures. Historical records preserve the candidate, date, environment, failures and limits of a particular run. Correct a historical error with an explicit note rather than silently changing its reported measurements. Source-derived API counts and inventories belong to their generators; prose should link to generated data.

When moving a guide, update repository incoming links and preserve useful old heading destinations. Temporary compatibility stubs must include `<!-- documentation-redirect -->`, identify the canonical destination and contain no competing current procedure. Keep contribution instructions, contract notes, licenses and deployment entry points beside their code. Every canonical guide and nested index must be linked from its nearest owning `README.md`; compatibility stubs are checked for valid links but need not clutter the current index.

## Validation

From the repository root:

```sh
python3 commerce-ops/scripts/checks/check-documentation.py
python3 -m unittest discover -s commerce-ops/scripts/tests -p test_documentation.py
python3 -m unittest discover -s commerce-ops/scripts/tests -p test_output_inventory.py
```

The checker validates maintained documentation links, Markdown heading anchors, guide structure and owning indexes. Coverage includes mobile specs and the explicitly listed mobile/automation entry points. Source-adjacent provenance, agent instructions, platform standards and font licenses retain their formats but their links are checked. Generated workspaces, dependencies and historical evidence copies under `commerce-output` and `commerce-artifacts` are excluded. CI runs portable checks and their regression suites.

Maintained Markdown must not link directly into `commerce-output`, `commerce-artifacts` or `.local/`, even when those targets exist on one workstation. Link to the [evidence catalog](../evidence/README.md) and retain the exact historical payload path as inline code. The catalog contains metadata, not credentials or raw customer data. Default checks validate catalog structure without requiring local payloads. On the workstation holding the evidence, also run:

```sh
python3 commerce-ops/scripts/checks/check-documentation.py --check-local-evidence
```

## File cleanup

- Remove a superseded guide after moving useful content to its current owner and updating incoming links.
- Run `python3 commerce-ops/scripts/checks/check-documentation.py`; CI checks maintained Markdown and the checker's regression tests.
- Before removing code, check imports, dynamic loading, command entry points, generated contracts, fixtures and operational callers. A `legacy` name alone does not establish dead code.
- Preserve applied database migrations and compatibility needed by existing records or installations.
- Keep credentials, database state and unique evidence in their protected locations. `.local`, `commerce-artifacts` and `commerce-output` are not disposable solely because of their names.
- Remove regenerable build output only when its jobs are idle; keep installed environments unless deliberately rebuilding them.
- Keep generated output out of source control. Next.js caches and website static exports are ignored, alongside existing dependency/build caches.

## Retained evidence

Logs, manifests and archives describe their recorded candidates and environments. They do not establish current release readiness; use [testing and verification](../operations/testing.md).

Create each new run in `commerce-output/YYYY-MM-DD-purpose/` with `manifest.json`, `evidence/`, `deliverables/` and `work/`. From the repository root, run `python3 commerce-ops/scripts/maintenance/new-output-run.py PURPOSE` to create this structure. Fill in the manifest's owner, exact candidate identity and verification details before treating its results as evidence. Legacy scripts with hard-coded output paths require their inputs to be regenerated or their output destinations updated before reuse.

The run owner records purpose, exact source/candidate identity (including a patch hash when dirty), commands, environment, status, verification limits, retained file hashes, dependencies, consumers, archive location and retention decision. Replace template placeholders before treating a manifest as evidence. `files` entries record relative paths, byte sizes and SHA-256 hashes. `depends_on` and `consumed_by` identify run paths or maintained scripts. Use `active`, `complete`, `failed` or `superseded` for run status. Retention is `retain`, `archive` or `regenerable`; an empty archive location means no durable copy is registered. Do not infer completion or deletion eligibility from an old date or filename.

Inventory metadata without reading file contents or changing outputs, from the repository root:

```sh
python3 commerce-ops/scripts/maintenance/inventory-outputs.py > /tmp/commerce-output-inventory.json
```

The inventory reports logical file bytes, skipped symlinks, top-level metadata candidates and nested output directories. It is a snapshot; active jobs can change during scanning. It does not detect every semantic dependency or choose deletion candidates. Inspect source and run references before changing a path. Snapshot builders should use reviewed source allowlists and exclude nested outputs unless deliberately declared as inputs.

Preserve active runs and unclassified evidence by default. Before cleanup, confirm jobs are idle, identify downstream consumers, archive unique inputs/results to an approved durable location, record archive hashes and verify restoration. Remove only explicitly classified regenerable work after those checks. Reusable operational scripts belong under maintained `commerce-ops/scripts` with explicit inputs; dated output scripts remain historical candidate evidence. On 2026-10-14, the user explicitly requested an empty `commerce-output`; its former local-only attachments were removed without a registered archive. The [historical evidence catalog](../evidence/README.md) records their unavailable status and former hashes.

Earlier cleanup inventories remain under `.local`. The 2–3 October cleanup consolidated service guides, retired Quality tooling, and compressed completed shopping evaluation streams to `results.jsonl.gz` with decompression/hash checks. Evaluation readers support those compressed streams. Source/media/database archives and protected settings were retained.

The 9 October documentation cleanup merged the obsolete local-session guide into local setup and consolidated overview, readiness and historical-source stubs into the root overview and testing guide. Operational release instructions defer to the current language release and shared AI database runbooks.
