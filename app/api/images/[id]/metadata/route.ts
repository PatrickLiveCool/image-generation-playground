import { accountIdentity, recheckAccount } from "@/lib/auth/guards"
import { withTransaction } from "@/lib/database"
import { privateApiError, privateJson } from "@/lib/private-api"
import { createPrivateCosStore } from "@/lib/private-cos"
import { readVerifiedPrivateAsset } from "@/lib/private-generation"
import { validatePrivateImage } from "@/lib/private-image-validation"
import { readPrivateAsset } from "@/lib/private-workspace-service"

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const identity = await accountIdentity(request.headers)
    const asset = await readPrivateAsset(identity, (await context.params).id, "image")
    const { bytes } = await readVerifiedPrivateAsset(asset, createPrivateCosStore())
    const image = await validatePrivateImage(bytes)
    // The COS request and full decoder can outlive a session/account revocation.
    await withTransaction(client => recheckAccount(client, identity))
    return privateJson({ assetId: asset.id, width: image.width, height: image.height, orientation: image.orientation, pages: image.pages })
  } catch (error) { return privateApiError(error) }
}
