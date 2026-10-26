# Changelog

## 0.1.0 (2026-10-26)

Application baseline captured from commit `b0790ef270de110ed5a8ce1eb4d15058716ee939`.
This entry records the existing deployed application; it does not publish a GitHub Release.

- Configure a custom API endpoint and map model IDs to user-defined display names.
- Keep independent creations, drafts and version history, with the selected image as the next editing base.
- Store generated images and process records in private COS, without application-server image files.
- Preserve completed versions and drafts after failures, task switches and page refreshes.
