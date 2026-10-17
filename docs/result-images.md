# Codex result images

The conversation projection exposes explicit PNG and JPEG results as paired image assets. It reads only these snapshot fields:

- `imageGeneration.savedPath`, or `imageGeneration.result` when there is no saved path.
- `dynamicToolCall.contentItems` entries with `type: inputImage` and `imageUrl`.
- `functionCallOutput.output` entries with `type: input_image` and `image_url`.
- Markdown image destinations in assistant message text, outside fenced and inline code.

Ordinary links, code examples, unrelated tool output, HTML image tags, and arbitrary URLs do not trigger a read. The service never fetches a URL. Inline data images remain usable for remote hosts; remote filesystem paths return `remote_file_unsupported`.

## Local file boundary

On the local host, a saved file must resolve inside the conversation's real `cwd` or `CODEX_HOME/generated_images/<threadId>`. The service resolves symlinks before checking containment, rejects unsupported file types, and opens only regular files. It does not infer a path from a missing `cwd`, read relative paths, or follow a path from a remote host.

Only PNG and JPEG are accepted. Each image is limited to 10 MiB, each message to four result images and 24 MiB total. Images beyond the four-item cap are counted in `omittedAttachmentCount`. An unavailable image retains a placeholder and one of `remote_file_unsupported`, `outside_workspace`, `unsupported_source`, `invalid_image`, `image_too_large`, `image_missing`, `snapshot_unavailable`, or `total_size_exceeded`.

## Snapshot pinning and privacy

After a successful read, the paired asset is stored through the conversation asset store and a private manifest is written under `dataDir/result-images/`. Its digest is scoped to host, thread, message, source slot, and display name. Refreshes and restarts reuse the manifest; they do not reread a changed file or changed inline bytes for that same result slot. A different host, thread, message, or source slot gets an independent snapshot.

The manifest stores the asset reference and byte metadata, not the source URL, filesystem path, or base64. Conversation responses contain the paired asset route, availability, and safe display metadata; Markdown image destinations and inline image data are removed from assistant response text. The asset route remains protected by pairing and host/thread checks.

## Checks

Run the TypeScript build and targeted/full MCP tests from the repository root:

```sh
npm run build
npm test
```

The targeted result image coverage is `tests/result-images.mjs`; integrated history projection coverage is in `tests/conversations.mjs`.
