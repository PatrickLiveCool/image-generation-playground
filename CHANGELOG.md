# Changelog

## [0.2.1](https://github.com/PatrickLiveCool/image-generation-playground/compare/v0.2.0...v0.2.1) (2026-10-27)


### Bug Fixes

* **release:** expose safe COS upload diagnostics ([#5](https://github.com/PatrickLiveCool/image-generation-playground/issues/5)) ([d3ac53f](https://github.com/PatrickLiveCool/image-generation-playground/commit/d3ac53f15ee3a68cb22b07660db6cc17698cc9ca))

## [0.2.0](https://github.com/PatrickLiveCool/image-generation-playground/compare/v0.1.0...v0.2.0) (2026-10-26)


### Features

* **infrastructure:** 建立图像应用发布、回退和恢复流程 ([8bf8f65](https://github.com/PatrickLiveCool/image-generation-playground/commit/8bf8f6501405d3998feacc60f6a8989a34606e63))


### Bug Fixes

* **ci:** accept manifest release branch dispatch ([#3](https://github.com/PatrickLiveCool/image-generation-playground/issues/3)) ([a7ca258](https://github.com/PatrickLiveCool/image-generation-playground/commit/a7ca2586009377a7942e18871b90f39e9fd30fb7))
* **ui:** restore image playground controls and persistence ([#4](https://github.com/PatrickLiveCool/image-generation-playground/issues/4)) ([d745fed](https://github.com/PatrickLiveCool/image-generation-playground/commit/d745fedb960896f2272242eeec741b87a0987060))

## 0.1.0 (2026-10-26)

Application baseline captured from commit `b0790ef270de110ed5a8ce1eb4d15058716ee939`.
This entry records the existing deployed application; it does not publish a GitHub Release.

- Configure a custom API endpoint and map model IDs to user-defined display names.
- Keep independent creations, drafts and version history, with the selected image as the next editing base.
- Store generated images and process records in private COS, without application-server image files.
- Preserve completed versions and drafts after failures, task switches and page refreshes.
