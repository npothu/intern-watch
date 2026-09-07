# Daily backups and recovery

The `backup` GitHub Actions workflow runs daily at 07:15 UTC and can also run manually.
Scheduled Actions can start late, so this is a recovery target rather than an exact-time guarantee.
It exports Convex tables and file storage, captures Convex environment variables, and encrypts the bundle before uploading it.
Only ciphertext is uploaded to GitHub.

The workflow keeps the newest seven successful backup artifacts.
It deletes older copies only after a new artifact has uploaded successfully.
Artifacts also have a 90-day expiry so an abandoned installation does not retain data indefinitely.
A failed export or upload leaves earlier backups intact.
Enable Actions failure notifications and investigate a missed daily backup.

## Configure

1. Store an RSA private recovery key in the operator's password manager.
2. Set the matching PEM public key in the code repository variable `BACKUP_PUBLIC_KEY`.
3. Provide a production `CONVEX_DEPLOY_KEY` with permission to export tables and storage and read environment variables.
4. Run the workflow manually, download its encrypted artifact, and complete the isolated restore drill below.

Keep the private key out of GitHub and Vercel.
The public encryption key can encrypt backups but cannot decrypt them.
Do not rotate or discard a recovery key while retained backups still depend on it.
A separate password-manager backup should protect the recovery key itself.

## Restore drill

1. Download a completed `convex-backup-*` artifact and extract its `.iwbackup` file.
2. Retrieve the exact matching private key into process memory from the password manager.
3. Call `decryptBackup` from `scripts/backup-crypto.mjs` with a new destination filename in a private temporary directory.
4. Only after decryption succeeds, extract the authenticated tar archive into that directory.
5. Inspect `manifest.json` and the source commit to identify compatible code.
6. Create an isolated Convex deployment, deploy the compatible schema and functions, and leave Gmail, Pub/Sub, SMTP, and model keys unset.
7. Import `snapshot.zip` with the Convex CLI, explicitly naming the isolated deployment.
8. Export the restored deployment with file storage and compare document IDs, ownership fields, references, and file hashes to the source snapshot.
9. Verify encrypted test credentials offline using the backed-up encryption key without contacting their providers.
10. Delete temporary plaintext files once the drill is complete.

Do not restore production mail or model environment values into a live test deployment.
The `convex.env.txt` file contains secrets and is for controlled production recovery or offline verification.
Restoring production data requires pausing external work, taking a fresh pre-restore snapshot, explicitly selecting the production deployment, and checking the restored data before resuming work.

## Coverage and limits

The encrypted bundle includes Convex tables, stored files, Convex environment variables, and a manifest with the workflow's source commit.
The manifest's commit identifies the backup tooling; confirm which application commit was deployed before restoring code.
Git preserves application code, the private data repository preserves watcher configuration and ledger history, and the password manager preserves recovery credentials.

Vercel settings, Clerk configuration, Google Cloud configuration, GitHub secrets, and scheduled Convex functions are not part of a Convex data export.
Keep the domain, identity, OAuth, webhook, and watcher setup procedures with the instance configuration.
After a real recovery, reconcile interrupted resume imports and builds and recreate required scheduled work.
An export is not proof of recovery until the isolated restore and file-integrity checks pass.

## Invalidate legacy resume URLs

The manual backup workflow has an optional `rotate_legacy_resume_links` input.
Use it after deploying the authenticated file routes to invalidate previously issued public storage URLs.
The operation runs only after a successful encrypted backup upload.
It replaces file IDs for at most ten legacy resume records per run and reports whether more remain.
Repeat while `remaining` is true.
The file bytes, versions, and owner references stay intact, and stable authenticated app URLs continue to work.
A concurrent rebuild wins over the migration; retry that row rather than overwriting it.
A restore of a pre-migration snapshot can revive legacy IDs, so repeat this operation after such a recovery.
