# Architecture Overview

InkTrail separates reader concerns from translation operations.

```text
Reader UI -> Web API -> Domain services -> SQLite
                                  |-> source adapters
                                  |-> translation provider
                                  |-> job runner
                                  |-> EPUB builder
```

The user sees a focused reader and a restrained library. Source resolution,
translation, quality checks, terminology memory, and EPUB work are background
operations recorded in SQLite. Every operational record belongs to a novel,
which prevents data and terminology from crossing novel boundaries.

See the [approved product design](../specs/2026-10-11-inktrail-multi-novel-design.md)
for the complete flow and constraints.
