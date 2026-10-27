# Changelog

## [0.2.6](https://github.com/PatrickLiveCool/image-generation-playground/compare/v0.2.5...v0.2.6) (2026-10-27)


### Bug Fixes

* **release:** bound COS transfers and retain part failures ([#15](https://github.com/PatrickLiveCool/image-generation-playground/issues/15)) ([4cf203e](https://github.com/PatrickLiveCool/image-generation-playground/commit/4cf203e72f6ad97d3d99a4f804aef190f062d88a))
* **release:** verify COS paths and isolate accelerated transfers ([#17](https://github.com/PatrickLiveCool/image-generation-playground/issues/17)) ([73e815d](https://github.com/PatrickLiveCool/image-generation-playground/commit/73e815d5fd4733f82a587b8b02dee1f5cb2d874d))

## [0.2.5](https://github.com/PatrickLiveCool/image-generation-playground/compare/v0.2.4...v0.2.5) (2026-10-27)


### Bug Fixes

* **release:** scope multipart listing at bucket level ([#13](https://github.com/PatrickLiveCool/image-generation-playground/issues/13)) ([6b0bedb](https://github.com/PatrickLiveCool/image-generation-playground/commit/6b0bedb392080e357773c7bade67753cdbf52304))

## [0.2.4](https://github.com/PatrickLiveCool/image-generation-playground/compare/v0.2.3...v0.2.4) (2026-10-27)


### Bug Fixes

* **release:** grant COS multipart upload actions ([#11](https://github.com/PatrickLiveCool/image-generation-playground/issues/11)) ([a019eb1](https://github.com/PatrickLiveCool/image-generation-playground/commit/a019eb1446ee241766cd9cdb3e04d1757a336e51))

## [0.2.3](https://github.com/PatrickLiveCool/image-generation-playground/compare/v0.2.2...v0.2.3) (2026-10-27)


### Bug Fixes

* **release:** use resumable COS upload for bundle files ([#9](https://github.com/PatrickLiveCool/image-generation-playground/issues/9)) ([cb00c9d](https://github.com/PatrickLiveCool/image-generation-playground/commit/cb00c9d7382faae335a2f823c56ff9fc1e77c39a))

## [0.2.2](https://github.com/PatrickLiveCool/image-generation-playground/compare/v0.2.1...v0.2.2) (2026-10-27)


### Bug Fixes

* **release:** send COS content length as text ([#7](https://github.com/PatrickLiveCool/image-generation-playground/issues/7)) ([422cf69](https://github.com/PatrickLiveCool/image-generation-playground/commit/422cf69733137700432e637aed83b7fcc50a48d9))

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
