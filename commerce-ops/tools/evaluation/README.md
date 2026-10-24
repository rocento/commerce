# Evaluation

Assistant, planning, language, discovery, and performance evaluation scripts live here. Choose the evaluation for the behavior under review and read its arguments before running; some scripts need a live service or local fixtures.

For supported command examples, see the [command reference](../../../commerce-docs/platform/reference/scripts.md). Keep output and evidence outside the source tree where the command requires it.

## Layout

Commands live directly in this folder. Importable support packages stay beside
them: [shopping_eval](shopping_eval/README.md) owns shopping corpora and worker
plumbing; [recommendation_eval](recommendation_eval/README.md) owns the retained
fixed-corpus recommendation pipeline. Snake-case package names preserve Python
imports. Application runtimes and retained report artifacts keep their existing
owners. Old package locations are compatibility links, not additional owners.
