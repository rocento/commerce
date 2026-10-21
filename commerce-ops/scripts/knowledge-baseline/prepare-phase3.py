"""Reproduce the initial domain artifact from reviewed primary-source notes."""

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))
from app.commerce_action_engine.actions.domain_evidence.contracts import DomainPack

OUT = ROOT / "output/enterprise-knowledge-phase3-20261010"
LOCK = "ab99f9a475ceff2fd9de0cf8666aae20d365dfb766378f104dd7a5f42d8c4e97"
assert (
    hashlib.sha256((OUT / "validation-expectations.json").read_bytes()).hexdigest()
    == LOCK
)
review = {
    "reviewed_at": "2026-10-10T00:00:00Z",
    "recheck_at": "2026-11-09T00:00:00Z",
    "review_method": "ai_assisted",
    "reviewer": "phase3-primary-source-review",
    "state": "reviewed",
}
sources = []
for key, filename, url, title in [
    (
        "shotcut-faq-20261010",
        "shotcut-review.md",
        "https://shotcut.org/FAQ/",
        "Shotcut FAQ: minimum system requirements",
    ),
    (
        "zoom-desktop-20261010",
        "zoom-review.md",
        "https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060748",
        "Zoom desktop system requirements",
    ),
]:
    sources.append(
        dict(
            id=key,
            url=url,
            title=title,
            document_ref=f"sources/{filename}",
            document_sha256=hashlib.sha256(
                (OUT / "sources" / filename).read_bytes()
            ).hexdigest(),
            **review,
        )
    )


def requirement(source, attribute, label, operator, value, unit=None):
    return {
        "id": attribute,
        "attribute": attribute,
        "label": label,
        "operator": operator,
        "value": value,
        "unit": unit,
        "source_ids": [source],
    }


profiles = []
for workload, cores, ram in (("sd", 1, 4), ("hd", 4, 8), ("4k", 8, 16)):
    source = "shotcut-faq-20261010"
    fields = [
        ("operating_system", "Operating system", "eq", "Windows 11", None),
        ("os_bits", "OS architecture", "eq", 64, "bits"),
        ("cpu_architecture", "CPU architecture", "one_of", ["x86_64", "arm64"], None),
        ("cpu_cores", "CPU cores", "gte", cores, "cores"),
        ("ram", "RAM", "gte", ram, "GB"),
        ("direct3d_11", "Direct3D 11 support", "eq", True, None),
        ("storage_present", "Storage included", "eq", True, None),
    ]
    if workload == "sd":
        fields.append(("cpu_clock", "CPU clock", "gte", 2, "GHz"))
    profiles.append(
        dict(
            id=f"shotcut-windows11-{workload}",
            domain="electronics",
            activity_values=["video_editing"],
            product_terms=["laptop", "laptops", "notebook", "notebooks"],
            label=f"Shotcut on Windows 11: {workload.upper()}, CPU processing",
            conditions=[
                "Shotcut desktop version covered by the reviewed FAQ",
                "Windows 11, 64-bit",
                f"{workload.upper()} editing",
                "CPU processing; GPU effects excluded",
            ],
            limitations="Checks documented hardware minima only. Codec support, project storage capacity, effects and editing speed remain unverified. Near-minimum systems may need proxy and preview scaling.",
            requirements=[requirement(source, *f) for f in fields],
            **review,
        )
    )
source = "zoom-desktop-20261010"
profiles.append(
    dict(
        id="zoom-windows11-basic-video",
        domain="electronics",
        activity_values=["online_classes", "video_calls"],
        product_terms=["laptop", "laptops", "notebook", "notebooks"],
        label="Zoom on Windows 11: basic video classes, included camera/audio",
        conditions=[
            "Zoom desktop, 64-bit",
            "Windows 11",
            "Basic video classes",
            "Camera, microphone and speakers included in the product",
        ],
        limitations="Checks the selected hardware profile only. Your internet connection, school software, managed-device permissions, advanced features and call quality remain unverified. Screen sharing can be slow on low-core-count laptops.",
        requirements=[
            requirement(source, *f)
            for f in [
                ("operating_system", "Operating system", "eq", "Windows 11", None),
                ("os_bits", "OS architecture", "eq", 64, "bits"),
                ("cpu_cores", "CPU cores", "gte", 2, "cores"),
                ("cpu_clock", "CPU clock", "gte", 2, "GHz"),
                ("ram", "RAM", "gte", 4, "GB"),
                ("camera_included", "Camera included", "eq", True, None),
                ("microphone_included", "Microphone included", "eq", True, None),
                ("speakers_included", "Speakers included", "eq", True, None),
            ]
        ],
        **review,
    )
)
pack = DomainPack.model_validate(
    {
        "executor": "domain-evidence-v1",
        "revision": 1,
        "language": "en",
        "sources": sources,
        "profiles": profiles,
    }
)
target = ROOT / "commerce-assistant-platform/data/domain-evidence/electronics-v1.json"
target.write_text(json.dumps(pack.model_dump(mode="json"), indent=2) + "\n")
(OUT / "candidate.json").write_bytes(target.read_bytes())
print(
    json.dumps(
        {
            "fingerprint": pack.fingerprint,
            "profiles": len(pack.profiles),
            "sources": len(pack.sources),
            "expectations_sha256": LOCK,
        }
    )
)
