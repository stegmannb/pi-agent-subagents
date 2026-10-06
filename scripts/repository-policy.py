#!/usr/bin/env python3
"""Validate credentialless, exact-head Tier-1 PR CI with no Forgejo releases."""

import json
import re
from pathlib import Path

import yaml


class PolicyError(RuntimeError):
    pass


class UniqueLoader(yaml.SafeLoader):
    pass


def mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise PolicyError(f"Duplicate workflow key: {key}")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)


def validate(root):
    declaration = json.loads((root / ".forgejo/tier1.json").read_text())
    if declaration["tier"] != 1 or declaration["releaseProfile"] != "none":
        raise PolicyError("Tier 1 with release profile none is required")
    if not declaration["requiredChecks"] or not declaration["reviewDate"]:
        raise PolicyError("Required checks and review date must be declared")
    if (root / "CODEOWNERS").read_text() != declaration["codeowners"]:
        raise PolicyError("Reviewer ownership must match the declared contract")
    paths = sorted((root / ".forgejo/workflows").glob("*.y*ml"))
    if [p.name for p in paths] != declaration["workflows"]:
        raise PolicyError("Active workflow inventory must match the contract")
    for path in paths:
        text = path.read_text()
        workflow = yaml.load(text, Loader=UniqueLoader)
        if workflow.get("on") not in ({"pull_request": None}, {"pull_request": {}}):
            raise PolicyError("Only unconditional pull_request CI is allowed")
        if workflow.get("permissions") != {"contents": "read"}:
            raise PolicyError("CI must use read-only contents permissions")
        if re.search(
            r"\bsecrets\b|contents:\s*write|packages:\s*write|\b(?:npm|pnpm)\s+publish\b|\bgit\s+tag\b",
            text,
        ):
            raise PolicyError("PR CI must not use secrets or publish artifacts")
        for job in workflow["jobs"].values():
            if job.get("continue-on-error"):
                raise PolicyError("Required jobs must fail closed")
            if "if" in job and job["if"] != "always()":
                raise PolicyError("Required jobs must run unconditionally")
            for step in job.get("steps", []):
                if step.get("continue-on-error"):
                    raise PolicyError("Required steps must fail closed")
                action = step.get("uses")
                if action and not re.search(r"@[0-9a-f]{40}$", action):
                    raise PolicyError("Every external action must use an immutable SHA")
                if action and "/checkout@" in action:
                    if (
                        step.get("with", {}).get("ref")
                        != "${{ github.event.pull_request.head.sha }}"
                    ):
                        raise PolicyError("Checkout must select the exact PR head")
                    if step["with"].get("persist-credentials") is not False:
                        raise PolicyError("Checkout must not persist credentials")
    package = json.loads((root / "package.json").read_text())
    for name in package["scripts"]:
        if name.startswith(("pre", "post")):
            raise PolicyError("Package lifecycle hooks are forbidden in verification")
    for folder in ("releases", "release-retries"):
        if (root / folder).exists():
            raise PolicyError("Forgejo release declarations are forbidden")


if __name__ == "__main__":
    validate(Path(__file__).resolve().parents[1])
    print("Forgejo Tier-1 PR/no-release policy passed")
