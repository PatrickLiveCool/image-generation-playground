import assert from "node:assert/strict"
import { test } from "node:test"
import { aspectRatiosForModel, ALL_ASPECT_RATIO_VALUES } from "../components/image-combiner/model-catalog"

test("任意合法模型名称不能读取对象原型而破坏全局目录", () => {
  for (const id of ["constructor", "toString", "__proto__", "synthetic-model"]) {
    assert.deepEqual([...aspectRatiosForModel(id)], [...ALL_ASPECT_RATIO_VALUES])
  }
  assert.deepEqual(aspectRatiosForModel("openai/gpt-image-1.5"), ["square", "3:2", "2:3"])
})
