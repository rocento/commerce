"""The same native streaming fixture must satisfy the gateway-owned public API."""
import json
from pathlib import Path
import unittest
import jsonschema

ROOT = Path(__file__).resolve().parents[3]


def json_schema(value):
    if isinstance(value, list):
        return [json_schema(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = {key: json_schema(item) for key, item in value.items() if key != "nullable"}
    if value.get("nullable") and isinstance(result.get("type"), str):
        result["type"] = [result["type"], "null"]
    return result


class NativeAssistantContractTests(unittest.TestCase):
    def test_shared_events_and_input_match_existing_public_api(self):
        api = json_schema(json.loads((ROOT / "commerce-api/rocento-api/openapi.json").read_text()))
        fixture = json.loads((ROOT / "commerce-mobile-apps/shared/testing/assistant-stream.json").read_text())
        def validate(name, value):
            schema = {"$ref": "#/components/schemas/" + name, "components": api["components"]}
            jsonschema.Draft7Validator(schema, format_checker=jsonschema.FormatChecker()).validate(value)
        validate("AssistantChatInput", {"request_id": fixture["request_id"], "conversation_id": fixture["conversation_id"], "message": "Show apples"})
        for event in fixture["events"]:
            validate("AssistantEvent", event)
        self.assertEqual([event["sequence"] for event in fixture["events"]], list(range(len(fixture["events"]))))
        self.assertEqual(fixture["events"][-1]["type"], "done")
        source = ROOT / "commerce-mobile-apps/shared/testing/assistant-stream.json"
        for destination in ["ios/RocentoCore/Tests/RocentoCoreTests/Resources", "android/core/src/test/resources", "android/app/src/androidTest/assets"]:
            self.assertEqual(source.read_bytes(), (ROOT / "commerce-mobile-apps" / destination / source.name).read_bytes())


if __name__ == "__main__":
    unittest.main()
