# Daybreak Model Visibility

`daybreak-model-visibility` is an optional compatibility feature for accounts
whose model catalog reports the legacy standalone
`gpt-daybreak-blue-latest` model as visible while omitting Daybreak access
program metadata.

The feature admits that one model through the desktop catalog allowlist only
for ChatGPT-authenticated sessions and retains it in the model picker only
when the server marks it explicitly non-hidden. It leaves all other model
visibility decisions unchanged. Existing picker availability checks still
apply, including the server-provided access-program metadata and disabled
reason shown for an incompatible selection.

The feature does not grant Daybreak access, change the Daybreak toggle, alter
submission validation, or modify model-transition rules. Authentication and
authorization remain owned by the upstream service.

Enable it in the local, gitignored feature configuration:

```json
{
  "enabled": ["daybreak-model-visibility"]
}
```

Rebuild and reinstall after enabling it with `make install-native`.

Validate the feature with:

```bash
node --test linux-features/daybreak-model-visibility/test.js
```
