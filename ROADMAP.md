# Roadmap

Open, living plan — ordered by expected user impact. PRs welcome on any item.

## v0.2.x — recall quality & trust

- [ ] **GUI memory browser**（记忆浏览器）：per-store inventory / search / delete in the settings card — requires a clean host→browser channel (investigate `dsh-api-remotes` custom contribution vs settings-section snapshot) 
- [ ] Adapter regression tests for the embedding toggle path (mock model, verify stores rebuild on settings change)
- [ ] Export/import a store as JSON (backup + migration)
- [ ] `memory_maintain history` output rendered as a readable version diff

## v0.3.x — semantic memory

- [ ] Optional real-embedding model behind a service interface (`@xenova/transformers` bge-small-zh-v1.5 already wired as `embedding: auto`) — model quantization / fallback benchmark
- [ ] Cross-session "project memory" namespaces (beyond boolean shared store)
- [ ] Episodic time decay that prefers recency without deleting old versions

## v0.4.x — ecosystem

- [ ] English README + docs parity (guide currently zh-CN only)
- [ ] Koishi-style plugin metadata for community catalogs once DSH has one
- [ ] CI publish workflow (auto `npm publish` on version tags)

## Done

- [x] 0.1.0 — engine + adapter dual package, tools/GUIDANCE/digest/GUI card, per-session SQLite stores
- [x] 0.1.1 — npm keywords/repository discoverability; public GitHub repo
- [x] 0.1.2 — explainable `memory_verify` (`closest`), `memory_maintain list`, optional local embedding model (setting), configurable recall threshold, adapter test suite (28 total)
