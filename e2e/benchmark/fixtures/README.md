# Vendored upstream spec files

Fetched 2026-08-13 from `OSU-NLP-Group/Online-Mind2Web@main/data/schema_v2/`:

- `schema_v2.json` — the JSON Schema (draft 2020-12) the submission must satisfy.
  Reference material for `../validate.ts`, which implements it by hand rather
  than pulling in a schema validator.
- `example_v2.json` — upstream's own known-good submission, used as the golden
  fixture in `../v2.test.ts`. A validator that rejects it is wrong, and a writer
  whose grammar cannot reproduce it byte for byte is producing something else.

Note the upstream README links these as `schema.json` and `example.json`; both
of those 404. These are the real filenames.
