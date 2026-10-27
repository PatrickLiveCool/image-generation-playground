import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("image_release_setup", pathlib.Path(__file__).parents[1] / "setup.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def test_roles_cannot_cross_into_runtime_images_or_each_others_write_permissions(self):
        policies = setup.policies("qintopia-image-1305166808", "ap-shanghai")
        multipart = set(setup.MULTIPART_ACTIONS)
        multipart_bucket = set(setup.MULTIPART_BUCKET_ACTIONS)
        for role, document in policies.items():
            actions = {a for s in document["statement"] for a in s["action"]}
            self.assertEqual("name/cos:PutObject" in actions, role == "upload")
            self.assertEqual(multipart <= actions, role == "upload")
            self.assertEqual(bool(multipart & actions), role == "upload")
            if role == "upload":
                listing = next(s for s in document["statement"] if multipart_bucket <= set(s["action"]))
                self.assertEqual(listing["resource"], ["qcs::cos:ap-shanghai:uid/1305166808:qintopia-image-1305166808/*"])
                self.assertEqual(listing["condition"]["string_like"]["cos:prefix"], ["qintopia-image%2Freleases%2F*"])
            self.assertEqual("name/cos:DeleteObject" in actions, role == "retention")
            for statement in document["statement"]:
                if any(a in ["name/cos:GetObject", "name/cos:HeadObject", "name/cos:PutObject", "name/cos:DeleteObject", *setup.MULTIPART_OBJECT_ACTIONS] for a in statement["action"]):
                    self.assertTrue(all("/qintopia-image/releases/*/" in resource for resource in statement["resource"]))
                self.assertNotIn("image-playground", str(statement))

    def test_list_is_prefix_bound_and_setup_rejects_resource_injection(self):
        for document in setup.policies("qintopia-image-1305166808", "ap-shanghai").values():
            listing = next(s for s in document["statement"] if "name/cos:GetBucket" in s["action"])
            self.assertEqual(listing["condition"]["string_like"]["cos:prefix"], ["qintopia-image%2Freleases%2F*"])
        for bucket, region in [("*", "ap-shanghai"), ("bucket-12345", "*"), ("bucket-12345/elsewhere", "ap-shanghai")]:
            with self.assertRaises(ValueError):
                setup.policies(bucket, region)
