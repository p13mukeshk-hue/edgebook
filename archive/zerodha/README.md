# Edge Book Zerodha retirement archive

The live Edge Book Zerodha integration is retired as part of the Firebase-to-VPS
migration. Its last untouched repository state is preserved by the lightweight Git
tag:

`edgebook-pre-vps-migration-2026-08-08` (`3fde920`)

The tag is the code archive. Keeping a second executable copy of the integration in
the deployed tree would preserve vulnerable webhook and trade-pairing code and make
accidental reactivation more likely.

## Archived implementation locations

- `app.html`: live connection, callback, sync, reconciliation, repair and settings UI.
- `functions/index.js`: Kite client, OAuth callback, postback, trade/history sync,
  reconciliation and scheduled jobs.
- `functions/package.json`: `kiteconnect` dependency.
- `firebase.json`: `/zerodha-callback` hosting rewrite.

Retrieve an archived file without changing the working tree with, for example:

```sh
git show edgebook-pre-vps-migration-2026-08-08:functions/index.js
```

## Data-retention contract

Retiring the integration must not delete or rewrite historical Zerodha data.

- Preserve Firestore document IDs and stored trade IDs.
- Preserve broker/source metadata, account mappings, timestamps, lot sizes,
  grouping mode, P&L, review state, annotations, tags and screenshots.
- Render retained records as `Zerodha · Historical`.
- Mark an unresolved open record as `Legacy open — no longer synchronized`.
- Keep CSV recognition separate from live broker sync by using
  `sourceSystem: "zerodha"` and `ingestionMethod: "csv"` for future imports.
- Never migrate or expose Zerodha access tokens. Revoke them when the live
  integration is disabled.

The independent DeltaLens Zerodha services on the VPS are outside Edge Book and
must not be modified by this retirement.
